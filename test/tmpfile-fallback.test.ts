import { test, expect, describe, mock } from "bun:test";
import type { ExtensionAPI, ExecResult, ExecOptions } from "@earendil-works/pi-coding-agent";

// Mock node:fs/promises BEFORE dynamically importing the extension so the
// mocked module is in place when omp-delegate.ts resolves its imports.
mock.module("node:fs/promises", () => ({
  writeFile: async () => {
    throw new Error("simulated EACCES");
  },
  unlink: async () => {},
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

// ── Helpers ──

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

/** Returns a mock ExtensionAPI. Access .tool via the getter AFTER calling
 *  ompCoderExtension(pi). */
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
    get tool(): ToolHandle {
      return capturedTool as ToolHandle;
    },
  };
}

const signal = undefined;
const defaultCtx = { cwd: "/test/session-cwd" };

describe("tmpfile-fallback", () => {
  test("inline prompt fallback on writeFile failure", async () => {
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

    const result = await h.tool.execute(
      "tcid",
      { prompt: "-risky" },
      signal,
      onUpdate as (update: Record<string, unknown>) => void,
      defaultCtx,
    );

    expect(result.content[0].text).toBe("ok");
    expect(result.details.status).toBe("ok");
    // Fallback: temp-write failed → inline prompt with leading space
    expect(scr.calls[0].args[1]).toBe(" -risky");
  });
});
