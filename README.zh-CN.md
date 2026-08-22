# dsh-sim-restart

> [English](README.md) · [中文](README.zh-CN.md)

<p align="center">
  <img src="https://img.shields.io/github/license/tkwkeven/dsh-sim-restart" alt="License">
  <img src="https://img.shields.io/github/stars/tkwkeven/dsh-sim-restart" alt="GitHub stars">
  <img src="https://img.shields.io/github/forks/tkwkeven/dsh-sim-restart" alt="GitHub forks">
  <img src="https://img.shields.io/github/last-commit/tkwkeven/dsh-sim-restart" alt="Last commit">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5" alt="DSH plugin">
</p>

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）插件提供模拟重启测试。无需真正重启 DSH 进程，即可在隔离的子进程中让每个插件完整走一遍重启路径——**进程重启 → 模块求值 → 插件形状 → `apply` 启动 → 冒烟运行 → `dispose` 清理 → 干净退出**——并报告插件在真实重启后是否会崩溃或挂死。

常驻 watcher 会在任何插件被安装、修改或移除时自动触发这些测试，并把失败诊断注入 agent 的提示词，直到全部通过为止。

这是 `dsh-lark-sim-restart` 的开源版本（已更名；该插件从来就不是 Lark 专属）。

## 功能特性

| 功能 | 描述 |
|---|---|
| 覆盖全部插件类型 | 动态插件（source 模式）、文件系统插件（`plugins/`）、npm 插件（`node_modules/`，含 `@scope`），以及任何带 `package.json` 的目录（module 模式，自动识别） |
| 引擎自动解析 | 从 `package.json` 的 exports/main 或常见路径解析入口；依赖从 profile 的 `node_modules`、全局根目录、DSH 安装目录和 `plugins/` 中布局 |
| 传递真实配置 | 自动测试从 patch 层收集每个插件的配置（bundle 内置 + profile，`!!js` 表达式在宿主侧求值） |
| Agent 反馈闭环 | 失败以 `systemPrompt` 段落的形式注入，附带精确诊断；watcher 在每次修复后重新测试，直到全部通过 |
| 内置引擎 | 引擎（`lib/engine.mjs`）随包一起发布——零外部部署 |

## 工具

| 工具 | 描述 |
|---|---|
| `simulate_plugin_restart` | 让单个插件走一遍模拟重启流水线（source 或 module 模式），返回按轮次/按阶段的结构化 ✅/❌ 诊断 |
| `simulate_plugin_restart_auto` | 扫描所有已启用插件并按顺序逐一测试；常驻 watcher 也使用它 |
| `sim_restart_auto_status` | 查询 watcher 状态：监控范围、最近一次扫描、待测队列、每个插件的最新结果与失败诊断 |

## 安装

将包放到 DSH profile（`plugins/` 或 `node_modules/`）下，并在 `cordis.patch.yml` 中启用：

```yaml
- insert:
    - id: sim-restart
      name: dsh-sim-restart
```

要求：Node.js ≥ 20、`@deepseek-ai/dsh-tools` peer 依赖，以及 `js-yaml`（依赖项）。

## 配置

| 键 | 默认值 | 描述 |
|---|---|---|
| `watchEnabled` | `true` | 启用常驻自动测试 watcher |
| `pollMs` | `2000` | watcher 扫描间隔（毫秒） |
| `debounceMs` | `2500` | 变更后开始测试前的防抖时间（毫秒） |
| `rounds` | `2` | 每个自动测试插件的轮数（1–4） |
| `smokeMs` | `800` | 每轮冒烟运行时长（毫秒） |
| `profileDir` | `~/.dsh/profiles/web` | 要监控和测试的目标 DSH profile 根目录 |
| `stubsMap` | Lark 默认值 | 插件名 → 外部连接的打桩列表（例如 `deepseek-harness-lark` WebSocket） |

## 工作原理

1. 引擎在全新的临时目录中运行每一轮（`mktemp -d`），写入 `params.json` 并执行 `node engine.mjs params.json`。
2. 引擎刻意**不**调用 `process.exit()`：一次干净的运行会在所有句柄释放后自然退出。进程挂死（被调用方超时）正是"重启后会挂死"的判定依据。
3. watcher 计算目录签名（每个文件的 `size + mtime`），每次轮询时做差异比较，经过防抖后，通过串行队列测试发生变更的插件。
4. 结果持久化到 `~/.dsh/var/sim-restart/auto-status.json`（可按部署配置）。

## 开发

```bash
node --check lib/index.js && node --check lib/engine.mjs
node test/self-test.mjs
```

## 许可协议

MIT
