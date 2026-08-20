# dsh-sim-restart

Simulated-restart testing for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) plugins. Without actually restarting the DSH process, it runs each plugin through the full restart path — **process restart → module eval → plugin shape → `apply` start → smoke run → `dispose` cleanup → clean exit** — in an isolated subprocess, and reports whether the plugin would crash or hang after a real restart.

A resident watcher auto-triggers these tests whenever any plugin is installed, modified, or removed, and pushes failure diagnostics into the agent's prompt until everything passes again.

Open-source release of `dsh-lark-sim-restart` (renamed; the plugin was never Lark-specific).

## Features

| Feature | Description |
|---|---|
| Full plugin-type coverage | Dynamic plugins (source mode), filesystem plugins (`plugins/`), npm plugins (`node_modules/`, incl. `@scope`), and any directory with a `package.json` (module mode, auto-detected) |
| Engine auto-resolution | Entry resolved from `package.json` exports/main or common paths; dependencies laid out from the profile `node_modules`, the global root, the DSH install, and `plugins/` |
| Real config passing | Auto-tests collect each plugin's config from the patch layer (bundle-internal + profile, `!!js` expressions evaluated host-side) |
| Agent feedback loop | Failures are injected as a `systemPrompt` section with exact diagnostics; the watcher re-tests after every fix until all pass |
| Bundled engine | The engine (`lib/engine.mjs`) ships inside the package — zero external deployment |

## Tools

| Tool | Description |
|---|---|
| `simulate_plugin_restart` | Run one plugin through the simulated-restart pipeline (source or module mode), structured per-round/per-stage ✅/❌ diagnostics |
| `simulate_plugin_restart_auto` | Scan every enabled plugin and test them all in sequence; also used by the resident watcher |
| `sim_restart_auto_status` | Query watcher state: watch scope, last scan, pending queue, latest per-plugin results and failure diagnostics |

## Install

Place the package under a DSH profile (`plugins/` or `node_modules/`) and enable it in `cordis.patch.yml`:

```yaml
- insert:
    - id: sim-restart
      name: dsh-sim-restart
```

Requirements: Node.js ≥ 20, `@deepseek-ai/dsh-tools` peer, and `js-yaml` (dependency).

## Configuration

| Key | Default | Description |
|---|---|---|
| `watchEnabled` | `true` | Enable the resident auto-testing watcher |
| `pollMs` | `2000` | Watcher scan interval (ms) |
| `debounceMs` | `2500` | Debounce before testing after a change (ms) |
| `rounds` | `2` | Rounds per auto-tested plugin (1–4) |
| `smokeMs` | `800` | Smoke-run duration per round (ms) |
| `profileDir` | `~/.dsh/profiles/web` | Target DSH profile root to watch and test |
| `stubsMap` | Lark defaults | Plugin-name → stub list for external connections (e.g. `deepseek-harness-lark` WebSocket) |

## How it works

1. The engine runs each round in a fresh temp directory (`mktemp -d`), writing `params.json` and executing `node engine.mjs params.json`.
2. The engine deliberately does **not** call `process.exit()`: a clean run exits naturally when all handles are released. A hung process (timed out by the caller) is the exact "would hang after restart" verdict.
3. The watcher computes directory signatures (`size + mtime` of every file), diffs them on each poll, debounces, then tests changed plugins through a serial queue.
4. Results persist to `~/.dsh/var/sim-restart/auto-status.json` (configurable per deployment).

## Development

```bash
node --check lib/index.js && node --check lib/engine.mjs
node test/self-test.mjs
```

## License

MIT
