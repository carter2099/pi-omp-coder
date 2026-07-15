import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "os";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";



export default function ompCoderExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate_omp",
    label: "Delegate to OMP",
    description:
      "Delegate a complex coding task to an OMP (Oh My Pi) agent with a richer tool set including LSP, AST grep/edit, browser, and more. The OMP agent runs a full agent loop and returns results. Use this for multi-file refactors, cross-file renames, or tasks requiring deep code intelligence.",
    promptSnippet:
      "delegate_omp: delegate heavy coding work to an OMP agent with richer tools (LSP, AST, browser)",
    promptGuidelines: [
      "Prefer delegate_omp for multi-file refactors, cross-file renames, or tasks requiring LSP/AST tools.",
      "Write a self-contained prompt — the OMP agent has no context from this session.",
      "The call blocks until OMP finishes (up to the timeout). Do not use for quick one-liners.",
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
        Type.Union([
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
          Type.Literal("max"),
        ], {
          description:
            "Thinking level: off, minimal, low, medium, high, xhigh, max. Defaults to OMP's default.",
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

      // Build omp args. cwd is handled by pi.exec's spawn option, not --cwd.
      // --allow-home is not a recognized omp flag; skip it.
      const args = ["-p", promptPath ? `@${promptPath}` : ` ${params.prompt}`];
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

      // Resolve omp: try PATH first (standard case — works for interactive
      // shells and npm global installs), then fall back to calling bun
      // directly with the cli.js entrypoint (handles systemd contexts where
      // ~/.bun/bin isn't on PATH and the shebang can't resolve bun).
      const home = os.homedir();
      const bunBin = `${home}/.bun/bin/bun`;
      const ompCli = `${home}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`;

      let result;
      try {
        result = await pi.exec("omp", args, { signal, cwd, timeout: timeoutMs });
      } catch {
        // PATH failed — try bun directly with the cli.js entrypoint
        try {
          result = await pi.exec(bunBin, [ompCli, ...args], { signal, cwd, timeout: timeoutMs });
        } catch (err) {
          // Clean up temp file on failure
          if (promptPath) await unlink(promptPath).catch(() => {});
          return {
            content: [{
              type: "text",
              text: `ERROR: Failed to spawn OMP. Tried 'omp' (PATH) and '${bunBin} ${ompCli}'. Is the OMP CLI installed?\n\n${err}`,
            }],
            details: { error: String(err), status: "spawn_failed" },
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
