#!/usr/bin/env node
/**
 * plugin-load-check.mjs — 在【指定宿主的真实包】上执行插件入口的模块初始化。
 *
 * 为什么需要这一层（2026-10-19 实测）：
 *   · dump-config 只组合 YAML，不解析模块；
 *   · boot 只能证明宿主起来了，插件可能静默降级；
 *   · 而"直接 import 插件入口"看上去最接近真相，却有一个陷阱：
 *     命令行不加约束时，@deepseek-ai/* 会一路向上查找，在本机命中的是
 *     <npx 缓存>/@deepseek-ai/dsh-tools v0.1.5-rc.3 —— 另一个世代。
 *     用 0.1.5 验 0.2.1 的插件，"通过"没有意义。
 *
 * 所以本脚本用 host-map.mjs 把 @deepseek-ai/* 严格钉到 --host 指定的宿主，并且
 * 在跑任何插件之前先做【自证】：解析结果必须落在那个宿主目录里。映射不到即失败，
 * 绝不回退到查找路径上碰巧存在的副本。
 *
 * 自证为什么必须存在：上一版把宿主路径从环境变量读（而调用方用参数传），两条通道没接上
 * 时钩子静默直通。CI 干净环境里表现为响亮失败，本机上却表现为"全过"——
 * 一个会撒谎的护栏。现在没有直通这条路了，自证是第二道锁。
 *
 * 用法：
 *   node scripts/plugin-load-check.mjs --profile web --host <宿主的 node_modules>
 *   node scripts/plugin-load-check.mjs --entries a.js b.js --host <...>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { armHostMap, selfProof } from './host-map.mjs';

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const HOST_NM = argOf('host');
const PROFILE = argOf('profile');
if (!HOST_NM || !existsSync(HOST_NM)) {
  console.error('需要 --host <宿主 node_modules 的绝对路径>，且目录必须存在');
  process.exit(2);
}

// 武装严格解析钩子 —— 必须在任何 import('@deepseek-ai/*') 之前。
try {
  armHostMap(HOST_NM);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(2);
}

/** 从一个 profile 的 node_modules 里枚举所有插件的入口文件。
 *  必须尊重 DSH_HOME —— CI 里 profile 不在 ~/.dsh 下，而是在临时目录。
 *  写死 os.homedir() 会让 CI 报 "profile 不存在"。 */
function entriesForProfile(name) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const nm = path.join(dshHome, 'profiles', name, 'node_modules');
  if (!existsSync(nm)) throw new Error(`profile 不存在: ${nm}（DSH_HOME=${dshHome}）`);
  const out = [];
  for (const scope of readdirSync(nm, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(nm, scope.name);
    if (scope.name.startsWith('@')) {
      for (const pkg of readdirSync(scopeDir, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        const dir = path.join(scopeDir, pkg.name);
        const pj = path.join(dir, 'package.json');
        if (!existsSync(pj)) continue;
        const meta = JSON.parse(readFileSync(pj, 'utf8'));
        // 只验我们自己的插件；宿主包与第三方由别的手段覆盖
        if (!String(meta.name ?? '').startsWith('@snow-the/')) continue;
        const entry = path.join(dir, (meta.main ?? 'index.js').replace(/^\.\//, ''));
        if (existsSync(entry)) out.push(entry);
      }
    }
  }
  return out;
}

let entries;
try {
  entries = PROFILE
    ? entriesForProfile(PROFILE)
    : argv.filter((a, i) => argv[i - 1] === '--entries' || (a.endsWith('.js') && !a.startsWith('--')));
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(2);
}

// 自证：宿主包必须解析到 --host 里那一份。没武装/传错目录都会在这里落闸。
let proven;
try {
  proven = selfProof(HOST_NM, '@deepseek-ai/dsh-tools');
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(2);
}

if (entries.length === 0) {
  console.log('没有找到任何插件入口（这个 profile 里没有 @snow-the/* 插件？）');
  process.exit(0);
}

console.log(`宿主实现: ${HOST_NM}`);
console.log(`自证通过: @deepseek-ai/dsh-tools -> ${decodeURIComponent(new URL(proven).pathname)}`);
console.log(`待验入口: ${entries.length} 个（严格钉住，映射不到即失败）\n`);

let ok = 0;
const failures = [];
for (const entry of entries) {
  const label = `${path.basename(path.dirname(path.dirname(entry)))}/${path.basename(path.dirname(entry))}`;
  try {
    const mod = await import(pathToFileURL(entry).href);
    const info = [];
    if (typeof mod.name === 'string') info.push(`name=${mod.name}`);
    if (Array.isArray(mod.inject)) info.push(`inject=[${mod.inject.join(',')}]`);
    if (typeof mod.apply === 'function') info.push('apply()');
    const exported = Object.keys(mod);
    if (exported.length) info.push(`exports=${exported.slice(0, 5).join(',')}${exported.length > 5 ? '…' : ''}`);
    ok++;
    console.log(`  ✓ ${label.padEnd(32)} ${info.join('  ')}`);
  } catch (e) {
    const msg = String(e?.message ?? e).split('\n')[0].slice(0, 200);
    failures.push(`${label}: ${msg}`);
    console.log(`  ✗ ${label.padEnd(32)} ${msg}`);
  }
}

console.log(`\n汇总: 成功 ${ok} / 失败 ${failures.length} / 共 ${entries.length}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
