import { test, expect, describe, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Module-level spawn state ──
// Shared state across all tests in this module; each test must reset.

interface SpawnScriptEntry {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number | null;
  error?: Error;
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

  // Emit close or error via setImmediate
  if (entry.error) {
    setImmediate(() => child.emit("error", entry.error!));
  } else {
    setImmediate(() => child.emit("close", entry.exitCode ?? 0));
  }

  return child;
}

// ── Mocks (must be set up BEFORE dynamic import) ──

mock.module("node:fs/promises", () => ({
  writeFile: async () => {
    throw new Error("simulated EACCES");
  },
  unlink: async () => {},
}));

mock.module("node:child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    const entry = spawnScripts[spawnIdx++];
    spawnCalls.push({ command, args, options });
    return createFakeChild(entry);
  },
}));

// Dynamic import is required here because mock.module must be called before
// the module is loaded. This is a test-specific module-loading boundary.
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
  details: Record<string, unknown>;
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

describe("tmpfile-fallback", () => {
  test("inline prompt fallback on writeFile failure", async () => {
    // Arrange: one spawn entry, reset state
    spawnScripts = [{ stdoutChunks: ["ok"], exitCode: 0 }];
    spawnCalls = [];
    spawnIdx = 0;

    const h = makePi();
    ompCoderExtension(h.pi);
    const onUpdate = mock<(x: Record<string, unknown>) => void>();

    // Act
    const result = await h.tool.execute(
      "tcid",
      { prompt: "-risky" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    // Assert
    expect(result.content[0].text).toBe("ok");
    expect(result.details.status).toBe("ok");
    // Fallback: temp-write failed → inline prompt with leading space
    expect(spawnCalls[0].args[1]).toBe(" -risky");
  });
});
