# @carter2099/pi-omp-coder

[![npm version](https://img.shields.io/npm/v/@carter2099/pi-omp-coder)](https://www.npmjs.com/package/@carter2099/pi-omp-coder)
[![npm downloads](https://img.shields.io/npm/dm/@carter2099/pi-omp-coder)](https://www.npmjs.com/package/@carter2099/pi-omp-coder)
[![license](https://img.shields.io/npm/l/@carter2099/pi-omp-coder)](https://github.com/carter2099/pi-omp-coder/blob/main/LICENSE)

Pi extension that lets the agent delegate heavy coding tasks to an OMP (Oh My Pi) subprocess with a richer tool set including LSP, AST grep/edit, browser, and more.

## Prerequisites

- **OMP CLI** (`omp`) installed (via bun or npm), with models and auth configured.
- **Pi** (`pi`) with extension support (v0.18+).

## Install

```bash
pi install npm:@carter2099/pi-omp-coder
```

Or add to `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:@carter2099/pi-omp-coder"] }
```

## Tool: `delegate_omp`

Delegates a complex coding task to an OMP agent subprocess. The OMP agent runs a full agent loop with its own tools and returns results. Use for multi-file refactors, cross-file renames, or tasks requiring deep code intelligence.

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | yes | — | The task for the OMP agent. Be specific about files, changes, and acceptance criteria. The OMP agent has no context from this session. |
| `cwd` | string | no | session cwd | Working directory for the OMP agent. |
| `model` | string | no | OMP default | Model for the OMP agent (e.g. `opencode-go/deepseek-v4-pro`). |
| `thinking` | string | no | OMP default | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `timeout_seconds` | number | no | 600 | Hard timeout in seconds (10-3600). OMP is killed if it exceeds this. |

### Example

```
pi> Use delegate_omp to read src/auth.ts and add JWT refresh token support
```

The OMP agent runs independently, reads the file, makes the changes, and returns the result to the pi session.

## License

MIT
