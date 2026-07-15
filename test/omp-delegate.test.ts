import { test, expect, describe, mock } from "bun:test";
import os from "os";
import fs from "fs";
import type { ExtensionAPI, ExecResult, ExecOptions } from "@earendil-works/pi-coding-agent";
import ompCoderExtension from "../extensions/omp-delegate.ts";

// ── Types for the test harness ──

interface ExecuteParams {
  prompt: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  timeout_seconds?: number;
}

interface ExecuteResult {
  content: { type: string; text: string }[];
  details: Record<string, unknown>;
}

type ExecImpl = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

interface ExecCall {
  command: string;
  args: string[];
  options?: ExecOptions;
}

interface ScriptEntry {
  result?: ExecResult;
  throw?: unknown;
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

/** Recorder: accepts an ordered list of script entries and exposes `calls`
 *  for assertions on what was passed to pi.exec. */
function recorder(scripts: ScriptEntry[]) {
  const calls: ExecCall[] = [];
  let idx = 0;
  return {
    exec: (async (
      command: string,
      args: string[],
      options?: ExecOptions,
    ): Promise<ExecResult> => {
      const entry = scripts[idx++];
      calls.push({ command, args, options });
      if (entry.throw) throw entry.throw;
      return entry.result! as ExecResult;
    }) as ExecImpl,
    calls,
  };
}

/** Creates a mock ExtensionAPI that captures the registered tool definition.
 *  `pi` is cast via unknown — only registerTool and exec are used; the
 *  interface requires many more methods that aren't relevant. */
function makePi(execImpl: ExecImpl) {
  let capturedTool: unknown;
  const pi = {
    registerTool(tool: unknown) {
      capturedTool = tool;
    },
    exec: execImpl,
  } as unknown as ExtensionAPI;
  return {
    pi,
    /** Returns the tool definition registered via registerTool. Must be
     *  accessed AFTER calling ompCoderExtension(pi). Calling via getter
     *  avoids the early-evaluation trap of destructuring. */
    get tool(): ToolHandle {
      return capturedTool as ToolHandle;
    },
  };
}

// Common defaults
const signal = undefined;
const defaultCtx = { cwd: "/test/session-cwd" };

describe("omp-delegate", () => {
  // ── 1. Registration ──
  test("registration", () => {
    const scr = recorder([]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    // Captured tool definition — read back from the extension's registerTool call
    let captured: Record<string, unknown> = {};
    const pi2 = {
      registerTool(def: Record<string, unknown>) {
        captured = def;
      },
      exec: scr.exec,
    } as unknown as ExtensionAPI;
    ompCoderExtension(pi2);

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
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "  hello world  ",
          stderr: "Working...",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
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
    expect(scr.calls.length).toBe(1);
  });

  // ── 3. Success empty output ──
  test("success empty output", async () => {
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "   ",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
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
    const scr = recorder([
      {
        result: {
          code: null as unknown as number,
          stdout: "partial",
          stderr: "",
          killed: true,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
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
    const scr = recorder([
      {
        result: {
          code: 2,
          stdout: "out",
          stderr: "err",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
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
    const scr = recorder([
      {
        result: {
          code: 127,
          stdout: "some real output",
          stderr: "e",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "127-out" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(scr.calls.length).toBe(1);
    expect(result.details.status).toBe("error");
    expect(result.details.exitCode).toBe(127);
  });

  // ── 7. 127 shebang → bun fallback succeeds ──
  test("127 shebang → bun fallback succeeds", async () => {
    const home = os.homedir();
    const bunBin = `${home}/.bun/bin/bun`;
    const ompCli = `${home}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`;

    const scr = recorder([
      {
        result: {
          code: 127,
          stdout: "",
          stderr: "env: bun: not found",
          killed: false,
        } as ExecResult,
      },
      {
        result: {
          code: 0,
          stdout: "done",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "fallback-127" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(scr.calls.length).toBe(2);
    expect(scr.calls[0].command).toBe("omp");
    expect(scr.calls[1].command).toBe(bunBin);
    expect(scr.calls[1].args[0]).toBe(ompCli);
    expect(result.details.status).toBe("ok");
    expect(result.content[0].text).toBe("done");
  });

  // ── 8. omp ENOENT → bun fallback succeeds ──
  test("omp ENOENT → bun fallback succeeds", async () => {
    const scr = recorder([
      { throw: new Error("spawn omp ENOENT") },
      {
        result: {
          code: 0,
          stdout: "x",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    const result = await h.tool.execute(
      "tcid",
      { prompt: "fallback-enoent" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(scr.calls.length).toBe(2);
    expect(result.details.status).toBe("ok");
    expect(result.content[0].text).toBe("x");
  });

  // ── 9. Both stages throw → spawn_failed ──
  test("both stages throw → spawn_failed", async () => {
    const scr = recorder([
      { throw: new Error("omp ENOENT") },
      { throw: new Error("bun ENOENT") },
    ]);
    const h = makePi(scr.exec);
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
    const scr = recorder([
      {
        result: {
          code: 127,
          stdout: "",
          stderr: "s",
          killed: false,
        } as ExecResult,
      },
      { throw: new Error("bun missing") },
    ]);
    const h = makePi(scr.exec);
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
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "ok",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p", timeout_seconds: 30 },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(scr.calls[0].options?.timeout).toBe(30000);
  });

  // ── 12. Default timeout ──
  test("default timeout", async () => {
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "ok",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(scr.calls[0].options?.timeout).toBe(600000);
  });

  // ── 13. cwd precedence ──
  test("cwd precedence — explicit params.cwd", async () => {
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "ok",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p", cwd: "/explicit" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(scr.calls[0].options?.cwd).toBe("/explicit");
    const update = onUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect((update.details as Record<string, unknown>).cwd).toBe("/explicit");
  });

  test("cwd precedence — default to ctx.cwd", async () => {
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "ok",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      { cwd: "/test/session-cwd" },
    );

    expect(scr.calls[0].options?.cwd).toBe("/test/session-cwd");
    const update = onUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect((update.details as Record<string, unknown>).cwd).toBe("/test/session-cwd");
  });

  // ── 14. model and thinking args ──
  test("model and thinking args", async () => {
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "ok",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p", model: "opencode-go/x", thinking: "high" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    const args = scr.calls[0].args;
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).not.toBe(-1);
    expect(args[modelIdx + 1]).toBe("opencode-go/x");

    const thinkingIdx = args.indexOf("--thinking");
    expect(thinkingIdx).not.toBe(-1);
    expect(args[thinkingIdx + 1]).toBe("high");
  });

  test("no model arg when not provided", async () => {
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "ok",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "p" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(scr.calls[0].args).not.toContain("--model");
    expect(scr.calls[0].args).not.toContain("--thinking");
  });

  // ── 15. Temp-file success path passes @file ──
  test("temp-file success path passes @file", async () => {
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "ok",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "hello" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    const arg1 = scr.calls[0].args[1];
    expect(arg1.startsWith("@")).toBe(true);
    expect(arg1.endsWith(".txt")).toBe(true);
    expect(arg1).toContain("omp-delegate-");

    const tempPath = arg1.slice(1);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  // ── 16. onUpdate initial call ──
  test("onUpdate initial call", async () => {
    const scr = recorder([
      {
        result: {
          code: 0,
          stdout: "result",
          stderr: "",
          killed: false,
        } as ExecResult,
      },
    ]);
    const h = makePi(scr.exec);
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    await h.tool.execute(
      "tcid",
      { prompt: "test" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const update = onUpdate.mock.calls[0][0] as Record<string, unknown>;
    const details = update.details as Record<string, unknown>;
    expect(details.status).toBe("running");
    const content = update.content as Array<Record<string, unknown>>;
    expect((content[0].text as string)).toContain("Delegating to OMP");
  });
});
