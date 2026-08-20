#!/usr/bin/env node
/**
 * sim-restart-engine.mjs —— 单轮「模拟重启」测试引擎
 *
 * 由 simulate_plugin_restart 工具调用，运行在隔离子进程中，完整模拟
 * 「进程重启 → 模块求值 → 插件形状 → apply 启动 → 冒烟运行 → dispose 清理 →
 * 进程自然退出」路径，检测插件重启后是否会崩溃或挂死。
 *
 * 用法：node sim-restart-engine.mjs <params.json>
 * 输出：同步写 <params>.result.json（权威结果），并打印 __SIM_RESULT__:<json>。
 * 引擎自身不主动 process.exit：全部清理干净时进程自然退出；残留句柄会让
 * 调用方（shell 超时）判定 FAIL —— 这就是「重启会挂死」的判据。
 *
 * 支持的插件类型（mode=module，pluginDir 给路径即可自动识别）：
 *   * 文件系统插件   ~/.dsh/profiles/web/plugins/<name>/（本地开发）
 *   * npm 插件       ~/.dsh/profiles/web/node_modules/<pkg> 或 <@scope>/<pkg>
 *   * 任意目录插件   含 package.json 的任意目录（含全局 node_modules 下的包）
 * 入口自动解析：package.json exports['.']（import/default/require）→ main →
 * 常见路径探测（dist/lib/src/index.js、dist/main.js、dsh/index.js 等）。
 *
 * params 字段：
 *   mode          "source" | "module"（默认 source）
 *   name          插件显示名（报告用）
 *   hostSource    source 模式：动态插件 Host 半边源码（function body 原文）
 *   clientSource  source 模式：Client 半边源码（可选，只做求值+形状检查）
 *   pluginDir     module 模式：插件目录绝对路径（plugins/、node_modules/、任意）
 *   entry         module 模式：入口相对路径（缺省自动解析）
 *   packageName   module 模式：插件包名（缺省读 package.json 或从路径推导）
 *   profileDir    module 模式：profile 根（默认 ~/.dsh/profiles/web，依赖布局用）
 *   depsRoot      module 模式：全局依赖根（默认 /usr/local/lib/node_modules）
 *   stubs         module 模式：打桩列表 [{"module","export","method"}]（避免连接外部服务）
 *   extraConfig   module 模式：JSON 对象，合并进 apply(ctx, config) 的 config
 *   smokeMs       每轮冒烟运行时长（毫秒，默认 1200）
 */
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync,
  existsSync, readdirSync, statSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, basename, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const paramsPath = process.argv[2]
if (!paramsPath) {
  console.error('usage: node sim-restart-engine.mjs <params.json>')
  process.exit(2)
}
const params = JSON.parse(readFileSync(paramsPath, 'utf8'))
const outPath = paramsPath.replace(/\.json$/, '.result.json')
const smokeMs = Number(params.smokeMs || 1200)
const mode = params.mode === 'module' ? 'module' : 'source'
const displayName = String(params.name || (mode === 'module' ? (params.pluginDir || 'module-plugin') : 'dynamic-plugin'))

const stages = []
let failures = 0
function check(name, ok, detail = '') {
  stages.push({ name, ok, detail: String(detail || '') })
  if (!ok) failures += 1
}
function errText(e) {
  if (e == null) return 'unknown error'
  return (e && typeof e.stack === 'string') ? e.stack : String(e)
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function normRel(p) { return String(p || '').replace(/\\/g, '/') }

// ── 未处理异常/拒绝收集（不立即退出，作为 FAIL 判据之一） ────────────────
const uncaught = []
process.on('uncaughtException', (e) => { uncaught.push('uncaughtException: ' + errText(e)) })
process.on('unhandledRejection', (e) => { uncaught.push('unhandledRejection: ' + errText(e)) })

// ── 注入受限宿主全局（模拟 DSH 动态插件宿主环境） ────────────────────────
globalThis.harness = {
  handle() { return () => {} },
  defineTool(d) { return d },
  registerTool() { return () => {} },
}
globalThis.console = console
globalThis.btoa = (s) => Buffer.from(String(s), 'utf8').toString('base64')
globalThis.atob = (s) => Buffer.from(String(s), 'base64').toString('utf8')
globalThis.TextEncoder = TextEncoder
globalThis.TextDecoder = TextDecoder

// ── 模拟 Cordis ctx（get/on/effect/provide/logger + timer mixin） ─────────
function makeSimCtx() {
  const state = {
    listeners: [],
    effectDisposers: [],
    timerDisposers: [],
    logs: [],
    effectError: null,
    effects: [],
    tools: [],
    pendingInjects: [],
    pendingInjectErrors: [],
  }
  // 兼容真实 cordis Logger 形态：既是可调用函数（logger('label') 返回子 logger），
  // 也带 info/warn/error 方法（ctx.logger.warn(...) 直接可用）。
  function makeLogger(label) {
    const push = (level, ...a) => state.logs.push(level + '|' + label + '|' + a.map(String).join(' '))
    const logger = (...args) => {
      if (args.length === 1 && typeof args[0] === 'string') return makeLogger(args[0])
      push('info', ...args)
      return logger
    }
    logger.info = (...a) => push('info', ...a)
    logger.warn = (...a) => push('warn', ...a)
    logger.error = (...a) => push('error', ...a)
    logger.debug = (...a) => push('debug', ...a)
    return logger
  }
  const logger = makeLogger('ctx')
  const timer = {
    timeout(fn, ms) {
      if (typeof fn !== 'function') {
        // Promise 重载：timeout(ms) → Promise<void>
        return new Promise((resolve) => {
          const d = timer.timeout(resolve, fn)
          state.timerDisposers.push(d)
        })
      }
      const h = setTimeout(() => {
        try { fn() } catch (e) { uncaught.push('timer.timeout: ' + errText(e)) }
      }, ms)
      const d = () => clearTimeout(h)
      state.timerDisposers.push(d)
      return d
    },
    interval(fn, ms) {
      const h = setInterval(() => {
        try { fn() } catch (e) { uncaught.push('timer.interval: ' + errText(e)) }
      }, ms)
      const d = () => clearInterval(h)
      state.timerDisposers.push(d)
      return d
    },
    throttle(fn, ms) {
      let last = 0
      let timerId = null
      const wrapped = (...a) => {
        const now = Date.now()
        if (now - last >= ms) { last = now; fn(...a) }
        else if (timerId === null) {
          timerId = setTimeout(() => { timerId = null; last = Date.now(); fn(...a) }, ms - (now - last))
        }
      }
      wrapped.dispose = () => { if (timerId !== null) clearTimeout(timerId); timerId = null }
      return wrapped
    },
    debounce(fn, ms) {
      let timerId = null
      const wrapped = (...a) => {
        if (timerId !== null) clearTimeout(timerId)
        timerId = setTimeout(() => { timerId = null; fn(...a) }, ms)
      }
      wrapped.dispose = () => { if (timerId !== null) clearTimeout(timerId); timerId = null }
      return wrapped
    },
  }
  // fs / shell：模拟环境不提供实现，但以「异步 reject」形式暴露（而不是
  // undefined 属性），这样才能复现真实 DSH 进程中未 await 的异步错误
  // 逃逸（例如 persistStatus 的 rejected Promise 导致 fatal load failure）。
  function mockAsync(label) {
    return async () => { throw new Error('模拟环境不提供 ' + label + '（真实 DSH 进程可用）') }
  }
  const services = {
    timer,
    sessionPersistence: { list: async () => [] },
    fs: {
      resolve: mockAsync('fs.resolve'),
      readText: mockAsync('fs.readText'),
      writeText: mockAsync('fs.writeText'),
    },
    shell: {
      run: mockAsync('shell.run'),
      resolve: (o) => o,
    },
    // 工具注册表（dsh-tools 形状：register 返回 disposer）
    tools: {
      register(t) {
        state.tools.push(t)
        return () => {}
      },
    },
    // systemPrompt 服务（dsh-system-prompt 形状）
    systemPrompt: {
      section(section) {
        state.effects.push('systemPrompt.section:' + String((section && section.name) || ''))
        const disposer = () => {}
        state.effectDisposers.push(disposer)
        return disposer
      },
      context() { return () => {} },
      tools() { return () => {} },
      variable() { return () => {} },
      suppressRuntimeContext() { return () => {} },
      assemble: async () => ({}),
    },
    // commands 服务（cordis commands 形状）
    commands: {
      register() { return () => {} },
    },
    // sessionQuery 服务（dsh-session-query 只读形状）
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => null,
    },
  }
  const ctx = {
    logger,
    get: (name) => services[name],
    // ctx.reflect：cordis 4.x 的 reflection/service-resolution 层。真实 dsh
    // 运行时由 cordis 安装（ctx.reflect.get(name, required) 解析服务）；模拟
    // 环境以 services 映射等价实现，避免依赖 reflect 的插件（如 dsh-genui）
    // 在 apply 阶段因 ctx.reflect 缺失而误报崩溃。
    reflect: {
      get: (name, _required) => services[name],
      set: () => {},
      notify: () => {},
      props: {},
      store: {},
    },
    // ctx.inject(names, callback)：服务全部可用则同步执行；
    // 缺失服务时模拟 cordis 的 waiting 语义 —— 回调挂起至测试结束（不崩溃），
    // 与真实进程中「服务不存在则插件停在 waiting」一致。
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names]
      if (list.every((n) => services[n] !== undefined)) {
        const scope = {}
        for (const n of list) scope[n] = services[n]
        try { return callback(scope) } catch (e) { state.pendingInjectErrors.push(errText(e)) }
        return undefined
      }
      state.pendingInjects.push({ names: list, callback })
      return undefined
    },
    on: (name, fn) => {
      state.listeners.push([name, fn])
      // 返回真实 disposer：从监听列表移除自己（dispose 阶段只清理 disposer，
      // 绝不调用监听器函数本身 —— 事件处理器签名与 disposer 不同）。
      return () => {
        const i = state.listeners.findIndex(([n, f]) => n === name && f === fn)
        if (i >= 0) state.listeners.splice(i, 1)
      }
    },
    effect: (fn, label) => {
      state.effects.push(String(label || ''))
      let out
      try { out = fn() } catch (e) { state.effectError = e; return () => {} }
      if (out && typeof out.then === 'function') {
        out.then((v) => { if (typeof v === 'function') state.effectDisposers.push(v) })
          .catch((e) => { state.effectError = e })
      } else if (typeof out === 'function') {
        state.effectDisposers.push(out)
      }
      return () => {}
    },
    provide: () => () => {},
  }
  // inject 声明的硬依赖直接暴露为 ctx 属性（真实 cordis 行为）
  for (const key of Object.keys(services)) ctx[key] = services[key]
  ctx.timer = timer // inject: ['timer'] 场景
  return { ctx, state }
}

// ── 插件对象求值（兼容 function body 与对象字面量两种形态） ──────────────
function evalPluginSource(src, label) {
  try {
    const out = new Function(src)()
    if (out !== null && (typeof out === 'object' || typeof out === 'function')) return { ok: true, value: out }
  } catch (e) { /* fallthrough */ }
  try {
    const out = new Function('return (' + src + ')')()
    if (out !== null && (typeof out === 'object' || typeof out === 'function')) return { ok: true, value: out }
  } catch (e) {
    return { ok: false, error: e }
  }
  return { ok: false, error: new Error(label + ' 求值结果既不是对象也不是函数（插件必须返回 { name?, inject?, apply } 形状）') }
}

// ── 插件形状检查 ──────────────────────────────────────────────────────────
function shapeIssues(plugin, label) {
  const issues = []
  if (!plugin || typeof plugin !== 'object') { issues.push(label + ': 插件对象为空') }
  if (!plugin || typeof plugin.apply !== 'function') issues.push(label + ': apply 不是函数（缺少启动入口）')
  if (plugin && plugin.inject !== undefined && !Array.isArray(plugin.inject)) issues.push(label + ': inject 不是数组')
  if (plugin && plugin.name !== undefined && typeof plugin.name !== 'string') issues.push(label + ': name 不是字符串')
  return issues
}

// ── 入口自动解析：exports['.'] → main → 常见路径探测 ─────────────────────
const ENTRY_PROBES = [
  'dist/index.js', 'lib/index.js', 'src/index.js', 'index.js',
  'dist/index.mjs', 'lib/index.mjs', 'dist/index.cjs', 'lib/index.cjs',
  'dist/main.js', 'lib/main.js', 'dsh/index.js', 'dist/main.mjs',
]
function resolveEntry(pkgDir, pkg) {
  if (pkg && pkg.exports) {
    const root = pkg.exports['.']
    if (typeof root === 'string') return normRel(root)
    if (root && typeof root === 'object') {
      for (const key of ['import', 'default', 'require', 'node']) {
        const v = root[key]
        if (typeof v === 'string') return normRel(v)
        if (v && typeof v === 'object' && typeof v.default === 'string') return normRel(v.default)
      }
    }
  }
  if (pkg && typeof pkg.main === 'string' && pkg.main) return normRel(pkg.main)
  for (const probe of ENTRY_PROBES) {
    if (existsSync(join(pkgDir, probe))) return probe
  }
  return 'lib/index.js'
}

// ── 插件包名推导 ──────────────────────────────────────────────────────────
function derivePackageName(pluginDir) {
  const norm = normRel(pluginDir).replace(/\/+$/, '')
  const marker = '/node_modules/'
  const idx = norm.lastIndexOf(marker)
  if (idx >= 0) {
    const rest = norm.slice(idx + marker.length)
    if (rest.length > 0) return rest.split('/').slice(0, 2).join('/')
  }
  return basename(pluginDir)
}

// ── 插件类型判定（报告用） ────────────────────────────────────────────────
function classifyPlugin(pluginDir) {
  const norm = normRel(pluginDir)
  const p = String(params.profileDir || join(homedir(), '.dsh/profiles/web'))
  if (norm.includes('/node_modules/')) return 'npm'
  if (norm.startsWith(p + '/plugins/')) return 'filesystem'
  return 'directory'
}

// ── 依赖布局：把某 node_modules 根下的全部直接子项 symlink 进 simNM ─────
// @scope 目录递归一层；已存在的目标跳过（先布局的优先，调用方按优先级排序）。
function linkNodeModulesRoot(simNM, root, skipped) {
  if (!existsSync(root)) return
  for (const child of readdirSync(root)) {
    const src = join(root, child)
    if (!existsSync(src)) continue
    if (child.startsWith('@')) {
      // scoped：@scope/pkg
      if (!statSync(src).isDirectory()) continue
      for (const sub of readdirSync(src)) {
        const subSrc = join(src, sub)
        const dst = join(simNM, child, sub)
        if (!existsSync(dst) && existsSync(subSrc)) {
          try {
            mkdirSync(join(simNM, child), { recursive: true })
            symlinkSync(subSrc, dst, 'dir')
          } catch (e) { skipped.push(child + '/' + sub + ': ' + e.message) }
        }
      }
      continue
    }
    const dst = join(simNM, child)
    if (!existsSync(dst) && statSync(src).isDirectory()) {
      try { symlinkSync(src, dst, 'dir') } catch (e) { skipped.push(child + ': ' + e.message) }
    }
  }
}

// ── module 模式：构造临时 node_modules 布局（symlink 复刻真实解析） ───────
// 注意：引擎自身必须位于 simRoot 内运行（调用方把 engine.mjs/params.json
// 放进同一目录），裸包名 import（含打桩）才能从 simRoot/node_modules 解析。
async function buildModuleLayout(pluginDir) {
  const simRoot = String(params.simRoot || '')
  const base = simRoot.length > 0 ? simRoot : mkdtempSync(join(tmpdir(), 'sim-restart-'))
  const simNM = join(base, 'node_modules')
  mkdirSync(join(simNM, '@deepseek-ai'), { recursive: true })

  let pkgName = String(params.packageName || '')
  let entry = String(params.entry || '')
  const pkgPath = join(pluginDir, 'package.json')
  let pkg = null
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (!pkgName && typeof pkg.name === 'string') pkgName = pkg.name
    } catch (e) { /* 忽略损坏的 package.json */ }
  }
  if (!pkgName) pkgName = derivePackageName(pluginDir)
  if (!entry) entry = resolveEntry(pluginDir, pkg)
  if (!pkgName) throw new Error('无法确定插件包名：pluginDir 缺少可读 package.json 且未传 packageName')

  check('入口解析（exports/main/探测）', true,
    'entry=' + entry + ' pkg=' + pkgName + ' 类型=' + classifyPlugin(pluginDir))

  const profileDir = String(params.profileDir || join(homedir(), '.dsh/profiles/web'))
  const profileNM = join(profileDir, 'node_modules')
  const pluginsDir = join(profileDir, 'plugins')
  const depsRoot = String(params.depsRoot || '/usr/local/lib/node_modules')
  const dshNM = join(depsRoot, '@deepseek-ai/dsh/node_modules')

  const skipped = []
  // 优先级从低到高布局：dsh 内置依赖 → 全局依赖 → profile 依赖/本地插件 → 被测插件自身
  linkNodeModulesRoot(simNM, dshNM, skipped)
  linkNodeModulesRoot(simNM, depsRoot, skipped)
  linkNodeModulesRoot(simNM, profileNM, skipped)
  // 本地文件插件（plugins/ 下每个子目录）以裸包名可被 import
  if (existsSync(pluginsDir)) {
    for (const child of readdirSync(pluginsDir)) {
      const src = join(pluginsDir, child)
      const dst = join(simNM, child)
      if (!existsSync(dst) && statSync(src).isDirectory()) {
        try { symlinkSync(src, dst, 'dir') } catch (e) { skipped.push('plugins/' + child + ': ' + e.message) }
      }
    }
  }
  // 被测插件自身：优先指向真实 pluginDir（npm 插件已在 profileNM 布局中覆盖）
  if (!existsSync(join(simNM, pkgName))) {
    try {
      mkdirSync(join(simNM, dirname(pkgName)), { recursive: true })
      symlinkSync(pluginDir, join(simNM, pkgName), 'dir')
    } catch (e) { skipped.push('self ' + pkgName + ': ' + e.message) }
  }
  if (skipped.length > 0) {
    check('依赖布局 symlink', true, '跳过 ' + skipped.length + ' 项（已存在或失败）：' + skipped.slice(0, 5).join('、'))
  }
  return { simRoot: base, simNM, pkgName, entry }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const { ctx, state } = makeSimCtx()
let plugin = null
let moduleCleanup = null

if (mode === 'source') {
  // 阶段 1：源码求值（模拟重启时的模块求值）
  if (typeof params.hostSource !== 'string' || params.hostSource.length === 0) {
    check('Host 源码求值', false, 'source 模式必须提供 hostSource（用 cordis_inspect_self 取源码原文）')
  } else {
    const ev = evalPluginSource(params.hostSource, 'host 半边')
    check('Host 源码求值（重启时模块求值）', ev.ok, ev.ok ? '' : errText(ev.error))
    plugin = ev.ok ? ev.value : null
  }
  // 阶段 2：形状检查（host）
  if (plugin) {
    const issues = shapeIssues(plugin, 'host 半边')
    check('插件形状（apply/inject/name）', issues.length === 0, issues.join('；'))
  }
  // Client 半边：只求值 + 形状检查（浏览器环境才执行 apply）
  if (typeof params.clientSource === 'string' && params.clientSource.length > 0) {
    const evc = evalPluginSource(params.clientSource, 'client 半边')
    check('Client 源码求值', evc.ok, evc.ok ? '' : errText(evc.error))
    if (evc.ok) {
      const issues = shapeIssues(evc.value, 'client 半边')
      check('Client 插件形状', issues.length === 0, issues.join('；'))
    }
  }
} else {
  // module 模式
  let layoutError = null
  let mod = null
  try {
    const layout = await buildModuleLayout(params.pluginDir)
    moduleCleanup = layout.simRoot
    // 打桩：避免插件在模拟中连接外部服务（如飞书）
    for (const s of (Array.isArray(params.stubs) ? params.stubs : [])) {
      try {
        const stubMod = await import(s.module)
        const target = stubMod[s.export]
        if (target && target.prototype && typeof target.prototype[s.method] === 'function') {
          target.prototype[s.method] = async function stubMethod() {
            console.log('[stub] ' + s.export + '#' + s.method + ' 已打桩：跳过真实外部连接')
          }
        }
      } catch (e) {
        layoutError = new Error('打桩失败 ' + JSON.stringify(s) + ': ' + errText(e))
        break
      }
    }
    if (!layoutError) {
      const entryUrl = pathToFileURL(join(layout.simNM, layout.pkgName, layout.entry)).href
      mod = await import(entryUrl)
    }
  } catch (e) {
    layoutError = e
  }
  check('真实 ESM 模块加载（重启时模块求值）', !layoutError, layoutError ? errText(layoutError) : '')
  if (mod) {
    plugin = (mod.default && typeof mod.default === 'object') ? mod.default : mod
    const issues = shapeIssues(plugin, '插件模块')
    check('插件形状（name/inject/apply）', issues.length === 0, issues.join('；'))
  }
}

// 残留基线采样：在 apply 之前（import/求值之后）
const resourcesBefore = process.getActiveResourcesInfo()

// ── apply 启动冒烟 ────────────────────────────────────────────────────────
let applyError = null
if (plugin && typeof plugin.apply === 'function') {
  let cfg = { cwd: moduleCleanup || tmpdir() }
  if (typeof params.extraConfig === 'string' && params.extraConfig.length > 0) {
    try { Object.assign(cfg, JSON.parse(params.extraConfig)) } catch (e) { check('extraConfig 解析', false, errText(e)) }
  }
  try {
    // 复刻 cordis 加载插件时的 config 处理：插件导出的 Config（z 对象，
    // standard-schema 协议）或 config/schema（schemastery）先做默认值补全，
    // 再传给 apply（如 tool-github 的 timeoutMs 默认 30000 —— 缺了它 apply 即崩）。
    if (plugin.Config && plugin.Config['~standard'] && typeof plugin.Config['~standard'].validate === 'function') {
      try {
        const res = plugin.Config['~standard'].validate(cfg)
        if (res && res.issues && res.issues.length) {
          check('config schema 补全', false, 'Config 校验失败：' + JSON.stringify(res.issues).slice(0, 400))
        } else if (res && res.value && typeof res.value === 'object') {
          cfg = res.value
        }
      } catch (e) { check('config schema 补全', false, errText(e)) }
    } else {
      const schema = plugin.schema || plugin.config
      if (schema && typeof schema.validate === 'function') {
        try {
          const validated = schema.validate(cfg)
          if (validated !== null && typeof validated === 'object') cfg = validated
        } catch (e) { check('config schema 补全', false, errText(e)) }
      }
    }
    const applied = await plugin.apply(ctx, cfg)
    if (typeof applied === 'function') state.effectDisposers.push(applied)
    else if (applied && typeof applied.dispose === 'function') state.effectDisposers.push(() => applied.dispose())
  } catch (e) {
    applyError = e
  }
  check('apply 启动无异常', !applyError && !state.effectError,
    applyError ? errText(applyError) : (state.effectError ? errText(state.effectError) : ''))
} else if (plugin !== null) {
  check('apply 启动无异常', false, '插件对象缺少 apply 函数，无法启动')
}

// ── 运行冒烟：等待 smokeMs，期间任何未处理异常/拒绝即 FAIL ──────────────
if (!applyError) {
  await sleep(smokeMs)
}
check('运行冒烟无未处理异常', uncaught.length === 0, uncaught.join('\n') || '')

// ── dispose 清理（模拟 Cordis 卸载：插件注册的 disposer + ctx 销毁） ──────
const disposeErrors = []
for (const d of state.effectDisposers) {
  try {
    const r = d()
    if (r && typeof r.then === 'function') await r
  } catch (e) { disposeErrors.push(errText(e)) }
}
for (const d of state.timerDisposers) {
  try { d() } catch (e) { disposeErrors.push('timer 清理: ' + errText(e)) }
}
// 事件监听器由 ctx.on 返回的 disposer 管理（插件自行或 cordis 自动调用）；
// 此处绝不调用监听器函数本身（事件处理器签名与 disposer 不同）。
check('dispose 清理无异常', disposeErrors.length === 0, disposeErrors.join('\n'))

// ── 残留句柄检测：dispose 后资源应回到基线（无新增 Timeout） ─────────────
await sleep(200)
const resourcesAfter = process.getActiveResourcesInfo()
const countType = (arr, t) => arr.filter((x) => x === t).length
const tBefore = countType(resourcesBefore, 'Timeout')
const tAfter = countType(resourcesAfter, 'Timeout')
const leakedTimeouts = Math.max(0, tAfter - tBefore)
check('无定时器/句柄残留（dispose 完整）', leakedTimeouts === 0,
  leakedTimeouts > 0 ? '检测到 ' + leakedTimeouts + ' 个未清理的 Timeout 句柄（真实重启时进程会挂住）' : '')

// ── 结果输出：同步落盘 result.json（权威），stdout 仅辅助 ────────────────
// 注意：此处之后绝不创建任何定时器/句柄、绝不主动 process.exit ——
// 引擎必须「自然退出」。若插件 dispose 不完整留下全局定时器/句柄，
// 进程将无法退出，由调用方（工具的 shell 超时）判定 FAIL：
// 这正是「模拟真实重启会挂死」的判据。
const result = {
  ok: failures === 0 && uncaught.length === 0 && disposeErrors.length === 0 && leakedTimeouts === 0
    && state.pendingInjectErrors.length === 0,
  mode,
  name: displayName,
  round: Number(params.round || 1),
  stages,
  uncaught,
  disposeErrors,
  leakedTimeouts,
  watchdog: '',
  waitingServices: state.pendingInjects.map((i) => i.names.join(',')),
  logsTail: state.logs.slice(-20),
}
writeFileSync(outPath, JSON.stringify(result))
console.log('__SIM_RESULT__:' + JSON.stringify(result))
