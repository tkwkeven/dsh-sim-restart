/**
 * dsh-sim-restart —— 模拟重启测试插件（开源版，原名 dsh-lark-sim-restart）
 *
 * 在隔离子进程中模拟插件「进程重启 → 模块求值 → 插件形状 → apply 启动 →
 * 冒烟运行 → dispose 清理 → 进程退出」全流程，检测插件重启后是否会崩溃或
 * 挂死；不会实际重启 DSH 进程。
 *
 * 特性：
 *   1. 插件类型全覆盖：动态插件（source）、文件系统插件（plugins/）、npm 插件
 *      （node_modules/，含 @scope）、任意目录插件（module，自动识别）；
 *      引擎自动解析入口（exports/main/常见路径）并布局依赖
 *      （profile node_modules + 全局 + dsh 内置 + plugins/）。
 *   2. 自动触发：常驻 watcher 监控插件安装/修改/去除（plugins/ 目录、启用的
 *      npm 插件包、配置文件 package.json/pnpm-workspace/pnpm-lock/
 *      cordis.yml/cordis.patch.yml），变化后自动模拟重启测试（防抖 + 串行队列）。
 *   3. 打回闭环：测试失败通过 systemPrompt 注入精确诊断（agent 下一轮可见），
 *      修复后 watcher 自动重测，直至全部通过。
 *   4. 全量工具：simulate_plugin_restart（单插件手动测试）、
 *      simulate_plugin_restart_auto（全量扫描已启用插件逐个测试）、
 *      sim_restart_auto_status（查询自动监控状态与最近结果）。
 *   5. 真实配置传递：自动测试从 patch 层（bundle 包内 + profile）收集每个
 *      插件的 config（含 !!js 表达式在宿主求值），复刻 cordis 的 schema 补全。
 *
 * 引擎（sim-restart-engine.mjs）随包分发：lib/engine.mjs（推荐，零外部依赖），
 * 每次调用重新读取（开发期改引擎无需重启插件）；兼容旧部署的
 * ~/.dsh/var/sim-restart/engine.mjs 兜底。
 *
 * 配置（cordis.patch.yml 的 config）：
 *   watchEnabled   是否启用常驻自动监控（默认 true）
 *   pollMs         监控轮询间隔毫秒（默认 2000）
 *   debounceMs     变化后防抖毫秒（默认 2500）
 *   rounds / smokeMs  自动测试默认轮数与冒烟时长
 *   profileDir     目标 DSH profile 根目录（默认 ~/.dsh/profiles/web；开源版
 *                  用 config.profileDir 显式指定任意 profile）
 *   stubsMap       插件名 → 打桩列表（外部连接，如 deepseek-harness-lark）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createRequire } from 'node:module'

export const name = 'dsh-sim-restart'

export const inject = ['shell', 'fs', 'timer', 'systemPrompt']

const HOME = homedir()
// 引擎随包分发（lib/engine.mjs）；以下为兼容旧部署的兜底位置。
const ENGINE_REL = '/.dsh/var/sim-restart/engine.mjs'
const STATUS_REL = '/.dsh/var/sim-restart/auto-status.json'
const BUNDLED_ENGINE = new URL('./engine.mjs', import.meta.url).pathname

// ── js-yaml 加载（dsh 安装目录内置；找不到则自动功能降级） ────────────────
const require = createRequire(import.meta.url)
let yamlPkg = null
try {
  yamlPkg = require('js-yaml')
} catch (e) {
  try {
    yamlPkg = require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/js-yaml/index.js')
  } catch (e2) {
    yamlPkg = null
  }
}

// dsh patch 的 !!js 表达式 tag：解析为 { __jsExpr: expr }（与 dsh loader 兼容）
let parsePatchYaml = null
if (yamlPkg) {
  const JsExprType = new yamlPkg.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  })
  const DSH_YAML_SCHEMA = new yamlPkg.Schema({
    implicit: yamlPkg.DEFAULT_SCHEMA.implicit,
    explicit: yamlPkg.DEFAULT_SCHEMA.explicit.concat([JsExprType]),
  })
  parsePatchYaml = (text) => yamlPkg.load(text, { schema: DSH_YAML_SCHEMA })
}

export function apply(ctx, config) {
  const cfg = config || {}
  const watchEnabled = cfg.watchEnabled !== false
  const pollMs = Math.max(500, Math.floor(Number(cfg.pollMs) || 2000))
  const debounceMs = Math.max(500, Math.floor(Number(cfg.debounceMs) || 2500))
  const autoRounds = Math.min(4, Math.max(1, Math.floor(Number(cfg.rounds) || 2)))
  const autoSmokeMs = Math.max(300, Math.floor(Number(cfg.smokeMs) || 800))
  const stubsMap = cfg.stubsMap && typeof cfg.stubsMap === 'object' ? cfg.stubsMap : {
    'deepseek-harness-lark': [{ module: 'deepseek-harness-lark', export: 'LarkHarnessBridge', method: 'start' }],
    'dsh-lark': [{ module: 'deepseek-harness-lark', export: 'LarkHarnessBridge', method: 'start' }],
  }

  const joinP = (base, file) => (base.endsWith('/') ? base : base + '/') + file
  // 目标 profile 根：config.profileDir 优先（开源版可指向任意 profile），
  // 缺省回落到 ~/.dsh/profiles/web（历史默认）。
  const profileDir = cfg.profileDir && typeof cfg.profileDir === 'string'
    ? String(cfg.profileDir).replace(/\/+$/, '')
    : HOME + '/.dsh/profiles/web'
  const pluginsDir = join(profileDir, 'plugins')
  const nmDir = join(profileDir, 'node_modules')
  const configFiles = [
    join(profileDir, 'package.json'),
    join(profileDir, 'pnpm-workspace.yaml'),
    join(profileDir, 'pnpm-lock.yaml'),
    join(profileDir, 'cordis.yml'),
    join(profileDir, 'cordis.patch.yml'),
  ]

  const last = { at: 0, ok: null, name: '', mode: '', rounds: 0 }
  const auto = {
    enabled: watchEnabled,
    yamlAvailable: parsePatchYaml !== null,
    watching: { pluginsDir, nmDir, configFiles },
    lastScanAt: 0,
    lastChangeAt: 0,
    lastScanError: '',
    pending: [],
    running: false,
    results: {}, // pkg -> { ok, at, mode, roundsAttempted, rounds, summary, failStages, waitingServices, error }
    removed: [],
    reportActive: false,
  }

  // ── 文件/目录辅助（走 ctx.fs 或 shell，均可用） ─────────────────────────
  function readFileText(p) {
    return require('node:fs').readFileSync(p, 'utf8')
  }
  function existsPath(p) {
    try { return require('node:fs').existsSync(p) } catch (e) { return false }
  }
  function isDir(p) {
    try { return require('node:fs').statSync(p).isDirectory() } catch (e) { return false }
  }
  function listDir(p) {
    try { return require('node:fs').readdirSync(p) } catch (e) { return [] }
  }

  async function sh(cmd, opts) {
    const res = await ctx.shell.run(ctx.shell.resolve({
      command: cmd,
      timeoutMs: (opts && opts.timeoutMs) || 20000,
      workdir: (opts && opts.workdir) || undefined,
    }))
    return String((res.stdout && res.stdout.text) || '')
  }

  // ── 工具注册辅助 ────────────────────────────────────────────────────────
  function registerTool(tool) {
    const toolsService = ctx.get('tools')
    if (toolsService === undefined) {
      ctx.logger.warn('[dsh-sim-restart] tools service unavailable, tool not registered')
      return
    }
    const disposer = toolsService.register(tool)
    ctx.effect(() => () => disposer())
  }

  // ── patch 行收集：bundle 包内 patch → profile 层（后者覆盖） ────────────
  function isJsExpr(v) { return v !== null && typeof v === 'object' && typeof v.__jsExpr === 'string' }
  function evalJsExpr(v) {
    try { return new Function('ctx', 'expr', 'return eval(expr)')({ process }, v.__jsExpr) } catch (e) { return undefined }
  }
  function walkConfig(obj) {
    if (Array.isArray(obj)) {
      const out = []
      for (const v of obj) {
        if (isJsExpr(v)) { const ev = evalJsExpr(v); if (ev !== undefined) out.push(walkConfig(ev)) }
        else out.push(walkConfig(v))
      }
      return out
    }
    if (obj && typeof obj === 'object' && !isJsExpr(obj)) {
      const out = {}
      for (const [k, v] of Object.entries(obj)) {
        if (isJsExpr(v)) { const ev = evalJsExpr(v); if (ev !== undefined) out[k] = walkConfig(ev) }
        else out[k] = walkConfig(v)
      }
      return out
    }
    return obj
  }
  function collectRows() {
    const configs = new Map()
    const disabled = new Set()
    const idToName = new Map()
    const names = new Set() // 所有 insert 行的包名（无论有无 config，缺 config 的插件也要进测试清单）
    const applyDoc = (f) => {
      if (!existsPath(f) || !parsePatchYaml) return
      try {
        const doc = parsePatchYaml(readFileText(f))
        if (!Array.isArray(doc)) return
        for (const entry of doc) {
          if (!entry || typeof entry !== 'object') continue
          for (const ins of Array.isArray(entry.insert) ? entry.insert : []) {
            if (!ins || typeof ins.name !== 'string') continue
            names.add(ins.name)
            if (ins.id) idToName.set(ins.id, ins.name)
            if (ins.disabled !== undefined) {
              const dv = isJsExpr(ins.disabled) ? evalJsExpr(ins.disabled) : ins.disabled
              if (dv === true) disabled.add(ins.name); else disabled.delete(ins.name)
            }
            if (ins.config !== undefined) configs.set(ins.name, walkConfig(ins.config))
          }
          if (entry.id && !Array.isArray(entry.insert)) {
            const nm = idToName.get(entry.id) || String(entry.id)
            names.add(nm)
            if (entry.disabled !== undefined) {
              const dv = isJsExpr(entry.disabled) ? evalJsExpr(entry.disabled) : entry.disabled
              if (dv === true) disabled.add(nm); else disabled.delete(nm)
            }
            if (entry.config !== undefined) configs.set(nm, walkConfig(entry.config))
          }
        }
      } catch (e) { /* 单个 patch 解析失败不影响其它 */ }
    }
    // bundle 层：node_modules 顶层与 @scope 下所有含 patch 的包
    for (const child of listDir(nmDir)) {
      const dir = join(nmDir, child)
      if (!isDir(dir)) continue
      const cands = child.startsWith('@') ? listDir(dir).map((s) => join(dir, s)) : [dir]
      for (const p of cands) {
        const pkgFile = join(p, 'package.json')
        if (!existsPath(pkgFile)) continue
        let hasPatch = false
        try {
          const pkg = JSON.parse(readFileText(pkgFile))
          hasPatch = !!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) || existsPath(join(p, 'cordis.patch.yml'))
        } catch (e) { /* ignore */ }
        if (hasPatch && existsPath(join(p, 'cordis.patch.yml'))) applyDoc(join(p, 'cordis.patch.yml'))
      }
    }
    applyDoc(join(profileDir, 'cordis.patch.yml'))
    applyDoc(join(profileDir, 'cordis.yml'))
    return { configs, disabled, names }
  }

  // ── 已启用插件清单：plugins/ + 未 disabled 的 patch 行 + bundles 非内置 ─
  function scanInventory() {
    const inventory = new Map() // name -> pluginDir
    let rows = { configs: new Map(), disabled: new Set() }
    if (parsePatchYaml) {
      try { rows = collectRows() } catch (e) { /* ignore */ }
    }
    for (const child of listDir(pluginsDir)) {
      const dir = join(pluginsDir, child)
      if (isDir(dir)) inventory.set(child, dir)
    }
    if (parsePatchYaml) {
      // 遍历所有 patch 行（含无 config 的插件，避免漏测）
      for (const nm of [...(rows.names || rows.configs.keys())]) {
        if (rows.disabled.has(nm)) continue
        if (!inventory.has(nm)) {
          const dir = join(nmDir, nm)
          if (existsPath(dir)) inventory.set(nm, dir)
        }
      }
    }
    try {
      const pkg = JSON.parse(readFileText(join(profileDir, 'package.json')))
      for (const b of (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []) {
        if (typeof b !== 'string') continue
        if (b.startsWith('@deepseek-ai/dsh-')) continue
        if (rows.disabled.has(b)) continue
        if (!inventory.has(b)) {
          const dir = join(nmDir, b)
          if (existsPath(dir)) inventory.set(b, dir)
        }
      }
    } catch (e) { /* ignore */ }
    return { inventory, rows }
  }

  // ── 引擎执行（公共：手动工具与自动 watcher 共用） ───────────────────────
  async function getEngineSource() {
    // 优先包内引擎（lib/engine.mjs，随包分发，零外部部署）；失败则回退到
    // 旧部署位置 ~/.dsh/var/sim-restart/engine.mjs（兼容历史环境）。
    try {
      return readFileText(BUNDLED_ENGINE)
    } catch (e) { /* fall through to legacy location */ }
    const target = await ctx.fs.resolve(HOME + ENGINE_REL)
    return ctx.fs.readText(target)
  }
  function findResultLine(out) {
    const lines = String(out).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith('__SIM_RESULT__:')) {
        try { return JSON.parse(line.slice(15)) } catch (e) { /* ignore */ }
      }
    }
    return null
  }
  async function readResultJson(dir) {
    try {
      const t = await ctx.fs.resolve(joinP(dir, 'params.result.json'))
      return JSON.parse(await ctx.fs.readText(t))
    } catch (e) { return null }
  }

  /** 跑一轮引擎；返回归一化单轮结果。 */
  async function runEngineOnce(engineText, params) {
    let dir = ''
    try {
      const mk = await sh('mktemp -d /tmp/sim-restart.XXXXXX 2>/dev/null || mktemp -d')
      dir = String(mk).trim()
      if (!dir) throw new Error('mktemp 未返回目录路径')
    } catch (e) {
      return { ok: false, error: '无法创建临时目录：' + e.message }
    }
    try {
      await ctx.fs.writeText(await ctx.fs.resolve(joinP(dir, 'engine.mjs')), engineText)
      const paramsTarget = await ctx.fs.resolve(joinP(dir, 'params.json'))
      await ctx.fs.writeText(paramsTarget, JSON.stringify(params))
      let runRes
      try {
        runRes = await ctx.shell.run(ctx.shell.resolve({
          command: 'node engine.mjs params.json',
          workdir: dir,
          timeoutMs: (Number(params.smokeMs) || 1200) + 30000,
        }))
      } catch (e) {
        return { ok: false, error: 'shell 执行失败：' + e.message }
      }
      let parsed = await readResultJson(dir)
      if (!parsed) {
        const out = String((runRes.stdout && runRes.stdout.text) || '') + '\n' + String((runRes.stderr && runRes.stderr.text) || '')
        parsed = findResultLine(out)
      }
      const hung = runRes.timedOut === true || runRes.exitCode === null
      if (parsed) {
        parsed.hung = hung
        if (hung) parsed.ok = false
      } else {
        parsed = {
          ok: false,
          error: '未解析到测试结果' + (hung ? '（进程超时未退出：残留句柄，模拟真实重启会挂死）' : '（引擎未输出 result.json）'),
        }
      }
      return {
        round: Number(params.round || 1),
        ok: parsed.ok === true,
        stages: parsed.stages || [],
        uncaught: parsed.uncaught || [],
        disposeErrors: parsed.disposeErrors || [],
        leakedTimeouts: parsed.leakedTimeouts || 0,
        hung,
        error: parsed.error || '',
        waitingServices: parsed.waitingServices || [],
        logsTail: (parsed.logsTail || []).slice(-8),
      }
    } catch (e) {
      return { round: Number(params.round || 1), ok: false, error: '测试执行异常：' + e.message }
    } finally {
      try { await sh('rm -rf ' + dir) } catch (e) { /* 清理失败不致命 */ }
    }
  }

  /** module 模式多轮测试（自动识别入口/类型/布局，自动附带 patch config）。 */
  async function runModuleTest(target, opts) {
    opts = opts || {}
    const rounds = Math.min(10, Math.max(1, Math.floor(Number(opts.rounds) || 3)))
    const smokeMs = Math.max(200, Math.floor(Number(opts.smokeMs) || 1200))
    let engineText
    try {
      engineText = await getEngineSource()
    } catch (e) {
      return { ok: false, name: target.name, mode: 'module', rounds, roundsAttempted: 0, errors: ['无法读取测试引擎 ' + ENGINE_REL + '：' + e.message], results: [] }
    }
    let depsRoot = ''
    try {
      const probe = "node -e \"const fs=require('node:fs');const p=require('node:child_process');let g='/usr/local/lib/node_modules';try{g=p.execSync('npm root -g',{encoding:'utf8'}).trim()}catch(e){}const c=g+'/@deepseek-ai/dsh/node_modules';console.log(fs.existsSync(c)?c:g)\""
      depsRoot = String(await sh(probe, { timeoutMs: 15000 })).trim() || '/usr/local/lib/node_modules'
    } catch (e) {
      depsRoot = '/usr/local/lib/node_modules'
    }
    const results = []
    let finalOk = true
    for (let round = 1; round <= rounds; round++) {
      const params = {
        mode: 'module',
        name: target.name,
        round,
        smokeMs,
        simRoot: '',
        hostSource: '',
        clientSource: '',
        pluginDir: target.pluginDir,
        entry: String(target.entry || ''),
        packageName: String(target.packageName || ''),
        profileDir,
        depsRoot,
        stubs: opts.stubs || [],
        extraConfig: JSON.stringify(target.config || {}),
      }
      const r = await runEngineOnce(engineText, params)
      results.push(r)
      if (!r.ok) { finalOk = false; break }
    }
    const summary = summarizeResults(results)
    return { ok: finalOk, name: target.name, mode: 'module', rounds, roundsAttempted: results.length, errors: [], results, summary }
  }

  function summarizeResults(results) {
    const fails = results.filter((r) => !r.ok)
    if (fails.length === 0) return '全部 ' + results.length + ' 轮模拟重启均通过'
    const f = fails[0]
    const bad = (f.stages || []).filter((s) => !s.ok).map((s) => s.name).join('、')
    return '第 ' + f.round + ' 轮失败' + (bad ? '（' + bad + '）' : '') + (f.hung ? '；进程超时未退出（残留句柄）' : '') + (f.error ? '；' + f.error.slice(0, 200) : '')
  }

  function summarizeForResult(r) {
    return {
      ok: r.ok,
      name: r.name || '',
      mode: r.mode || '',
      roundsAttempted: r.roundsAttempted || 0,
      rounds: r.rounds || 0,
      summary: r.summary || '',
      results: (r.results || []).map((x) => ({
        round: x.round,
        ok: x.ok,
        stages: x.stages || [],
        uncaught: x.uncaught || [],
        disposeErrors: x.disposeErrors || [],
        leakedTimeouts: x.leakedTimeouts || 0,
        hung: !!x.hung,
        error: x.error || '',
        waitingServices: x.waitingServices || [],
        logsTail: x.logsTail || [],
      })),
      errors: r.errors || [],
    }
  }

  // ── 自动 watcher：快照签名 + 防抖 + 串行队列 ─────────────────────────────
  const SIG_SCRIPT = [
    "const fs=require('node:fs');",
    "const [pluginsDir,nmDir,pkgList,cfgList]=JSON.parse(process.argv[1]);",
    "const out={plugins:{},packages:{},config:{}};",
    "function dirSig(d){let c=0,p=[];try{const w=x=>{for(const e of fs.readdirSync(x,{withFileTypes:true})){const n=e.name;if(n==='node_modules'||n==='.git')continue;const f=x+'/'+n;if(e.isDirectory())w(f);else{const s=fs.statSync(f);c++;p.push(f.slice(d.length+1)+':'+s.size+':'+Math.round(s.mtimeMs))}}};w(d);p.sort()}catch(e){return 'ERR:'+(e.code||e.message)}return c+':'+p.join('|')}",
    "for(const n of fs.readdirSync(pluginsDir)){out.plugins[n]=dirSig(pluginsDir+'/'+n)}",
    "for(const p of pkgList){out.packages[p]=dirSig(nmDir+'/'+p)}",
    "for(const f of cfgList){try{const s=fs.statSync(f);out.config[f]=s.size+':'+Math.round(s.mtimeMs)}catch(e){out.config[f]='MISSING'}}",
    "process.stdout.write(JSON.stringify(out));",
  ].join('')

  function quoteArg(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }

  async function snapshotSig() {
    const { inventory } = scanInventory()
    const pkgList = [...inventory.keys()]
    const args = JSON.stringify([pluginsDir, nmDir, pkgList, configFiles])
    const out = await sh("node -e " + quoteArg(SIG_SCRIPT) + ' ' + quoteArg(args), { timeoutMs: 20000 })
    return { sig: out, pkgList }
  }

  function diffSig(oldSig, newSig) {
    const changed = { plugins: [], packages: [], config: false }
    if (!oldSig) return changed
    let o, n
    try { o = JSON.parse(oldSig); n = JSON.parse(newSig) } catch (e) { return { plugins: [], packages: [], config: true } }
    const allPlugins = new Set([...Object.keys(o.plugins || {}), ...Object.keys(n.plugins || {})])
    for (const k of allPlugins) {
      if (String(o.plugins && o.plugins[k]) !== String(n.plugins && n.plugins[k])) changed.plugins.push(k)
    }
    const allPkgs = new Set([...Object.keys(o.packages || {}), ...Object.keys(n.packages || {})])
    for (const k of allPkgs) {
      if (String(o.packages && o.packages[k]) !== String(n.packages && n.packages[k])) changed.packages.push(k)
    }
    if (JSON.stringify(o.config || {}) !== JSON.stringify(n.config || {})) changed.config = true
    return changed
  }

  function persistStatus() {
    // 注意：ctx.fs 的方法都是 async（Promise）。必须 await 并把整个调用链放进
    // try/catch —— 否则 rejected Promise 会逃逸到 watcher 队列，导致插件
    // fiber 失败 → fatal load failure → 整个 DSH 进程崩溃（真实事故教训）。
    return (async () => {
      try {
        const slim = {
          enabled: auto.enabled,
          yamlAvailable: auto.yamlAvailable,
          watching: auto.watching,
          lastScanAt: auto.lastScanAt,
          lastChangeAt: auto.lastChangeAt,
          lastScanError: auto.lastScanError,
          pending: [...auto.pending],
          running: auto.running,
          removed: auto.removed.slice(-10),
          reportActive: auto.reportActive,
          results: Object.fromEntries(Object.entries(auto.results).map(([k, v]) => [k, {
            ok: v.ok, at: v.at, mode: v.mode, roundsAttempted: v.roundsAttempted, rounds: v.rounds,
            summary: v.summary, failStages: v.failStages, waitingServices: v.waitingServices, error: v.error,
          }])),
        }
        const target = await ctx.fs.resolve(HOME + STATUS_REL)
        await ctx.fs.writeText(target, JSON.stringify(slim, null, 2))
      } catch (e) {
        ctx.logger.warn('[dsh-sim-restart] 状态写盘失败（忽略）：' + e.message)
      }
    })()
  }

  // systemPrompt 打回报告：有失败注入诊断，全部通过后移除
  let reportDisposer = null
  function buildReportText() {
    const fails = Object.values(auto.results).filter((r) => !r.ok)
    if (fails.length === 0) return ''
    const lines = fails.map((r) => '  - ' + r.name + '（' + (r.mode || 'module') + '）：' + (r.summary || r.error || '未知失败'))
    return '⚠️ 自动模拟重启测试（simulate_plugin_restart，未实际重启 DSH）发现插件崩溃/挂死风险，请立即修复：\n'
      + lines.join('\n')
      + '\n修复后保存文件，watcher 会自动重新测试直至通过；用 sim_restart_auto_status 查询详情与最新状态。'
  }
  function updateReport() {
    const text = buildReportText()
    if (text && !reportDisposer) {
      try {
        reportDisposer = ctx.systemPrompt.section({
          name: 'sim-restart:auto-report',
          order: 980,
          text: () => buildReportText(),
        })
        auto.reportActive = true
      } catch (e) {
        ctx.logger.warn('[dsh-sim-restart] report section failed: ' + e.message)
      }
    } else if (!text && reportDisposer) {
      try { reportDisposer() } catch (e) { /* ignore */ }
      reportDisposer = null
      auto.reportActive = false
    }
  }
  ctx.effect(() => () => {
    if (reportDisposer) {
      try { reportDisposer() } catch (e) { /* ignore */ }
      reportDisposer = null
    }
  })

  function recordResult(r) {
    const prev = auto.results[r.name]
    auto.results[r.name] = {
      ok: r.ok,
      at: Date.now(),
      mode: r.mode || 'module',
      roundsAttempted: r.roundsAttempted || 0,
      rounds: r.rounds || 0,
      summary: r.summary || '',
      error: (r.errors && r.errors.join('；')) || '',
      failStages: (r.results || []).filter((x) => !x.ok).map((x) => ({
        round: x.round,
        stages: (x.stages || []).filter((s) => !s.ok).map((s) => s.name),
        detail: (x.stages || []).filter((s) => !s.ok).map((s) => String(s.detail).slice(0, 300)),
        error: x.error,
        hung: x.hung,
      })),
      waitingServices: (r.results || []).map((x) => x.waitingServices || []).flat(),
    }
    if (!r.ok && prev && prev.ok) ctx.logger.warn('[dsh-sim-restart] 自动测试失败（打回修复）：' + r.name + ' — ' + (r.summary || ''))
    if (r.ok && prev && !prev.ok) ctx.logger.info('[dsh-sim-restart] 自动测试通过：' + r.name)
  }

  async function pump() {
    if (auto.running) return
    auto.running = true
    try {
      while (auto.pending.length > 0) {
        const names = [...auto.pending]
        auto.pending = []
        for (const pkgName of names) {
          let target = null
          try {
            const { inventory, rows } = scanInventory()
            const dir = inventory.get(pkgName)
            if (dir) {
              target = {
                name: pkgName,
                pluginDir: dir,
                config: (rows.configs && rows.configs.get(pkgName)) || {},
                stubs: (stubsMap && stubsMap[pkgName]) || [],
              }
            }
          } catch (e) { /* ignore */ }
          if (!target) {
            // 插件已移除：从结果中清理
            if (auto.results[pkgName]) delete auto.results[pkgName]
            auto.removed.push({ name: pkgName, at: Date.now() })
            continue
          }
          const r = await runModuleTest(target, { rounds: autoRounds, smokeMs: autoSmokeMs })
          recordResult(r)
          await persistStatus()
          updateReport()
        }
      }
    } catch (e) {
      ctx.logger.warn('[dsh-sim-restart] 自动测试队列异常：' + e.message)
    } finally {
      auto.running = false
    }
  }

  async function scanTick() {
    try {
      const { sig, pkgList } = await snapshotSig()
      const changed = diffSig(auto.lastSig, sig)
      auto.lastSig = sig
      auto.lastScanAt = Date.now()
      auto.lastScanError = ''
      const hasChange = changed.plugins.length > 0 || changed.packages.length > 0 || changed.config
      if (hasChange) {
        auto.lastChangeAt = Date.now()
        ctx.logger.info('[dsh-sim-restart] 检测到插件变化：plugins=' + changed.plugins.join(',') + ' packages=' + changed.packages.join(',') + ' config=' + changed.config)
        if (changed.config) {
          // 配置变化：清单可能增删，全部重测
          for (const p of pkgList) if (!auto.pending.includes(p)) auto.pending.push(p)
        } else {
          for (const p of changed.plugins) if (!auto.pending.includes(p)) auto.pending.push(p)
          for (const p of changed.packages) if (!auto.pending.includes(p)) auto.pending.push(p)
        }
        // 防抖：静默 debounceMs 后执行
        if (auto.debounceTimer) { try { auto.debounceTimer() } catch (e) { /* ignore */ } }
        auto.debounceTimer = ctx.timer.timeout(() => { pump() }, debounceMs)
      }
    } catch (e) {
      auto.lastScanError = e.message
    }
  }

  if (watchEnabled && parsePatchYaml) {
    // 首次扫描建立基线并做一次全量基线测试
    const baselineTimer = ctx.timer.timeout(async () => {
      try {
        const { sig, pkgList } = await snapshotSig()
        auto.lastSig = sig
        auto.lastScanAt = Date.now()
        for (const p of pkgList) if (!auto.pending.includes(p)) auto.pending.push(p)
        ctx.logger.info('[dsh-sim-restart] 基线全量模拟重启测试启动：' + pkgList.join(','))
        await pump()
      } catch (e) {
        ctx.logger.warn('[dsh-sim-restart] 基线测试失败：' + e.message)
      }
    }, 1000)
    const tickDisposer = ctx.timer.interval(scanTick, pollMs)
    ctx.effect(() => () => {
      try { baselineTimer() } catch (e) { /* ignore */ }
      try { tickDisposer() } catch (e) { /* ignore */ }
      if (auto.debounceTimer) { try { auto.debounceTimer() } catch (e) { /* ignore */ } }
    })
  } else if (!parsePatchYaml) {
    ctx.logger.warn('[dsh-sim-restart] js-yaml 不可用，自动监控禁用（手动工具仍可用）')
  }

  // ── 工具 1：手动模拟重启测试 ────────────────────────────────────────────
  registerTool(defineTool({
    name: 'simulate_plugin_restart',
    description:
      '模拟重启测试：不实际重启 DSH 进程，在隔离子进程中模拟插件「进程重启 → 模块求值 → 插件形状 → apply 启动 → 冒烟运行 → dispose 清理 → 进程退出」全流程，检测插件重启后是否会崩溃或挂死。开发/修改任何插件后必须调用本工具验证。'
      + 'mode=source（动态插件）：先用 cordis_inspect_self(pluginId, packageId) 读取源码原文，传 hostSource（必填）与 clientSource（可选）。'
      + 'mode=module（文件系统插件 / npm 插件 / 任意目录插件）：传 pluginDir，支持 plugins/ 下本地插件、node_modules/ 下 npm 插件（含 @scope 包）与任意含 package.json 的目录；引擎自动解析入口（exports/main/常见路径）、自动布局依赖、自动附带该插件在 patch 层（cordis.patch.yml）的真实配置。'
      + '返回结构化 JSON（每轮每阶段 ✅/❌ 与精确诊断：阶段名+错误+堆栈）。FAIL 时：读取失败阶段诊断 → 修改源码（动态插件用 cordis_define 追加新 Package；文件/NPM 插件直接编辑文件）→ 再次调用本工具 → 循环直至 PASS。任何一轮失败立即返回（打回），不再继续后续轮次。',
    parameters: {
      mode: { type: 'string', description: '测试模式："source"（动态插件源码，默认）或 "module"（文件系统插件 / npm 插件 / 任意目录）' },
      name: { type: 'string', description: '插件显示名（仅报告用）' },
      hostSource: { type: 'string', description: '动态插件 Host 半边源码（function body 原文，来自 cordis_inspect_self）' },
      clientSource: { type: 'string', description: '动态插件 Client 半边源码（可选，只做求值与形状检查）' },
      pluginDir: { type: 'string', description: '插件目录绝对路径（mode=module 时必填）：如 plugins/ 下本地插件或 node_modules/ 下 npm 插件（含 @scope 包）的目录' },
      entry: { type: 'string', description: '入口相对路径（可选；缺省自动解析 package.json exports/main 或常见路径）' },
      packageName: { type: 'string', description: '插件包名（可选；缺省读 package.json 或从路径推导）' },
      stubs: { type: 'string', description: 'JSON 数组字符串，打桩外部连接，如 [{"module":"deepseek-harness-lark","export":"LarkHarnessBridge","method":"start"}]' },
      extraConfig: { type: 'string', description: 'JSON 对象字符串，合并进 apply(ctx, config) 的 config（可选；缺省自动附带该插件在 patch 层的真实配置）' },
      rounds: { type: 'number', description: '模拟重启轮数（每轮独立子进程），默认 3，范围 1-10' },
      smokeMs: { type: 'number', description: '每轮冒烟运行时长毫秒，默认 1200' },
    },
    output: {
      schema: { type: 'string' },
      render(_args, v) {
        let parsed
        try { parsed = JSON.parse(v) } catch (e) { return [{ type: 'text', text: v }] }
        const lines = []
        if (parsed.errors && parsed.errors.length > 0) {
          lines.push('❌ 参数错误：' + parsed.errors.join('；'))
        } else {
          lines.push(
            (parsed.ok ? '✅ 模拟重启测试通过' : '❌ 模拟重启测试失败（打回修改，修改后重新测试直至 PASS）') +
              '  插件=' + (parsed.name || '') + ' 模式=' + (parsed.mode || '') + ' 已测=' + (parsed.roundsAttempted || 0) + '/' + (parsed.rounds || '') + ' 轮',
          )
          for (const r of parsed.results || []) {
            lines.push('  [第 ' + r.round + ' 轮] ' + (r.ok ? '✅ PASS' : '❌ FAIL'))
            for (const s of r.stages || []) {
              lines.push('    ' + (s.ok ? '✅' : '❌') + ' ' + s.name + (s.detail ? ' — ' + String(s.detail).slice(0, 300) : ''))
            }
            if (r.hung) lines.push('    ⚠️ 进程超时未退出：残留句柄未清理，模拟真实重启会挂死')
            if (r.uncaught && r.uncaught.length > 0) lines.push('    ⚠️ 未处理异常：' + r.uncaught.join(' | ').slice(0, 300))
            if (r.error) lines.push('    ⚠️ ' + r.error)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const mode = args.mode === 'module' ? 'module' : 'source'
      const name = String(args.name || '')
      const errors = []
      if (mode === 'source') {
        if (typeof args.hostSource !== 'string' || args.hostSource.length === 0) {
          errors.push('source 模式必须提供 hostSource（先用 cordis_inspect_self(pluginId, packageId) 读取源码原文）')
        }
      } else if (typeof args.pluginDir !== 'string' || args.pluginDir.length === 0) {
        errors.push('module 模式必须提供 pluginDir（文件系统插件或 npm 插件绝对路径）')
      }
      let stubs = []
      let extraConfig = null
      if (args.stubs) {
        try { stubs = JSON.parse(args.stubs) } catch (e) { errors.push('stubs 不是合法 JSON 数组：' + e.message) }
      }
      if (args.extraConfig) {
        try { extraConfig = JSON.parse(args.extraConfig) } catch (e) { errors.push('extraConfig 不是合法 JSON 对象：' + e.message) }
      }
      if (errors.length > 0) {
        return JSON.stringify({ ok: false, mode, name, rounds: 0, roundsAttempted: 0, errors, results: [] })
      }
      if (mode === 'module') {
        // 未显式传 config 时，自动附带该插件在 patch 层的真实配置
        if (extraConfig === null) {
          try {
            const { rows } = scanInventory()
            extraConfig = (rows.configs && rows.configs.get(name)) ||
              (() => {
                // 按目录匹配：取包名
                const norm = String(args.pluginDir).replace(/\/+$/, '')
                const idx = norm.lastIndexOf('/node_modules/')
                const pkgName = idx >= 0 ? norm.slice(idx + 14).split('/').slice(0, 2).join('/') : basename(norm)
                return (rows.configs && rows.configs.get(pkgName)) || {}
              })()
          } catch (e) {
            extraConfig = {}
          }
        }
        const result = await runModuleTest({
          name: name || String(args.pluginDir || 'module-plugin'),
          pluginDir: String(args.pluginDir),
          entry: String(args.entry || ''),
          packageName: String(args.packageName || ''),
          config: extraConfig || {},
        }, { rounds: Number(args.rounds) || 3, smokeMs: Number(args.smokeMs) || 1200, stubs })
        last.ok = result.ok
        last.name = result.name
        last.mode = 'module'
        last.rounds = result.roundsAttempted
        last.at = Date.now()
        last.summary = result.summary
        return JSON.stringify(summarizeForResult(result))
      }
      // source 模式
      let engineText
      try {
        engineText = await getEngineSource()
      } catch (e) {
        return JSON.stringify({ ok: false, mode, name, rounds: 0, roundsAttempted: 0, errors: ['无法读取测试引擎 ' + ENGINE_REL + '：' + e.message], results: [] })
      }
      const rounds = Math.min(10, Math.max(1, Math.floor(Number(args.rounds) || 3)))
      const smokeMs = Math.max(200, Math.floor(Number(args.smokeMs) || 1200))
      const results = []
      let finalOk = true
      for (let round = 1; round <= rounds; round++) {
        const params = {
          mode: 'source', name, round, smokeMs, simRoot: '',
          hostSource: String(args.hostSource || ''),
          clientSource: String(args.clientSource || ''),
          pluginDir: '', entry: '', packageName: '', profileDir, depsRoot: '',
          stubs: [], extraConfig: '{}',
        }
        const r = await runEngineOnce(engineText, params)
        results.push(r)
        if (!r.ok) { finalOk = false; break }
      }
      const summary = summarizeResults(results)
      const result = { ok: finalOk, mode, name, rounds, roundsAttempted: results.length, errors: [], results, summary }
      last.ok = finalOk
      last.name = name || 'dynamic-plugin'
      last.mode = mode
      last.rounds = results.length
      last.at = Date.now()
      last.summary = summary
      return JSON.stringify(summarizeForResult(result))
    },
  }))

  // ── 工具 2：全量自动扫描测试所有已启用插件 ──────────────────────────────
  registerTool(defineTool({
    name: 'simulate_plugin_restart_auto',
    description:
      '全量自动模拟重启测试：扫描所有已启用插件（plugins/ 本地插件 + cordis.patch.yml/bundle 中启用的 npm 插件 + bundles 非内置包），逐个在隔离子进程中做模拟重启测试（不实际重启 DSH）。自动附带每个插件在 patch 层的真实配置并应用默认打桩。返回每个插件的 ✅/❌ 与失败诊断。修改多个插件或安装/移除插件后批量验证时使用；常驻 watcher 也会自动触发同类测试（可用 sim_restart_auto_status 查看）。',
    parameters: {
      rounds: { type: 'number', description: '每个插件模拟重启轮数，默认 2，范围 1-4' },
      smokeMs: { type: 'number', description: '每轮冒烟运行时长毫秒，默认 800' },
      include: { type: 'string', description: '可选过滤：逗号分隔的包名子串，只测试匹配的插件' },
    },
    output: {
      schema: { type: 'string' },
      render(_args, v) {
        let parsed
        try { parsed = JSON.parse(v) } catch (e) { return [{ type: 'text', text: v }] }
        const lines = []
        lines.push((parsed.ok ? '✅' : '❌') + ' 全量自动模拟重启测试' + (parsed.filtered ? '（过滤：' + parsed.filtered + '）' : '') + '：' + (parsed.tested || 0) + ' 个插件，' + (parsed.failures || 0) + ' 个失败')
        for (const r of parsed.results || []) {
          lines.push('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name + '（' + (r.mode || 'module') + '）' + (r.ok ? '' : ' — ' + String(r.summary || r.error || '').slice(0, 200)))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const rounds = Math.min(4, Math.max(1, Math.floor(Number(args.rounds) || 2)))
      const smokeMs = Math.max(300, Math.floor(Number(args.smokeMs) || 800))
      const include = String(args.include || '').split(',').map((s) => s.trim()).filter(Boolean)
      let inventory, rows
      try {
        const r = scanInventory()
        inventory = r.inventory
        rows = r.rows
      } catch (e) {
        return JSON.stringify({ ok: false, errors: ['扫描清单失败：' + e.message], tested: 0, failures: 0, results: [] })
      }
      const targets = []
      for (const [pkgName, dir] of inventory) {
        if (include.length > 0 && !include.some((s) => pkgName.includes(s))) continue
        targets.push({
          name: pkgName,
          pluginDir: dir,
          config: (rows.configs && rows.configs.get(pkgName)) || {},
          stubs: (stubsMap && stubsMap[pkgName]) || [],
        })
      }
      const results = []
      let failures = 0
      for (const t of targets) {
        try {
          const r = await runModuleTest(t, { rounds, smokeMs })
          results.push({ name: r.name, ok: r.ok, mode: r.mode, roundsAttempted: r.roundsAttempted, summary: r.summary, error: (r.errors || []).join('；') })
          if (!r.ok) failures += 1
          recordResult(r)
        } catch (e) {
          results.push({ name: t.name, ok: false, summary: '', error: e.message })
          failures += 1
        }
      }
      persistStatus()
      updateReport()
      return JSON.stringify({
        ok: failures === 0,
        tested: results.length,
        failures,
        filtered: include.join(','),
        results,
        errors: [],
      })
    },
  }))

  // ── 工具 3：自动监控状态查询 ────────────────────────────────────────────
  registerTool(defineTool({
    name: 'sim_restart_auto_status',
    description:
      '查询模拟重启自动监控（watcher）的状态：监控范围、最近扫描、待测队列、每个插件最近一次自动模拟重启测试结果（✅/❌ 与失败诊断）。修复插件后用它确认 watcher 已重测通过；watcher 在插件安装/修改/去除后自动触发测试（不实际重启 DSH），失败会通过 systemPrompt 打回修复，直至全部通过。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render(_args, v) {
        let parsed
        try { parsed = JSON.parse(v) } catch (e) { return [{ type: 'text', text: v }] }
        const lines = []
        lines.push('自动监控：' + (parsed.enabled ? '✅ 启用' : '⏸ 禁用') + (parsed.yamlAvailable === false ? '（⚠️ js-yaml 不可用，清单解析受限）' : ''))
        lines.push('监控范围：plugins/ 目录、启用的 npm 插件包、配置文件（package.json / pnpm-* / cordis*.yml）')
        lines.push('最近扫描：' + (parsed.lastScanAt ? new Date(parsed.lastScanAt).toLocaleTimeString() : '—') + '  最近变化：' + (parsed.lastChangeAt ? new Date(parsed.lastChangeAt).toLocaleTimeString() : '—') + (parsed.lastScanError ? '  扫描错误：' + parsed.lastScanError : ''))
        lines.push('待测队列：' + (parsed.pending && parsed.pending.length ? parsed.pending.join(', ') : '空') + (parsed.running ? '（测试运行中）' : ''))
        const results = parsed.results || {}
        const names = Object.keys(results)
        if (names.length === 0) {
          lines.push('最近测试结果：暂无（首次扫描/基线测试尚未完成）')
        } else {
          lines.push('最近测试结果（' + names.length + ' 个插件）：')
          for (const nm of names) {
            const r = results[nm]
            lines.push('  ' + (r.ok ? '✅' : '❌') + ' ' + nm + ' — ' + new Date(r.at).toLocaleTimeString() + ' ' + (r.roundsAttempted || 0) + '/' + (r.rounds || 0) + ' 轮' + (r.ok ? '' : '：' + String(r.summary || r.error || '').slice(0, 160)))
            for (const f of r.failStages || []) {
              lines.push('    ❌ 第 ' + f.round + ' 轮：' + (f.stages || []).join('、') + (f.hung ? '（超时挂起）' : ''))
              for (const d of f.detail || []) lines.push('      ' + d.slice(0, 250))
              if (f.error) lines.push('      ' + f.error.slice(0, 250))
            }
          }
        }
        if (parsed.removed && parsed.removed.length) lines.push('最近移除：' + parsed.removed.map((r) => r.name).join(', '))
        lines.push('打回报告：' + (parsed.reportActive ? '🟥 激活中（失败诊断已注入 agent prompt，请修复）' : '🟢 无失败（未激活）'))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return JSON.stringify({
        enabled: auto.enabled,
        yamlAvailable: auto.yamlAvailable,
        watching: auto.watching,
        lastScanAt: auto.lastScanAt,
        lastChangeAt: auto.lastChangeAt,
        lastScanError: auto.lastScanError,
        pending: [...auto.pending],
        running: auto.running,
        results: auto.results,
        removed: auto.removed.slice(-10),
        reportActive: auto.reportActive,
        reportText: buildReportText(),
      })
    },
  }))

  ctx.logger.info('[dsh-sim-restart] v0.3.0 loaded, auto-watch=' + (watchEnabled && parsePatchYaml ? 'on' : 'off') + ' poll=' + pollMs + 'ms debounce=' + debounceMs + 'ms')
}

export default { name, inject, apply }
