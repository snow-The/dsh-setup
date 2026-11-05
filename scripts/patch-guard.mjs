#!/usr/bin/env node
/**
 * patch-guard.mjs — `cordis.patch.yml` 的"1 字节"护栏。
 *
 * 为什么（2026-11-01 实伤，两台机器各中一次）：`dsh-undo-savepoint 0.5.0` 进入安全模式后，
 * 它的 `cleanDanglingInserts` 在 `keep` 为空时把 profile 的 patch 文件重写成**一个换行**，
 * 于是整个 profile 起不来，而报错指向 YAML 形状（overlay ... must be a top-level YAML array），
 * 完全不提那个插件。上游没有修复版（0.5.0 就是 latest）。
 *
 * 这个脚本做两件事：
 *   健康时：把当前文件存成一份"已知好"的副本（~/.dsh/_p0/patch-good/<profile>.yml）
 *   坏了时：报出签名（大小 / 首字节），列出候选好副本；`--restore` 就挑最像的那份恢复
 *
 * 判据只认结构，不认内容：去掉注释与 BOM 后，第一行有效内容必须以 `-` 开头（顶层数组）。
 * 用法：
 *   node patch-guard.mjs                 # 检查 + 健康时刷新副本
 *   node patch-guard.mjs --restore       # 坏了就恢复（坏的留 .truncated-<时间>）
 *   node patch-guard.mjs --profile=web --json
 * 退出码：0 健康；1 坏了（需要恢复）；2 判不了或恢复失败
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const argOf = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const PROFILE = argOf('profile', 'web')
const AS_JSON = process.argv.includes('--json')
const DO_RESTORE = process.argv.includes('--restore')

const LIVE = argOf('home', join(HOME, '.dsh'))
const FILE = join(LIVE, 'profiles', PROFILE, 'cordis.patch.yml')
const GOOD_DIR = join(LIVE, '_p0', 'patch-good')
const GOOD = join(GOOD_DIR, `cordis.patch.${PROFILE}.yml`)

if (!existsSync(FILE)) {
  console.error(`找不到 ${FILE}`)
  process.exit(2)
}

const body = readFileSync(FILE)
const text = body.toString('utf8')
const firstMeaningful = text
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .find((l) => l.trim() && !l.trim().startsWith('#'))
const looksArray = Boolean(firstMeaningful && firstMeaningful.trimStart().startsWith('-'))
const ids = (text.match(/^\s*-?\s*id:\s*\S+/gm) ?? []).length
const healthy = body.length >= 200 && looksArray

// 候选好副本：自己的 patch-good 优先，其次是各种 .bak-* 与 _fix 里手工留的
const candidates = []
const addCandidate = (p) => {
  try {
    const st = statSync(p)
    if (!st.isFile()) return
    const t = readFileSync(p, 'utf8')
    const fm = t.replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))
    const okShape = Boolean(fm && fm.trimStart().startsWith('-'))
    const safeMode = /SAFE MODE/i.test(t)
    if (okShape && !safeMode) candidates.push({ path: p, bytes: st.size, ids: (t.match(/^\s*-?\s*id:\s*\S+/gm) ?? []).length })
  } catch {}
}
if (existsSync(GOOD)) addCandidate(GOOD)
const profDir = join(LIVE, 'profiles', PROFILE)
for (const n of readdirSync(profDir)) {
  if (/^cordis\.patch\.yml\.(bak|good|truncated|dsh-undo-bak)/i.test(n) || /^cordis\.patch\.yml\.\d/.test(n)) addCandidate(join(profDir, n))
}
const fixDir = join(HOME, '_fix')
if (existsSync(fixDir)) for (const n of readdirSync(fixDir)) if (/cordis\.patch\.yml/i.test(n)) addCandidate(join(fixDir, n))
candidates.sort((a, b) => b.bytes - a.bytes)

const report = {
  file: FILE,
  bytes: body.length,
  ids,
  firstMeaningful: (firstMeaningful ?? '').slice(0, 60),
  healthy,
  goodCopy: existsSync(GOOD) ? GOOD : null,
  candidates,
}

if (healthy) {
  mkdirSync(GOOD_DIR, { recursive: true })
  copyFileSync(FILE, GOOD)
  report.refreshedGoodCopy = GOOD
} else if (DO_RESTORE && candidates.length) {
  const best = candidates[0]
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const aside = `${FILE}.truncated-${stamp}`
  copyFileSync(FILE, aside)
  copyFileSync(best.path, FILE)
  const after = readFileSync(FILE, 'utf8')
  const fm = after.replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))
  report.restored = { from: best.path, bytes: statSync(FILE).size, aside, okShape: Boolean(fm && fm.trimStart().startsWith('-')) }
} else if (DO_RESTORE) {
  report.restoreFailed = '没有可用的候选副本'
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`文件   ${FILE}`)
  console.log(`大小   ${report.bytes} 字节 | id 行 ${ids} | 首个有效行 ${JSON.stringify(report.firstMeaningful)}`)
  if (healthy) {
    console.log(`判定   健康（顶层是 YAML 数组）`)
    console.log(`副本   已刷新 → ${report.refreshedGoodCopy}`)
  } else {
    console.log(`判定   ✗ 坏（顶层不是数组，或文件小于 200 字节）`)
    if (report.bytes <= 4) console.log(`       这多半是 dsh-undo-savepoint 的 1 字节签名：内容已经没了，别试图"修 YAML"`)
    if (candidates.length) {
      console.log(`候选   ${candidates.length} 份可用（按大小降序）：`)
      for (const c of candidates.slice(0, 5)) console.log(`       ${String(c.bytes).padStart(7)} B  id=${c.ids}  ${c.path}`)
      console.log(`       → 想恢复就跑：node patch-guard.mjs --restore`)
    } else {
      console.log('候选   没有可用的健康副本 —— 只能从版本控制或别的机器取')
    }
    if (report.restored) {
      console.log('')
      console.log(`已恢复 来自 ${report.restored.from}`)
      console.log(`      现在 ${report.restored.bytes} B，形状 ${report.restored.okShape ? 'OK（顶层是数组）' : '仍不对'}；坏的那份留在 ${report.restored.aside}`)
      if (report.restored.okShape) console.log('      → 这份就是「已知好」了，下次健康检查会自动存副本')
    }
    if (report.restoreFailed) console.log(`恢复失败：${report.restoreFailed}`)
  }
}
process.exit(report.restored ? (report.restored.okShape ? 0 : 2) : healthy ? 0 : 1)
