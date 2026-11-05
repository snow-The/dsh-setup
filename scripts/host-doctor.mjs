#!/usr/bin/env node
/**
 * host-doctor.mjs — 宿主安装完整性体检（可在任何机器上跑，只读）。
 *
 * 为什么需要：2026-11-02 qq134 那台机器整机起不来，20 个插件 + 宿主自己的 dsh-agent-loop
 * 全挂在同一个包上：`@deepseek-ai/dsh-tools`。报错是
 *   Cannot find package '…\dsh-tools\index.js'
 * 这句（**带 /index.js 后缀**）在 Node 里只对应一种情况：目录在，但 package.json
 * 读不出可用的 main/exports（文件没了 / 空的 / 坏了）。目录整个不在时 Node 只报包名。
 * 所以"某个包坏了"和"整个没装"必须分开说，否则会按错误的方向重装。
 *
 * 这个脚本检查：
 *   1. 宿主版本
 *   2. 宿主自带的 node_modules/@deepseek-ai/* 每个包：package.json 能否解析、入口文件是否在
 *   3. ~/.dsh/profiles/node_modules 是不是 junction、指向哪里、目标里有没有 dsh-tools
 * 用法：
 *   node host-doctor.mjs                 # 默认 %APPDATA%\npm\node_modules\@deepseek-ai\dsh
 *   node host-doctor.mjs --dsh=<path>    # 指定宿主目录
 *   node host-doctor.mjs --json
 * 退出码：0 全健康；1 有坏包；2 定位不到宿主
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const argOf = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const AS_JSON = process.argv.includes('--json')
const argOf2 = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const PROFILE_DIR = argOf2('profile', 'web')
const DSH = argOf('dsh', join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh'))

const readJson = (p) => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(p, 'utf8')) }
  } catch (e) {
    return { ok: false, why: e.code ?? String(e.message).slice(0, 60) }
  }
}

if (!existsSync(DSH)) {
  console.error(`定位不到宿主目录：${DSH}`)
  process.exit(2)
}

const hostPkg = readJson(join(DSH, 'package.json'))
const hostRoot = join(DSH, 'node_modules', '@deepseek-ai')

// 入口解析：main / exports['.'] 的各种形态；都没有就按 Node 的 legacy 规则找 index.js
const resolveEntry = (pkg, dir) => {
  const ex = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.']
  const exEntry = typeof ex === 'string' ? ex : ex?.import ?? ex?.require ?? ex?.default
  const decl = pkg.main ?? (typeof exEntry === 'string' ? exEntry : null)
  if (decl) return { decl, declared: true, file: join(dir, String(decl).replace(/^\.\//, '')) }
  return { decl: '(无 main/exports)', declared: false, file: join(dir, 'index.js') }
}

// 「必须能按包名 import」的集合：宿主自己声明的依赖 + 每个已装插件声明的依赖/peer。
// 不靠猜、也不靠 grep 全树：package.json 里声明了就是有人会 import 它。
const mustImport = new Set()
const addDeps = (pkg) => {
  if (!pkg) return
  for (const k of Object.keys(pkg.dependencies ?? {})) if (k.startsWith('@deepseek-ai/')) mustImport.add(k.slice('@deepseek-ai/'.length))
  for (const k of Object.keys(pkg.peerDependencies ?? {})) if (k.startsWith('@deepseek-ai/')) mustImport.add(k.slice('@deepseek-ai/'.length))
}
if (hostPkg.ok) addDeps(hostPkg.value)
for (const prof of ['web', 'default']) {
  const nm = join(HOME, '.dsh', 'profiles', prof, 'node_modules')
  if (!existsSync(nm)) continue
  for (const scope of ['@snow-the', '@deepseek-ai', '']) {
    const base = scope ? join(nm, scope) : nm
    if (!existsSync(base)) continue
    let names = []
    try {
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const n of names) {
      const pj = readJson(join(base, n, 'package.json'))
      if (pj.ok) addDeps(pj.value)
    }
  }
}

const broken = []
const advisory = []
const checked = []
let pkgs = []
try {
  pkgs = readdirSync(hostRoot)
} catch {
  console.error(`宿主里没有 ${hostRoot}`)
  process.exit(2)
}

for (const name of pkgs) {
  const dir = join(hostRoot, name)
  let isDir = false
  try {
    isDir = lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()
  } catch {}
  if (!isDir) continue
  const pj = readJson(join(dir, 'package.json'))
  if (!pj.ok) {
    broken.push({ name, why: `package.json ${pj.why === 'ENOENT' ? '不存在' : `读不出（${pj.why}）`}`, hit: join(dir, 'index.js') })
    continue
  }
  const { decl, file, declared } = resolveEntry(pj.value, dir)
  if (!existsSync(file)) {
    // 没有 main/exports 的资源/二进制包（web 前端、libreoffice、原生 addon）本来就只能按子路径取。
    // 只有当**有人按包名 import 它**时（依赖/peer 里声明过），缺入口才是硬伤。
    if (!declared && !mustImport.has(name)) {
      advisory.push({ name, why: '没有 main/exports，也没人按包名 import（按子路径使用，正常）' })
      continue
    }
    broken.push({ name, why: declared ? `声明的入口不存在（main=${decl}）` : '没有 main/exports，但有依赖方按包名 import 它', hit: file })
    continue
  }
  checked.push(name)
}

// profile 解析层
const layer = join(HOME, '.dsh', 'profiles', 'node_modules')
let layerInfo = { path: layer, exists: existsSync(layer) }
if (layerInfo.exists) {
  try {
    layerInfo.isLink = lstatSync(layer).isSymbolicLink()
    layerInfo.target = layerInfo.isLink ? realpathSync(layer) : null
  } catch {}
  const toolsPkg = join(layer, '@deepseek-ai', 'dsh-tools', 'package.json')
  layerInfo.dshToolsPackageJson = existsSync(toolsPkg)
  layerInfo.dshToolsEntry = existsSync(join(layer, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
}

// ---------- profile 里的包：能不能真的解析 ----------
// 2026-11-02 qq134 实伤：宿主 302 个包全健康、host-doctor 判 OK，但 profile 的
// node_modules 里 29/29 个 pnpm 链接的 realpath 全部 UNKNOWN（重解析点损坏），
// 宿主在 linkedProfileRoots 里就崩了。**"宿主没问题"和"起得来"是两件事。**
const profPkg = join(HOME, '.dsh', 'profiles', PROFILE_DIR)
let profInfo = { dir: profPkg, exists: existsSync(profPkg) }
if (profInfo.exists) {
  const nm = join(profPkg, 'node_modules')
  profInfo.hasNodeModules = existsSync(nm)
  if (profInfo.hasNodeModules) {
    let total = 0
    const unreadable = []
    const walkPkg = (d, depth) => {
      let ents = []
      try {
        ents = readdirSync(d, { withFileTypes: true })
      } catch (e) {
        unreadable.push({ path: d, why: e.code ?? 'READDIR' })
        return
      }
      for (const e of ents) {
        if (e.name.startsWith('.pnpm') || e.name === '.bin') continue
        const f = join(d, e.name)
        if (depth === 0 && e.name.startsWith('@')) {
          walkPkg(f, depth + 1)
          continue
        }
        if (!e.isDirectory() && !e.isSymbolicLink()) continue
        total++
        try {
          realpathSync.native(f)
        } catch (err) {
          unreadable.push({ path: f.slice(nm.length + 1), why: err.code ?? 'UNKNOWN' })
        }
      }
    }
    walkPkg(nm, 0)
    profInfo.packages = total
    profInfo.unreadable = unreadable.length
    profInfo.unreadableSample = unreadable.slice(0, 8)
  }
}

const result = {
  host: {
    dir: DSH,
    version: hostPkg.ok ? (hostPkg.value.version ?? '?') : `package.json 读不出（${hostPkg.why}）`,
  },
  packages: { total: pkgs.length, ok: checked.length, broken, advisory },
  profileLayer: layerInfo,
  profilePackages: profInfo,
  verdict: broken.length || (profInfo.unreadable ?? 0) > 0 ? 'BROKEN' : 'OK',
}
result.host.packagesDir = hostRoot

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`宿主    ${DSH}`)
  console.log(`版本    ${result.host.version}`)
  console.log(`包      ${checked.length} 个健康 / ${broken.length} 个坏 / ${advisory.length} 个无入口但按子路径使用（共 ${pkgs.length} 个目录）`)
  for (const a of advisory) console.log(`  · ${a.name} —— ${a.why}`)
  for (const b of broken) {
    console.log(`  ✗ ${b.name} —— ${b.why}`)
    console.log(`      会去找: ${b.hit}`)
  }
  const L = layerInfo
  if (!L.exists) console.log(`解析层  ${L.path} 不存在（宿主启动时会建）`)
  else {
    console.log(`解析层  ${L.path}${L.isLink ? ` → junction: ${L.target}` : '（真实目录，不是链接）'}`)
    console.log(`        dsh-tools/package.json: ${L.dshToolsPackageJson}   lib/index.js: ${L.dshToolsEntry}`)
  }
  const P = profInfo
  if (!P.exists) console.log(`profile  ${P.dir} 不存在`)
  else if (!P.hasNodeModules) console.log(`profile  ${P.dir}（还没装 node_modules）`)
  else {
    console.log(`profile  ${P.dir}`)
    console.log(`         ${P.packages} 个包，realpath 失败 ${P.unreadable} 个`)
    for (const u of P.unreadableSample) console.log(`         ✗ ${u.path}（${u.why}）`)
    if ((P.unreadable ?? 0) > 0) console.log('         → 这棵树的重解析点坏了：改名后跑 dsh plugin --profile ' + PROFILE_DIR + ' install 重建')
  }
  console.log(`\n判定：${result.verdict}${result.verdict === 'BROKEN' ? ' —— 先修这些，再谈插件' : ''}`)
}
process.exit(broken.length ? 1 : 0)
