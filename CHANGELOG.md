# Changelog

## 0.3.0 — 2026-08-21

- Open-source release as `dsh-sim-restart` (renamed from `dsh-lark-sim-restart`; the plugin was never Lark-specific).
- Engine now ships inside the package (`lib/engine.mjs`, zero external dependencies); legacy `~/.dsh/var/sim-restart/engine.mjs` kept as a fallback.
- `profileDir` config key replaces the hard-coded `~/.dsh/profiles/web` path — any DSH profile can be targeted.
- `js-yaml` declared as a dependency instead of relying on the DSH install path.
- Added README, LICENSE, self-test suite.

## 0.2.0

- Full plugin-type coverage (dynamic / filesystem / npm / any directory).
- Resident auto-watcher with debounce + serial queue; agent feedback loop via systemPrompt.
- New tools: `simulate_plugin_restart_auto`, `sim_restart_auto_status`.
- Real patch-layer config passing (incl. `!!js` expressions).

## 0.1.0

- Initial simulated-restart engine and manual `simulate_plugin_restart` tool.
