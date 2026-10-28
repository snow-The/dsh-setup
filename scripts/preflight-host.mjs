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
 * 判据（三条，缺一不可）：
 *   1. 实际宿主的版本 >= plugins.intent.json 里的 runtime
 *   2. 每个已装插件的宿主范围（engines.dsh 优先、退回 peer）都接受这个版本
 *   3. 版本比对必须让 rc 号参与 —— 见 host-range.mjs
 *
 * 用法：
 *   node scripts/preflight-host.mjs                        # 检查 ~/.dsh/profiles/web
 *   node scripts/preflight-host.mjs --profile-dir <dir>
 *   node scripts/preflight-host.mjs --host-version 0.2.0-rc.2   # 假装宿主是这个版本
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
