#!/usr/bin/env node
/**
 * carry-over-deps.mjs — 「升级不丢你自己加的插件」。
 *
 * 部署脚本第 3 步复制的是模板；模板不认识操作者在部署后自己加的依赖（典型：一个
 * 还在开发中的本地插件，`link:` 到自己的 repo）。复制完它的 bundle 条目就解析不到，
 * 启动时只剩一行 skipping —— 2026-10-28 笔记本上就是这样丢掉了 forge9。
 *
 * 所以把「旧 profile 有、模板没有」的依赖接过来，并把它的 bundle 条目一并补上。
 * 宿主包（@deepseek-ai/*）不接：那些由宿主自己提供，接过来会变成两份副本 ——
 * 正是 check-template [1d] 拦着的 0.1.x 时代做法。
 *
 * 用法: node carry-over-deps.mjs <旧 profile 目录> <新 profile 目录>
 * 输出: 每行 "carried: <name> = <spec>"，没有则输出 "carried: none"
 */
import fs from 'node:fs'
import path from 'node:path'

const [oldDir, newDir] = process.argv.slice(2)
if (!oldDir || !newDir) {
  console.error('用法: node carry-over-deps.mjs <旧 profile 目录> <新 profile 目录>')
  process.exit(2)
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
let oldPkg, newPkg
try {
  oldPkg = read(path.join(oldDir, 'package.json'))
  newPkg = read(path.join(newDir, 'package.json'))
} catch (e) {
  console.error('读不到 package.json: ' + e.message)
  process.exit(2)
}

const oldDeps = oldPkg.dependencies ?? {}
const newDeps = newPkg.dependencies ?? {}
const oldBundles = Array.isArray(oldPkg.dsh?.profile?.bundles) ? oldPkg.dsh.profile.bundles : []
const newBundles = Array.isArray(newPkg.dsh?.profile?.bundles) ? newPkg.dsh.profile.bundles : []

const carried = []
for (const [name, spec] of Object.entries(oldDeps)) {
  if (name.startsWith('@deepseek-ai/')) continue          // 宿主自带，不接
  if (Object.hasOwn(newDeps, name)) continue              // 模板已有（版本以模板为准）
  newDeps[name] = spec
  carried.push(`${name} = ${spec}`)
  if (oldBundles.includes(name) && !newBundles.includes(name)) newBundles.push(name)
}

if (!carried.length) {
  console.log('carried: none')
  process.exit(0)
}

newPkg.dependencies = newDeps
newPkg.dsh = newPkg.dsh ?? {}
newPkg.dsh.profile = newPkg.dsh.profile ?? {}
newPkg.dsh.profile.bundles = newBundles
fs.writeFileSync(path.join(newDir, 'package.json'), JSON.stringify(newPkg, null, 2) + '\n', 'utf8')
for (const c of carried) console.log('carried: ' + c)
