# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

`@carter2099/pi-omp-coder` is a [Pi](https://github.com/earendil-works/pi-coding-agent) extension that exposes a single tool, `delegate_omp`, which lets a Pi agent delegate heavy coding work to an [OMP (Oh My Pi)](https://github.com/carter2099/omp) subprocess. OMP runs a full agent loop with a richer tool set (LSP, AST grep/edit, browser, etc.) and returns its result to the Pi session.

The package is published to npm and installed by Pi users via `pi install npm:@carter2099/pi-omp-coder`.

## Repository layout

```
extensions/
  omp-delegate.ts   # the entire extension — registers the delegate_omp tool
package.json        # package metadata, peer deps, pi extension manifest
tsconfig.json        # strict TS, noEmit; type-checks extensions/ + test/
README.md            # user-facing docs (npm/GitHub)
LICENSE              # MIT
```

There is exactly one source file. All logic lives in `extensions/omp-delegate.ts`.

## Build / check / test / pack

```bash
npm install          # install dev + peer deps
npm run check        # tsc --noEmit — type-check only; must stay clean
npm test             # bun test — runtime test suite
npm run pack:dry     # npm pack --dry-run — verify what gets published
```

No runtime build step. Pi loads the `.ts` extension directly via its bundled TypeScript runtime. `tsc --noEmit` is a type-check only; it produces no output. `npm test` runs the bun:test suite covering every `execute` branch.

## The extension contract

`omp-delegate.ts` default-exports a function `ompCoderExtension(pi: ExtensionAPI)`. It calls `pi.registerTool({...})` with:

- `name: "delegate_omp"`, a label, description, prompt snippet, and prompt guidelines.
- `parameters`: a Typebox `Type.Object` with `prompt` (required string), and optional `cwd`, `model`, `thinking`, `timeout_seconds`.
- `execute(_toolCallId, params, signal, onUpdate, ctx)`: spawns the `omp` CLI, waits for it, and returns `{ content, details }`.

### How `execute` works

1. Writes `params.prompt` to a temp file (`/tmp/omp-delegate-<uuid>.txt`) and passes it to omp via `omp -p @<file>`. This avoids argv-parsing pitfalls: prompts beginning with `-` or `@` would be misread as flags/file-includes if passed inline. Falls back to an inline `"<space>prompt"` trick (leading space defeats flag detection) only if the temp-file write fails.
2. Builds args: `["-p", "@<file>", "--cwd", cwd, "--allow-home"]`, plus optional `--model` and `--thinking`.
3. `--allow-home` prevents omp from auto-switching to `/tmp` when launched from `~`.
4. Resolves the `omp` binary in two stages:
   - First tries `omp` on `PATH` (standard interactive case).
   - On failure, falls back to `${home}/.bun/bin/bun` running `${home}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` directly (handles systemd/non-interactive contexts where `~/.bun/bin` is not on `PATH`).
5. Runs via `pi.exec(...)` with the computed `timeoutMs` (default 600 s, clamped 10–3600).
6. Handles outcomes: `killed` (timeout/abort, includes partial stdout), non-zero exit (includes stdout+stderr), and success (returns trimmed stdout). The temp file is always cleaned up in a `finally`.

### Return shape

All paths return `{ content: [{ type: "text", text }], details: {...} }`. On success `details.status` is `"ok"`; on failure it is `"spawn_failed"`, `"killed"`, or `"error"`.

## Conventions

- **TypeScript**: strict mode, `module: ESNext`, `moduleResolution: bundler`, `target: ES2022`. No emission — type-checking only.
- **No runtime deps.** Extension relies on Node built-ins (`os`, `node:fs/promises`, `node:crypto`) and peer deps (`@earendil-works/pi-coding-agent`, `typebox`).
- **Typebox** is used for the tool's parameter schema (it matches Pi's extension API). Do not introduce a second schema library.
- **Comments explain *why*, not what.** The non-obvious bits (temp-file rationale, `--allow-home`, the two-stage omp resolution) are all commented — keep that bar when editing.
- Keep `README.md` in sync with the tool's parameters and behavior when you change the extension. The README documents the same `delegate_omp` parameters.

## When editing `omp-delegate.ts`

- Preserve the error-handling structure: spawn-failed, killed, non-zero, success must all return structured `content`/`details`.
- Always clean up the temp file — the `finally` is load-bearing.
- The two-stage omp binary resolution exists for a reason (non-interactive/systemd environments). Don't collapse it to `omp`-only without a replacement for the fallback.
- `pi.exec` takes `(command, args, options)` with `{ signal, cwd, timeout }`. The result has `{ stdout, stderr, code, killed }`.

## Publishing

1. Bump `version` in `package.json`.
2. Tag with the `v` prefix: `git tag -a v<version> -m "<version>: <short description>"`.
3. Push the tag: `git push origin v<version>`.

The `.github/workflows/release.yml` workflow auto-creates a GitHub Release with generated notes when a `v`-prefixed semver tag is pushed.

4. Publish to npm:

```bash
npm publish --access public
```

`files` in `package.json` includes only `extensions/`, `README.md`, `LICENSE` — so only those ship.