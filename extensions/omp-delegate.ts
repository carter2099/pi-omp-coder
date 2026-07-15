import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "os";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

// ── Types ──

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

export interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

// ── Streaming spawn ──

/** Grace period after exit before finalizing when stdio pipes are held open
 *  by a detached descendant (mirrors Pi's waitForChildProcess). */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * Spawn a child process, stream stdout/stderr chunks via `onUpdate`,
 * and return the accumulated output when the process terminates.
 *
 * Handles timeout with SIGTERM→SIGKILL escalation and abort signal.
 * Resolves on 'close' (fast path) or on 'exit' + idle grace (handles
 * detached descendants that keep the stdio pipe open, per pi#5303).
 * Rejects only on spawn errors (ENOENT etc.).
 */
async function spawnWithStreaming(
  command: string,
  args: string[],
  opts: SpawnOptions,
  onUpdate?: (update: Record<string, unknown>) => void,
): Promise<SpawnResult> {
  const { cwd, timeoutMs, signal } = opts;
  const { promise, resolve, reject } = Promise.withResolvers<SpawnResult>();

  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";
  const startTime = Date.now();

  // Build a display string from accumulated output and elapsed time.
  const buildDisplay = () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const elapsedStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;

    let display = `[OMP running — ${elapsedStr} elapsed]`;
    if (stderr) {
      display += `\n\n${stderr}`;
    }
    if (stdout) {
      display += `\n\n${stdout}`;
    }
    return display;
  };

  const sendUpdate = () => {
    onUpdate?.({
      content: [{ type: "text", text: buildDisplay() }],
      details: { status: "streaming" },
    });
  };

  // Heartbeat: send elapsed-time updates every 5s even when OMP is silent.
  const heartbeatMs = 5000;
  const heartbeatId = setInterval(sendUpdate, heartbeatMs);

  // Re-arm idle timer when data arrives after exit (avoids truncating tail
  // output of a detached descendant that's still writing).
  let exitCode: number | null = null;
  let postExitTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    clearTimeout(postExitTimer);
    postExitTimer = setTimeout(finalize, EXIT_STDIO_GRACE_MS);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    sendUpdate();
    if (exitCode !== null && !settled) armIdleTimer();
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    sendUpdate();
    if (exitCode !== null && !settled) armIdleTimer();
  });
  // Kill escalation: SIGTERM first, then SIGKILL after 5s if the process
  // still hasn't died.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let sigkillId: ReturnType<typeof setTimeout> | undefined;
  const killProcess = () => {
    if (child.killed) return;
    child.kill("SIGTERM");
    sigkillId = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5000);
  };

  // Abort signal — check pre-aborted state before registering listener.
  const onAbort = () => {
    clearTimeout(timeoutId);
    killProcess();
  };
  if (signal?.aborted) {
    killProcess();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(killProcess, timeoutMs);
  }

  const cleanup = () => {
    clearTimeout(timeoutId);
    clearTimeout(sigkillId);
    clearTimeout(postExitTimer);
    clearInterval(heartbeatId);
    signal?.removeEventListener("abort", onAbort);
  };

  let settled = false;
  function finalize() {
    if (settled) return;
    settled = true;
    cleanup();
    (child.stdout as any)?.destroy?.();
    (child.stderr as any)?.destroy?.();
    resolve({
      stdout,
      stderr,
      code: exitCode,
      killed: child.killed || (signal?.aborted ?? false),
    });
  }

  child.on("error", (err) => {
    cleanup();
    reject(err);
  });

  // Two termination paths:
  //   1. 'close' — fast path when pipes close normally.
  //   2. 'exit' + idle grace — handles detached descendants that inherited
  //      the stdio pipe and never let 'close' fire (pi#5303).
  child.on("exit", (code) => {
    exitCode = code;
    armIdleTimer();
  });

  child.on("close", (code) => {
    exitCode = code;
    finalize();
  });

  return promise;
}
// ── Extension ──

export default function ompCoderExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate_omp",
    label: "Delegate to OMP",
    description:
      "Delegate a complex coding task to an OMP (Oh My Pi) agent with a richer tool set including LSP, AST grep/edit, browser, and more. The OMP agent runs a full agent loop and returns results. Progress is streamed in real-time. Use this for multi-file refactors, cross-file renames, or tasks requiring deep code intelligence.",
    promptSnippet:
      "delegate_omp: delegate heavy coding work to an OMP agent with richer tools (LSP, AST, browser)",
    promptGuidelines: [
      "Prefer delegate_omp for multi-file refactors, cross-file renames, or tasks requiring LSP/AST tools.",
      "Write a self-contained prompt — the OMP agent has no context from this session.",
      "The call blocks until OMP finishes (up to the timeout), but output streams in real-time.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "The task for the OMP agent. Be specific about files, changes, and acceptance criteria. The OMP agent has no context from this session — include everything it needs.",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the OMP agent. Defaults to the current session's working directory.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model for the OMP agent (e.g. 'opencode-go/deepseek-v4-pro'). Defaults to OMP's configured default model.",
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description:
            "Thinking level: off, minimal, low, medium, high, xhigh, max, auto. Defaults to OMP's default.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description:
            "Hard timeout in seconds. Default: 600 (10 minutes). OMP is killed if it exceeds this.",
          minimum: 10,
          maximum: 3600,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;
      const timeoutMs = (params.timeout_seconds ?? 600) * 1000;

      // Write prompt to a temp file to avoid argv-parsing issues in omp:
      // prompts starting with "-" or "@" are interpreted as flags or file
      // includes rather than the message. The @file syntax is safe.
      const promptFile = `${tmpdir()}/omp-delegate-${randomUUID()}.txt`;
      let promptPath: string | undefined;
      try {
        await writeFile(promptFile, params.prompt, "utf-8");
        promptPath = promptFile;
      } catch {
        // If we can't write the temp file, fall back to inline prompt.
        // The leading-space trick prevents omp from seeing a leading "-".
        promptPath = undefined;
      }

      // Build omp args. --allow-home prevents omp from auto-switching to
      // /tmp when started from ~. --cwd sets the working directory.
      const args = ["-p", promptPath ? `@${promptPath}` : ` ${params.prompt}`, "--cwd", cwd, "--allow-home"];
      if (params.model) {
        args.push("--model", params.model);
      }
      if (params.thinking) {
        args.push("--thinking", params.thinking);
      }

      // Initial progress update
      onUpdate?.({
        content: [{ type: "text", text: `Delegating to OMP agent in ${cwd}...` }],
        details: { status: "running", cwd },
      });

      const spawnOpts: SpawnOptions = { cwd, timeoutMs, signal };
      // Resolve omp: try PATH first (standard case — works for interactive
      // shells and npm global installs), then fall back to calling bun
      // directly with the cli.js entrypoint (handles systemd contexts where
      // ~/.bun/bin isn't on PATH and the shebang can't resolve bun).
      // There are two distinct PATH-failure modes under non-interactive
      // hosts like pi-web's systemd session daemon (whose service PATH
      // commonly omits ~/.bun/bin):
      //   1. "omp" isn't on PATH at all  -> spawn emits 'error' (ENOENT).
      //   2. "omp" is on PATH but its `#!/usr/bin/env bun` shebang can't
      //      resolve bun from this process's PATH -> the script starts,
      //      /usr/bin/env reports "bun: not found", and it exits 127 with
      //      no stdout. That's a non-throwing close event we probe for.
      // Both fall through to invoking bun directly with the cli.js entrypoint.
      const home = os.homedir();
      const bunBin = `${home}/.bun/bin/bun`;
      const ompCli = `${home}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`;

      // Track the first attempt so its output survives a failed fallback — we
      // never want to mask the real error behind a second, vaguer failure.
      let firstAttempt: SpawnResult | undefined;
      let result: SpawnResult;
      try {
        result = await spawnWithStreaming("omp", args, spawnOpts, onUpdate as ((u: Record<string, unknown>) => void) | undefined);
        // Re-route into the catch only for the specific shebang-interpreter
        // case: omp spawned but produced no output and exited 127 (the POSIX
        // "interpreter not found" code — e.g. `#!/usr/bin/env bun` with bun
        // absent from this process's PATH). A genuine omp failure that
        // emitted output keeps its real stdout/stderr and falls through to
        // the normal non-zero-exit path below — we don't retry on that.
        if (result.code === 127 && result.stdout.trim() === "") {
          firstAttempt = result;
          throw new Error(`omp exited 127 with no output (shebang interpreter not found): ${result.stderr}`);
        }
      } catch (err) {
        // PATH/shebang failed — invoke bun directly with the cli.js
        // entrypoint. The absolute paths make this PATH-independent, so it
        // works even where omp's shebang couldn't resolve bun.
        try {
          result = await spawnWithStreaming(bunBin, [ompCli, ...args], spawnOpts, onUpdate as ((u: Record<string, unknown>) => void) | undefined);
        } catch (fallbackErr) {
          // Clean up temp file on failure
          if (promptPath) await unlink(promptPath).catch(() => {});
          const firstDiag = firstAttempt
            ? `\n\nFirst attempt (omp on PATH):\n  exit: ${firstAttempt.code}\n  stdout: ${firstAttempt.stdout}\n  stderr: ${firstAttempt.stderr}`
            : `\n\nFirst attempt (omp on PATH): ${err}`;
          return {
            content: [{
              type: "text",
              text: `ERROR: Failed to spawn OMP. Tried 'omp' (PATH), then '${bunBin} ${ompCli}'. Is the OMP CLI installed?${firstDiag}\n\nFallback error: ${fallbackErr}`,
            }],
            details: { status: "spawn_failed", firstAttempt, fallbackError: String(fallbackErr) },
          };
        }
      } finally {
        // Clean up temp file regardless of outcome
        if (promptPath) await unlink(promptPath).catch(() => {});
      }

      // Handle timeout/kill
      if (result.killed) {
        return {
          content: [
            {
              type: "text",
              text: `OMP agent was killed (timeout or user abort after ${timeoutMs / 1000}s).\n\nPartial output:\n${result.stdout}`,
            },
          ],
          details: { exitCode: result.code, killed: true, status: "killed" },
        };
      }

      // Handle non-zero exit
      if (result.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `OMP agent exited with code ${result.code}.\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`,
            },
          ],
          details: { exitCode: result.code, status: "error" },
        };
      }

      // Success — return stdout (the actual agent output; "Working..." is on stderr)
      const output = result.stdout.trim();
      return {
        content: [{ type: "text", text: output || "(OMP agent produced no output)" }],
        details: { exitCode: 0, status: "ok", outputLength: output.length },
      };
    },
  });
}
