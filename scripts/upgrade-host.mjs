#!/usr/bin/env node
/**
 * upgrade-host.mjs — 把全局 dsh 升到这份 profile 瞄的世代。
 *
 * 为什么需要（2026-10-28）：setup 一直假设「宿主已经装好、且和模板同代」。它只会
 * 打印一句「建议: npm i -g @deepseek-ai/dsh 后重跑」，然后继续部署 —— 于是笔记本上
 * 出现了「profile 换到新一代、宿主还是上一代」的半升状态，宿主静默跳包，GUI 少一半。
 * 断言不做的检查等于没检查，建议不做的事等于没做。
 *
 * 三个坑都在这里处理：
 *   1. 宿主正在运行 → npm 替换全局树会 EBUSY（koffi.node 被映射）。先检测并拒绝。
 *   2. npm 默认**拦掉**原生依赖的 install 脚本（koffi / node-pty / subprocess-local /
 *      genai / protobufjs）。不补 --allow-scripts 会装出一个 pty 半死的宿主。
 *   3. 老 npm 不认识 --allow-scripts：带它失败时自动退回不带。
 *
 * 用法：
 *   node scripts/upgrade-host.mjs                # 升到 plugins.intent.json 的 runtime
 *   node scripts/upgrade-host.mjs --to 0.2.1-rc.4
 *   node scripts/upgrade-host.mjs --check-only   # 只说会做什么
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { satisfiesDsh } from './host-range.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const CHECK_ONLY = argv.includes('--check-only')

// npm 11/12 会拦掉这些包的原生 install 脚本，拦了之后就 pty / spawn helper 半死。
const NATIVE_PKGS = ['@deepseek-ai/dsh-subprocess-local', 'koffi', 'node-pty', '@google/genai', 'protobufjs']

function targetVersion() {
  const explicit = argOf('to')
  if (explicit) return explicit.trim()
  try {
    const intent = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'web', 'plugins.intent.json'), 'utf8'))
    if (typeof intent.runtime === 'string' && intent.runtime.trim()) return intent.runtime.trim()
  } catch { /* ignore */ }
  return null
}

function currentVersion() {
  try {
    const out = execFileSync('dsh --version', { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().split(/\r?\n/).filter(Boolean).pop() ?? null
  } catch { return null }
}

/** 正在跑的 dsh 宿主：npm 替换全局树时它们锁着 .node 文件。 */
function runningHosts() {
  try {
    if (process.platform === 'win32') {
      const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const rows = JSON.parse(raw || '[]')
      return (Array.isArray(rows) ? rows : [rows]).filter((r) => {
        const c = (r.CommandLine ?? '').replace(/\\+/g, '/')
        return c && !c.includes('subprocess-local') && /\bweb\b/.test(c)
          && (c.includes('dsh/lib/bin.js') || c.includes('npx-cli.js'))
      }).map((r) => r.ProcessId)
    }
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n')
      .filter((l) => /dsh/.test(l) && /\bweb\b/.test(l) && !l.includes('subprocess-local'))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch { return [] }
}

function npmInvocation(args) {
  // 直接跑 npm-cli.js：Windows 上 .cmd 垫片不经 shell 起不来，而 shell 又会吃掉引号。
  const npmCli = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : null
  if (npmCli && fs.existsSync(npmCli)) return { cmd: process.execPath, args: [npmCli, ...args] }
  return { cmd: 'npm', args, shell: true }
}

const target = targetVersion()
if (!target) {
  console.error('✗ 不知道要升到哪个版本：plugins.intent.json 里没有 runtime，也没给 --to。')
  process.exit(2)
}

const current = currentVersion()
console.log(`当前宿主 : ${current ?? '(取不到版本)'}`)
console.log(`目标世代 : ${target}`)

if (current) {
  let already = false
  try { already = satisfiesDsh(`>=${target}`, current) } catch { already = false }
  if (already) {
    console.log(`✓ 已经是 ${target} 或更新的同一代，不需要升级。`)
    process.exit(0)
  }
}

const hosts = runningHosts()
const installArgs = ['i', '-g', `@deepseek-ai/dsh@${target}`, `--allow-scripts=${NATIVE_PKGS.join(',')}`]

if (CHECK_ONLY) {
  console.log(`\n(检查模式) 将要执行: ${installArgs.join(' ')}`)
  console.log(`  原生依赖放行: ${NATIVE_PKGS.join(', ')}`)
  if (hosts.length) console.log(`  ⚠ 检测到 ${hosts.length} 个正在运行的宿主（pid ${hosts.join(',')}）—— 真升级前必须先关掉，否则 npm 会 EBUSY`)
  process.exit(hosts.length ? 3 : 0)
}

if (hosts.length) {
  console.error(`\n✗ 有 ${hosts.length} 个 dsh 宿主正在运行（pid ${hosts.join(',')}）。`)
  console.error('  正在运行的进程锁着全局树里的 .node 文件，npm 替换时会 EBUSY（实测 koffi.node）。')
  console.error('  先关掉 DSH（不是本脚本能替你做的事），再重跑。')
  process.exit(3)
}

console.log(`\n升级中: ${installArgs.join(' ')}`)
let r = spawnSync(npmInvocation(installArgs).cmd, npmInvocation(installArgs).args, {
  stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: npmInvocation(installArgs).shell === true,
})
let combined = `${r.stdout ?? ''}${r.stderr ?? ''}`

// 老 npm 不认识 --allow-scripts：退回不带它的调用，并说明代价。
if (r.status !== 0 && /allow-scripts|Unknown .*option|unknown config/i.test(combined)) {
  console.log('  · 这个 npm 不认识 --allow-scripts，退回普通安装（原生依赖的 install 脚本会被拦，pty 可能半死）')
  const fallback = ['i', '-g', `@deepseek-ai/dsh@${target}`]
  r = spawnSync(npmInvocation(fallback).cmd, npmInvocation(fallback).args, {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: npmInvocation(fallback).shell === true,
  })
  combined = `${r.stdout ?? ''}${r.stderr ?? ''}`
}

if (r.status !== 0) {
  console.error('✗ 升级失败。npm 输出（末尾）:')
  for (const line of combined.trim().split(/\r?\n/).slice(-12)) console.error('  ' + line)
  process.exit(1)
}

const after = currentVersion()
console.log(`✓ 升级完成，现在是 ${after ?? '(取不到版本)'}`)
if (after !== target) {
  console.log(`  注意: 期望 ${target}，实际 ${after}。检查是否有多个 dsh 安装（PATH 上先命中哪个）。`)
}
if (/install-scripts|had install scripts blocked/i.test(combined)) {
  console.log('  ⚠ npm 仍然拦了部分 install 脚本 —— 终端/pty 功能可能有问题，看上面的 warn 列表补跑。')
}
