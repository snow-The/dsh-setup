#!/usr/bin/env node
/**
 * plugin-load-check.mjs — 在【指定宿主的真实包】上执行插件入口的模块初始化。
 *
 * 为什么需要这一层（2026-10-19 实测）：
 *   · dump-config 只组合 YAML，不解析模块；
 *   · boot 只能证明宿主起来了，插件可能静默降级；
 *   · 而"直接 import 插件入口"看上去最接近真相，却有一个陷阱：
 *     ~/.dsh/profiles/node_modules 下曾经躺着一份 @deepseek-ai/dsh-tools@0.1.5-rc.3，
 *     Node 向上查找就命中了它 —— 于是"能加载"可能是在【错误的世代】上得出的。
 *
 * 所以本脚本用 esm-host-map.mjs 装一个【严格】解析钩子：@deepseek-ai/* 只能解析到
 * 指定宿主的 node_modules，映射不到直接报错，绝不回退到查找路径上碰巧存在的副本。
 *
 * 用法：
 *   node --import ./esm-host-map.mjs plugin-load-check.mjs --profile web --host <宿主的 node_modules>
 *   node --import ./esm-host-map.mjs plugin-load-check.mjs --entries a.js b.js --host <...>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const HOST_NM = argOf('host');
const PROFILE = argOf('profile');
if (!HOST_NM || !existsSync(HOST_NM)) {
  console.error('需要 --host <宿主 node_modules 的绝对路径>');
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

const entries = PROFILE ? entriesForProfile(PROFILE) : argv.filter((a, i) => argv[i - 1] === '--entries' || (a.endsWith('.js') && !a.startsWith('--')));

if (entries.length === 0) {
  console.log('没有找到任何插件入口（这个 profile 里没有 @snow-the/* 插件？）');
  process.exit(0);
}

console.log(`宿主实现: ${HOST_NM}`);
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
