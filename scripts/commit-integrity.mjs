#!/usr/bin/env node
/**
 * commit-integrity.mjs — 「本机能跑」不等于「别人装了能跑」：按**提交树**验，不按工作区验。
 *
 * 为什么需要（2026-11-02 实伤，已发出去一个坏版本）：
 *   dsh-session-handoff 0.18.16 里 `lib/index.js` 早就 import 了 `./moderation.js`，
 *   而那个文件一直躺在工作区、从没进 git。于是：
 *     · 本机 `npm pack` 打出来是**好的**（npm 打工作区，未跟踪文件也带走）
 *     · 本机测试 142/142 全绿（文件就在磁盘上）
 *     · 任何从 GitHub 装的机器在 import 阶段就失败
 *   判据错在"验的对象"：`github:` 规格发出去的是 **git 树**，不是工作区。
 *
 * 这个脚本对每个 git 仓库：
 *   1. 取 HEAD 的文件清单（git ls-tree），按 package.json 的 `files` 白名单筛出"会发出去的"文件
 *   2. 解析这些文件里的**相对 import**（./x.js、../y.js）
 *   3. 检查每个目标是否在**同一棵提交树**里；main/exports 指向的入口也一样
 *   4. 顺带报「工作区里有、但没提交」的文件 —— 那正是这次漏掉的那类
 *
 * 用法：
 *   node commit-integrity.mjs                     # 扫默认的插件目录集合
 *   node commit-integrity.mjs --dir=<repo> ...    # 指定仓库（可多个）
 * 退出码：0 全部自洽；1 有断链；2 参数/取不到
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'

const HOME = homedir()
const argDir = process.argv.filter((a) => a.startsWith('--dir=')).map((a) => a.slice(6))
const SCAN_ALL = process.argv.includes('--all')
const targets = argDir.length
  ? argDir
  : (() => {
      const out = []
      for (const base of [join(HOME, '.dsh-starter', 'plugins'), join(HOME, 'source', 'repos')]) {
        if (!existsSync(base)) continue
        for (const n of readdirSync(base)) {
          const d = join(base, n)
          try {
            if (statSync(d).isDirectory() && existsSync(join(d, '.git'))) out.push(d)
          } catch {}
        }
      }
      return out
    })()

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const readText = (dir, rel) => {
  try {
    return git(dir, ['show', `HEAD:${rel}`])
  } catch {
    return null
  }
}

// npm 的打包白名单语义（够用的近似）：有 files 就只用 files 匹配到的；package.json 永远发
const matchesFiles = (rel, patterns) => {
  for (const raw of patterns) {
    const p = String(raw).replace(/^\.\//, '').replace(/\/$/, '')
    if (rel === p || rel.startsWith(p + '/')) return true
    if (p.includes('*')) {
      const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
      if (re.test(rel)) return true
    }
  }
  return false
}

const rows = []
for (const dir of targets) {
  if (!existsSync(join(dir, '.git'))) continue
  let tracked = []
  try {
    tracked = git(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean)
  } catch {
    rows.push({ dir, name: dir.split(/[\\/]/).pop(), problems: ['取不到 HEAD（空仓库？）'], untracked: [] })
    continue
  }
  const pkgText = readText(dir, 'package.json')
  let pkg = null
  try {
    pkg = pkgText ? JSON.parse(pkgText) : null
  } catch {}
  // 默认范围：只看我们真正发布的插件（有 dsh 字段 / 名字在自家 scope 内）。
  // 否则 ~/source/repos 里的无关项目会把报告淹掉（46 个仓库里 18 个红，绝大多数与我们无关）。
  if (!SCAN_ALL) {
    let probe = null
    try {
      probe = pkgText ? JSON.parse(pkgText) : null
    } catch {}
    if (!probe) continue
    // 只认真正的 DSH 插件：package.json 里有 dsh 字段。
    // dsh-setup / dsh-starter-kit / dsh-own-plugins / slm 这类元仓库没有 dsh 字段，
    // 它们的 main 是工具入口，不是插件入口，混进来只会制造噪音。
    if (!probe.dsh) continue
  }
  const paths = pkg?.files ? tracked.filter((f) => f === 'package.json' || f === 'README.md' || f === 'LICENSE' || matchesFiles(f, pkg.files)) : tracked
  const published = new Set(paths)

  const problems = []
  const needsBuild = []
  // 入口
  const ex = typeof pkg?.exports === 'string' ? pkg.exports : pkg?.exports?.['.']
  const exEntry = typeof ex === 'string' ? ex : ex?.import ?? ex?.require ?? ex?.default
  const mainDecl = pkg?.main ?? (typeof exEntry === 'string' ? exEntry : null)
  if (mainDecl) {
    const rel = String(mainDecl).replace(/^\.\//, '')
    if (!published.has(rel)) {
      // 「入口不在提交树里」有两种，性质完全不同：
      //   a. 包里有 prepare/build 脚本 → 安装时现场构建（github 依赖 pnpm 会跑 prepare）。
      //      2026-11-02 实测：plugin-guide 用空 config + 空 store 装，dist 照样构建出来。
      //   b. 没有构建脚本 → 装完就是坏的（session-handoff 0.18.16 就是这样发出去的）。
      const scripts = pkg?.scripts ?? {}
      const builds = typeof scripts.prepare === 'string' || typeof scripts.build === 'string' || typeof scripts.preinstall === 'string'
      if (builds) {
        needsBuild.push(`${rel}（由 ${scripts.prepare ? 'prepare' : scripts.build ? 'build' : 'preinstall'} 生成）`)
      } else {
        problems.push(`main 指向的文件不在提交树里，且没有构建脚本: ${mainDecl}`)
      }
    }
  }

  // 相对 import
  const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
  for (const rel of paths) {
    // .d.ts / .d.mts 是类型声明：里面的 `→ ./x.js` 是给类型用的，运行期不会被 import，
    // 声明文件跟实现分开发布是常态（2026-11-02：不排除这一条，13 个仓库里大半是它造成的假红）。
    if (/\.d\.(ts|mts|cts)$/.test(rel)) continue
    if (!/\.(mjs|cjs|js|ts|tsx)$/.test(rel)) continue
    const text = readText(dir, rel)
    if (!text) continue
    let m
    IMPORT_RE.lastIndex = 0
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1]
      // 模板串（./data/${id}.json）与通配不是静态路径
      if (/[$*]/.test(spec) || spec.includes('{')) continue
      const base = posix.normalize(posix.join(posix.dirname(rel), spec))
      // TypeScript/Node 允许省略扩展名，也允许目录 → /index.*
      const candidates = [
        base,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.json`,
        posix.join(base, 'index.js'),
        posix.join(base, 'index.mjs'),
        posix.join(base, 'index.ts'),
        posix.join(base, 'index.tsx'),
      ]
      if (candidates.some((c) => published.has(c))) continue
      problems.push(`${rel} → ${spec}（提交树里没有 ${base} 及候选）`)
    }
  }

  // 工作区有、但没提交的（这次漏掉的那类）
  let untracked = []
  try {
    untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter((f) => f && /\.(js|mjs|cjs|ts|json)$/.test(f))
  } catch {}

  rows.push({ dir, name: pkg?.name ?? dir.split(/[\\/]/).pop(), version: pkg?.version, published: paths.length, tracked: tracked.length, problems, needsBuild, untracked })
}

let bad = 0
for (const r of rows) {
  if (r.problems.length) bad++
  const tag = r.problems.length ? '✗ 断链' : '✓ ok  '
  console.log(`${tag} ${String(r.name).padEnd(38)} ${String(r.version ?? '?').padEnd(9)} 发布文件 ${r.published ?? 0}/${r.tracked ?? 0}`)
  for (const p of r.problems.slice(0, 6)) console.log(`        · ${p}`)
  for (const nb of (r.needsBuild ?? [])) console.log(`        ⚙ 装时构建: ${nb}`)
  if (r.untracked?.length) {
    console.log(`        ⚠ 工作区未提交 ${r.untracked.length} 个: ${r.untracked.slice(0, 4).join(', ')}${r.untracked.length > 4 ? ' …' : ''}`)
  }
}
console.log(`\n仓库 ${rows.length}：自洽 ${rows.length - bad}、断链 ${bad}`)
console.log('口径：按 git HEAD 的树验（GitHub 发出去的就是它）；工作区未提交的文件**不算已发布**。')
process.exit(bad ? 1 : 0)
