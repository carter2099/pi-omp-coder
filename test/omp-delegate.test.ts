import { test, expect, describe, mock } from "bun:test";
import { EventEmitter } from "node:events";
import os from "os";
import fs from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SpawnResult } from "../extensions/omp-delegate.ts";

// ── Module-level spawn state ──
// Shared state across all tests in this module; each test must reset.

interface SpawnScriptEntry {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number | null;
  error?: Error;
  killed?: boolean;
  /** If true, never emit close/error — simulates a hung process (used for kill/timeout tests). */
  hang?: boolean;
}

let spawnScripts: SpawnScriptEntry[] = [];
let spawnCalls: Array<{
  command: string;
  args: string[];
  options: Record<string, unknown>;
}> = [];
let spawnIdx = 0;

// ── Fake child process factory ──

function createFakeChild(
  entry: SpawnScriptEntry,
): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    // Emit 'exit' then 'close' so spawnWithStreaming's exit/close handlers fire.
    // This mimics the real Node lifecycle when a process is killed.
    setImmediate(() => {
      child.emit("exit", null);
      child.emit("close", null);
    });
  };

  // Emit stdout chunks via setImmediate
  if (entry.stdoutChunks) {
    for (const chunk of entry.stdoutChunks) {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(chunk));
      });
    }
  }

  // Emit stderr chunks via setImmediate
  if (entry.stderrChunks) {
    for (const chunk of entry.stderrChunks) {
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from(chunk));
      });
    }
  }

  // Emit close or error via setImmediate (unless hang mode prevents it)
  if (entry.hang) {
    // Never emit close/error — simulates a hung process (used for kill/timeout tests).
  } else if (entry.error) {
    setImmediate(() => child.emit("error", entry.error!));
  } else if (entry.killed) {
    // Pre-killed: set flag before emitting close
    setImmediate(() => {
      child.killed = true;
      child.emit("close", entry.exitCode ?? null);
    });
  } else {
    setImmediate(() => child.emit("close", entry.exitCode ?? null));
  }

  return child;
}

// ── Mocks (must be set up BEFORE dynamic import) ──
// Must use dynamic import for the extension because mock.module("node:child_process")
// needs to be registered before the extension module loads and caches the spawn binding.


mock.module("node:child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    const entry = spawnScripts[spawnIdx++] ?? { exitCode: 0, stdoutChunks: [] };
    spawnCalls.push({ command, args, options });
    return createFakeChild(entry);
  },
}));

const { default: ompCoderExtension } = await import(
  "../extensions/omp-delegate.ts"
);

// ── Types ──

interface ExecuteParams {
  prompt: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  timeout_seconds?: number;
}

interface ExecuteResult {
  content: { type: string; text: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details: Record<string, any>;
}

interface ToolHandle {
  execute(
    toolCallId: string,
    params: ExecuteParams,
    signal: AbortSignal | undefined,
    onUpdate: ((update: Record<string, unknown>) => void) | undefined,
    ctx: { cwd: string },
  ): Promise<ExecuteResult>;
}

// ── makePi (simplified — no execImpl) ──

function makePi(): { pi: ExtensionAPI; tool: ToolHandle } {
  let capturedTool: unknown;
  const pi = {
    registerTool(tool: unknown) {
      capturedTool = tool;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    get tool(): ToolHandle {
      return capturedTool as ToolHandle;
    },
  };
}

const signal = undefined;
const defaultCtx = { cwd: "/test/session-cwd" };

// ── Tests ──

describe("omp-delegate", () => {
  // ── 1. Registration ──
  test("registration", () => {
    let captured: Record<string, unknown> = {};
    const pi = {
      registerTool(def: Record<string, unknown>) {
        captured = def;
      },
    } as unknown as ExtensionAPI;
    ompCoderExtension(pi);

    expect(captured.name).toBe("delegate_omp");
    expect(captured.label).toBe("Delegate to OMP");
    expect(typeof captured.description).toBe("string");
    expect((captured.description as string).length).toBeGreaterThan(0);
    expect(typeof captured.promptSnippet).toBe("string");
    expect((captured.promptSnippet as string).length).toBeGreaterThan(0);
    expect(Array.isArray(captured.promptGuidelines)).toBe(true);
    expect((captured.promptGuidelines as string[]).length).toBeGreaterThan(0);
    for (const g of captured.promptGuidelines as string[]) {
      expect(typeof g).toBe("string");
      expect(g.length).toBeGreaterThan(0);
    }

    const params = captured.parameters as Record<string, unknown>;
    const props = (params.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([
      "cwd",
      "model",
      "prompt",
      "thinking",
      "timeout_seconds",
    ]);
    const required = params.required as string[];
    expect(required).toEqual(["prompt"]);
  });

  // ── 2. Success with output ──
  test("success with output", async () => {
    spawnScripts = [{ stdoutChunks: ["  hello world  "], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "hello" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(result.content[0].text).toBe("hello world");
    expect(result.details).toEqual({
      exitCode: 0,
      status: "ok",
      outputLength: 11,
    });
    expect(spawnCalls.length).toBe(1);
  });

  // ── 3. Success empty output ──
  test("success empty output", async () => {
    spawnScripts = [{ stdoutChunks: ["   "], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "empty" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(result.content[0].text).toBe("(OMP agent produced no output)");
    expect(result.details).toEqual({
      exitCode: 0,
      status: "ok",
      outputLength: 0,
    });
  });

  // ── 4. Killed ──
  test("killed", async () => {
    spawnScripts = [
      { stdoutChunks: ["partial"], exitCode: null, killed: true },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "kill" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(result.content[0].text).toContain("OMP agent was killed");
    expect(result.content[0].text).toContain("partial");
    expect(result.details.status).toBe("killed");
    expect(result.details.killed).toBe(true);
  });

  // ── 5. Non-zero exit ──
  test("non-zero exit", async () => {
    spawnScripts = [
      { stdoutChunks: ["out"], stderrChunks: ["err"], exitCode: 2 },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "fail" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(result.content[0].text).toContain("exited with code 2");
    expect(result.content[0].text).toContain("out");
    expect(result.content[0].text).toContain("err");
    expect(result.details).toEqual({ exitCode: 2, status: "error" });
  });

  // ── 6. 127 with output is NOT retried ──
  test("127 with output is not retried", async () => {
    spawnScripts = [{ stdoutChunks: ["some real output"], exitCode: 127 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "127-out" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(spawnCalls.length).toBe(1);
    expect(result.details.status).toBe("error");
    expect(result.details.exitCode).toBe(127);
  });

  // ── 7. 127 shebang → bun fallback succeeds ──
  test("127 shebang → bun fallback succeeds", async () => {
    const home = os.homedir();
    const bunBin = `${home}/.bun/bin/bun`;
    const ompCli = `${home}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`;

    spawnScripts = [
      {
        stdoutChunks: [],
        stderrChunks: ["env: bun: not found"],
        exitCode: 127,
      },
      { stdoutChunks: ["done"], exitCode: 0 },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "fallback-127" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(spawnCalls.length).toBe(2);
    expect(spawnCalls[0].command).toBe("omp");
    expect(spawnCalls[1].command).toBe(bunBin);
    expect(spawnCalls[1].args[0]).toBe(ompCli);
    expect(result.details.status).toBe("ok");
    expect(result.content[0].text).toBe("done");
  });

  // ── 8. omp ENOENT → bun fallback succeeds ──
  test("omp ENOENT → bun fallback succeeds", async () => {
    spawnScripts = [
      { error: new Error("spawn omp ENOENT") },
      { stdoutChunks: ["x"], exitCode: 0 },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "fallback-enoent" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(spawnCalls.length).toBe(2);
    expect(result.details.status).toBe("ok");
    expect(result.content[0].text).toBe("x");
  });

  // ── 9. Both stages throw → spawn_failed ──
  test("both stages throw → spawn_failed", async () => {
    spawnScripts = [
      { error: new Error("omp ENOENT") },
      { error: new Error("bun ENOENT") },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "both-fail" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(result.details.status).toBe("spawn_failed");
    expect(result.details.firstAttempt).toBeUndefined();
    expect((result.details.fallbackError as string)).toContain("bun ENOENT");
    expect(result.content[0].text).toContain("omp");
    expect(result.content[0].text).toContain("bun ENOENT");
  });

  // ── 10. 127 shebang then bun throws → spawn_failed with firstAttempt ──
  test("127 shebang then bun throws → spawn_failed with firstAttempt", async () => {
    spawnScripts = [
      {
        stdoutChunks: [],
        stderrChunks: ["s"],
        exitCode: 127,
      },
      { error: new Error("bun missing") },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "127-fallback-fail" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(result.details.status).toBe("spawn_failed");
    const firstAttempt = result.details.firstAttempt as Record<string, unknown>;
    expect(firstAttempt.code).toBe(127);
    expect(result.content[0].text).toContain("127");
    expect(result.content[0].text).toContain("bun missing");
  });

  // ── 11. timeout_seconds passed through ──
  test("timeout_seconds passed through", async () => {
    spawnScripts = [{ stdoutChunks: ["ok"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p", timeout_seconds: 30 },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    // timeoutMs is used internally by the extension for setTimeout;
    // verify the tool completes successfully with the given timeout.
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].options.cwd).toBe("/test/session-cwd");
  });

  // ── 12. Default timeout ──
  test("default timeout", async () => {
    spawnScripts = [{ stdoutChunks: ["ok"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    // Default timeout is 600s; verify the tool completes successfully.
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].options.cwd).toBe("/test/session-cwd");
  });

  // ── 13. cwd precedence — explicit ──
  test("cwd precedence — explicit params.cwd", async () => {
    spawnScripts = [{ stdoutChunks: ["ok"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p", cwd: "/explicit" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(spawnCalls[0].options.cwd).toBe("/explicit");
    const update = onUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect((update.details as Record<string, unknown>).cwd as string).toBe("/explicit");
  });

  test("cwd precedence — default to ctx.cwd", async () => {
    spawnScripts = [{ stdoutChunks: ["ok"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      { cwd: "/test/session-cwd" },
    );

    expect(spawnCalls[0].options.cwd).toBe("/test/session-cwd");
    const update = onUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect((update.details as Record<string, unknown>).cwd as string).toBe(
      "/test/session-cwd",
    );
  });

  // ── 15. Model and thinking args ──
  test("model and thinking args", async () => {
    spawnScripts = [{ stdoutChunks: ["ok"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p", model: "opencode-go/x", thinking: "high" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    const args = spawnCalls[0].args;
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).not.toBe(-1);
    expect(args[modelIdx + 1]).toBe("opencode-go/x");

    const thinkingIdx = args.indexOf("--thinking");
    expect(thinkingIdx).not.toBe(-1);
    expect(args[thinkingIdx + 1]).toBe("high");
  });

  test("no model arg when not provided", async () => {
    spawnScripts = [{ stdoutChunks: ["ok"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(spawnCalls[0].args).not.toContain("--model");
    expect(spawnCalls[0].args).not.toContain("--thinking");
  });

  // ── 17. Temp-file success path passes @file ──
  test("temp-file success path passes @file", async () => {
    spawnScripts = [{ stdoutChunks: ["ok"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "hello" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    const arg1 = spawnCalls[0].args[1];
    expect(arg1.startsWith("@")).toBe(true);
    expect(arg1.endsWith(".txt")).toBe(true);
    expect(arg1).toContain("omp-delegate-");

    const tempPath = arg1.slice(1);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  // ── 18. onUpdate initial call ──
  test("onUpdate initial call", async () => {
    spawnScripts = [{ stdoutChunks: ["result"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "test" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    // Now called more than once due to streaming chunks
    expect(onUpdate).toHaveBeenCalled();
    const firstUpdate = onUpdate.mock.calls[0][0] as Record<string, unknown>;
    const details = firstUpdate.details as Record<string, any>;
    expect(details.status).toBe("running");
    const content = firstUpdate.content as Array<Record<string, unknown>>;
    expect((content[0].text as string)).toContain("Delegating to OMP");
  });

  // ── 19. Streaming updates include accumulated stdout and stderr ──
  test("streaming updates include accumulated stdout and stderr", async () => {
    spawnScripts = [
      { stdoutChunks: ["result: 42"], stderrChunks: ["thinking..."], exitCode: 0 },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "stream" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    // Find streaming calls (status = "streaming", not the initial "running")
    const streamingCalls = onUpdate.mock.calls
      .map(([u]) => u as Record<string, unknown>)
      .filter((u) => {
        const d = u.details as Record<string, unknown>;
        return d?.status === "streaming";
      });

    expect(streamingCalls.length).toBeGreaterThanOrEqual(2);

    // The last update should contain the accumulated stdout and stderr
    const lastContent = (streamingCalls[streamingCalls.length - 1] as Record<string, unknown>).content as Array<Record<string, unknown>>;
    const lastText = lastContent[0].text as string;
    expect(lastText).toContain("result: 42");
    expect(lastText).toContain("thinking...");
  });

  // ── 20. Streaming updates accumulate across chunks ──
  test("streaming updates accumulate across chunks", async () => {
    spawnScripts = [
      { stdoutChunks: ["part1", "part2"], stderrChunks: [], exitCode: 0 },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "stream" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    // All streaming updates (skip initial "running")
    const streamingCalls = onUpdate.mock.calls
      .map(([u]) => u as Record<string, unknown>)
      .filter((u) => {
        const d = u.details as Record<string, unknown>;
        return d?.status === "streaming";
      });

    expect(streamingCalls.length).toBeGreaterThanOrEqual(2);

    // The final update should contain both chunks accumulated
    const lastContent = (streamingCalls[streamingCalls.length - 1] as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect((lastContent[0].text as string)).toContain("part1part2");
  });

  // ── 21. Streaming updates include elapsed time header ──
  test("streaming updates include elapsed time header", async () => {
    spawnScripts = [
      { stdoutChunks: ["ok"], exitCode: 0 },
    ];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "stream" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    // Find streaming calls
    const streamingCalls = onUpdate.mock.calls
      .map(([u]) => u as Record<string, unknown>)
      .filter((u) => {
        const d = u.details as Record<string, unknown>;
        return d?.status === "streaming";
      });

    expect(streamingCalls.length).toBeGreaterThanOrEqual(1);
    const content = (streamingCalls[0] as Record<string, unknown>).content as Array<Record<string, unknown>>;
    const text = content[0].text as string;
    expect(text).toContain("[OMP running —");
    expect(text).toContain("elapsed]");
  });

  // ── 22. Killed process resolves with killed=true ──
  test("killed process resolves with killed=true", async () => {
    // The entry's killed flag + exitCode=null simulates a process terminated
    // by signal. createFakeChild emits 'close' with killed=true, which
    // flows through spawnWithStreaming's close→finalize→resolve path.
    spawnScripts = [{ stdoutChunks: ["partial output"], exitCode: null, killed: true }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "kill-me" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(result.details.status).toBe("killed");
    expect(result.details.killed).toBe(true);
    expect(result.content[0].text).toContain("OMP agent was killed");
    expect(result.content[0].text).toContain("partial output");
  });

  // ── 23. Fake kill() emits exit and close events ──
  test("fake kill emits exit and close", () => {
    // Verify that kill() triggers both 'exit' and 'close' events,
    // which spawnWithStreaming relies on for its termination paths.
    const child = createFakeChild({});

    let exitFired = false;
    let closeFired = false;
    child.on("exit", () => { exitFired = true; });
    child.on("close", () => { closeFired = true; });

    child.kill();

    // kill() sets killed = true synchronously
    expect(child.killed).toBe(true);

    // Events fire asynchronously via setImmediate
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(exitFired).toBe(true);
        expect(closeFired).toBe(true);
        resolve();
      });
    });
  });
});
