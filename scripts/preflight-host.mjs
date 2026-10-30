#!/usr/bin/env node
/**
 * preflight-host.mjs — 部署前先确认「这台机器的宿主，认不认这份 profile」。
 *
 * 为什么必须有（2026-10-28 实伤）：
 *   笔记本上 profile 已经装到了要 `>=0.2.1-rc.2` 的一代，而全局 `dsh` 还停在
 *   0.2.0-rc.2。宿主门禁不报错，只在启动时**静默跳过**整个 bundle：
 *
 *     dsh: skipping profile bundle "@linxin666/dsh-web-all": peerDependencies {"@deepseek-ai/dsh":">=0.2.1-rc.2"}
 *
 *   表现是「GUI 坏了一半」—— Web UI 全家桶、会话归档都不见了 —— 而部署脚本全程绿灯。
 *   setup 只检查了「依赖装得上」，没检查「宿主这一代认不认它们」。
 *
 * 判据（四条，缺一不可）：
 *   1. 实际宿主的版本 >= plugins.intent.json 里的 runtime
 *   2. 每个已装插件的宿主范围（engines.dsh 优先、退回 peer）都接受这个版本
 *   3. 版本比对必须让 rc 号参与 —— 见 host-range.mjs
 *   4. **PATH 上的 `dsh`、全局 shim、正在跑的宿主，必须是同一个版本**
 *
 *   第 4 条是 2026-10-30 的实伤（同一台机器，同一分钟）：
 *
 *     dsh --version                        → 0.2.1-rc.5   （npx 缓存里的那一份）
 *     ~/AppData/Roaming/npm/dsh.cmd --version → 0.2.1-rc.2   （全局安装，旧的）
 *     正在跑 3080 的进程                     → 0.2.1-rc.5   （npx 缓存）
 *
 *   重启脚本当时用的是全局 shim，也就是 rc.2 —— 重启一次就把宿主降了一代，
 *   而 profile 里 @linxin666/* 要求 >=0.2.1-rc.3，于是**又**会静默跳过 bundle。
 *   前三条全都绿灯：它们只问「dsh 是几版」，没问「是哪一个 dsh」。
 *
 * 用法：
 *   node scripts/preflight-host.mjs                        # 检查 ~/.dsh/profiles/web
 *   node scripts/preflight-host.mjs --profile-dir <dir>
 *   node scripts/preflight-host.mjs --host-version 0.2.0-rc.2   # 假装宿主是这个版本
 *   node scripts/preflight-host.mjs --port 3080            # 用哪个端口找正在跑的宿主
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { satisfiesDsh } from './host-range.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }

const PROFILE_DIR = path.resolve(argOf('profile-dir') ?? path.join(os.homedir(), '.dsh', 'profiles', 'web'))
const HOST_CMD = argOf('dsh') ?? 'dsh'
const FAKE_VERSION = argOf('host-version')

function hostVersion() {
  if (FAKE_VERSION) return FAKE_VERSION
  try {
    const out = execFileSync([HOST_CMD, '--version'].join(' '), {
      encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim().split(/\r?\n/).filter(Boolean).pop() ?? null
  } catch { return null }
}

const PORT = Number(argOf('port') ?? 3080)

/** 跑一个 `--version`，取最后一行。拿不到就 null（不猜）。 */
function versionOf(cmd) {
  try {
    const out = execFileSync(cmd, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().split(/\r?\n/).filter(Boolean).pop() ?? null
  } catch { return null }
}

/** 从安装目录的 package.json 读版本（比再跑一次 --version 快，且不会被 shell 影响）。 */
function versionOfInstallDir(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return typeof j.version === 'string' ? j.version : null
  } catch { return null }
}

/** 监听某端口的 PID（netstat -ano，与 restart-host.mjs 同源）。 */
function pidOnPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/)
      if (f.length >= 5 && f[0].toUpperCase() === 'TCP' && f[3] === 'LISTENING' && f[1].endsWith(`:${port}`)) return Number(f[4])
    }
  } catch { /* 没有 netstat 就当作没有在跑的宿主 */ }
  return undefined
}

/** 该 PID 的命令行（CIM）。拿不到就 undefined。 */
function commandLineOf(pid) {
  if (!pid) return undefined
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const cmd = out.trim()
    return cmd === '' ? undefined : cmd
  } catch { return undefined }
}

/**
 * 每一个「dsh 入口」的版本：正在跑的、PATH 上的、全局 shim 的。
 *
 * 第三个是重点。它不是「另一个也装着的 dsh」，它是**重启脚本最容易拉起的那一个**：
 * 在那一刻，用 shim 重启就等于把宿主换成 shim 的版本。
 */
function entryPoints(pathVersion) {
  const out = []
  const cmd = commandLineOf(pidOnPort(PORT))
  if (cmd !== undefined) {
    const m = cmd.match(/"([^"]*[\\/]dsh[\\/]lib[\\/]bin\.js)"/i) ?? cmd.match(/(\S*[\\/]dsh[\\/]lib[\\/]bin\.js)/i)
    if (m) {
      const installDir = path.dirname(path.dirname(path.resolve(m[1])))   // <install>/lib/bin.js → <install>
      out.push({ detail: installDir, label: `running(:${PORT})`, version: versionOfInstallDir(installDir) })
    } else {
      out.push({ detail: cmd.slice(0, 120), label: `running(:${PORT})`, version: null })
    }
  }
  out.push({ detail: HOST_CMD, label: 'PATH dsh', version: pathVersion })
  const shim = process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'dsh.cmd') : null
  if (shim && fs.existsSync(shim)) out.push({ detail: shim, label: 'global shim', version: versionOf(`"${shim}" --version`) })
  return out
}

/** 该 profile 想要的宿主世代。模板里是 plugins.intent.json；部署后的 profile 只能看已装插件的声明。 */
function wantedRuntime() {
  try {
    const intent = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'web', 'plugins.intent.json'), 'utf8'))
    if (typeof intent.runtime === 'string' && intent.runtime.trim()) return { runtime: intent.runtime.trim(), from: 'plugins.intent.json' }
  } catch { /* 模板不在手边就跳过 */ }
  return null
}

/** 已装插件的宿主范围。engines.dsh 优先（门禁也是这个顺序），退回 peer。 */
function declaredRanges(profileDir) {
  const nm = path.join(profileDir, 'node_modules')
  const out = []
  const readOne = (base, fallbackName) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
      const range = j.engines?.dsh ?? j.peerDependencies?.['@deepseek-ai/dsh']
      if (typeof range === 'string' && range.trim()) {
        out.push({ name: j.name ?? fallbackName, version: j.version, range: range.trim(), from: j.engines?.dsh ? 'engines' : 'peer' })
      }
    } catch { /* 不是包 */ }
  }
  let entries = []
  try { entries = fs.readdirSync(nm, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.bin' || e.name === '.pnpm') continue
    const full = path.join(nm, e.name)
    if (e.name.startsWith('@')) {
      let subs = []
      try { subs = fs.readdirSync(full, { withFileTypes: true }) } catch { continue }
      for (const s of subs) if (s.isDirectory()) readOne(path.join(full, s.name), `${e.name}/${s.name}`)
    } else {
      readOne(full, e.name)
    }
  }
  return out
}

const version = hostVersion()
if (!version) {
  console.error(`✗ 拿不到宿主版本（试过 \`${HOST_CMD} --version\`）。先确认 dsh 在 PATH 上，或用 --dsh <路径>。`)
  process.exit(2)
}

const problems = []

// 4) 入口一致性。今天它们不是同一版，差的是一整个世代 —— 而前三条判据全绿灯。
const entries = entryPoints(version)
const knownEntries = entries.filter((e) => typeof e.version === 'string' && e.version !== '')
const distinctVersions = [...new Set(knownEntries.map((e) => e.version))]
if (distinctVersions.length > 1) {
  const shim = knownEntries.find((e) => e.label === 'global shim')
  problems.push({
    kind: 'entry-point-mismatch',
    detail: `有 ${distinctVersions.length} 个不同版本的 dsh 入口在同时使用：${knownEntries.map((e) => `${e.label}=${e.version}`).join('、')}`,
    fix: shim
      ? `重启若走全局 shim（${shim.version}）会把宿主换成那一版。把两者对齐到同一版，或让重启照**正在跑的那个**入口拉起 —— restart-host.mjs 已经这么做。`
      : '让重启照正在跑的那个入口拉起，而不是照 PATH 或 shim。',
  })
}

const wanted = wantedRuntime()
if (wanted && !satisfiesDsh(`>=${wanted.runtime}`, version)) {
  problems.push({
    kind: 'host-too-old',
    detail: `宿主 ${version} 比这份 profile 瞄准的世代 ${wanted.runtime} 更旧（来源 ${wanted.from}）`,
    fix: `npm i -g @deepseek-ai/dsh@${wanted.runtime}`,
  })
}

const ranges = declaredRanges(PROFILE_DIR)
const rejected = []
for (const r of ranges) {
  let ok
  try { ok = satisfiesDsh(r.range, version) } catch { continue }   // 看不懂的范围不猜
  if (!ok) rejected.push(r)
}

console.log(`宿主版本 : ${version}`)
console.log(`profile  : ${PROFILE_DIR}`)
if (wanted) console.log(`目标世代 : ${wanted.runtime}（${wanted.from}）`)
console.log(`扫描声明 : ${ranges.length} 个已装插件`)
if (entries.length > 1) {
  console.log('入口     :')
  for (const e of entries) console.log(`    ${e.label.padEnd(15)} ${(e.version ?? '(拿不到)').padEnd(14)} ${e.detail}`)
}

if (!problems.length && !rejected.length) {
  console.log('\n✓ 宿主与这份 profile 同代：没有 bundle 会被门禁跳过')
  process.exit(0)
}

if (rejected.length) {
  console.log(`\n✗ 有 ${rejected.length} 个已装 bundle 的宿主范围不接受 ${version} —— 启动时会被静默跳过：`)
  for (const r of rejected.slice(0, 20)) {
    console.log(`    ${r.name}@${r.version}  ${r.from}=${r.range}`)
  }
  if (rejected.length > 20) console.log(`    …还有 ${rejected.length - 20} 个`)
}
for (const p of problems) {
  console.log(`\n✗ ${p.detail}`)
  if (p.fix) console.log(`   修：${p.fix}`)
}
if (rejected.length && !problems.length) {
  console.log(`\n   修：把宿主升到这些插件要求的世代，或把它们降回与 ${version} 兼容的版本。`)
  console.log('   宿主升到该世代后重跑本检查，确认 0 条被拒再部署。')
}
process.exit(1)
