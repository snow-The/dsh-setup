#!/usr/bin/env node
/**
 * dsh-setup 重写后的端到端验证。
 *
 * 一致性检查只能证明模板"自洽"，证明不了"能装出来"。本脚本把模板复制成一个一次性
 * profile，跑宿主自己的 `dsh plugin --profile <name> install`（它会在 pnpm 之上叠一层
 * 兼容性判定），然后检查：
 *   - 安装是否成功
 *   - 宿主是否报告了会被禁用的插件
 *   - 每个 bundle 是否都有可加载入口（复刻 setup 的冒烟测试）
 * 最后无论成败都删掉那个 scratch profile（除非 --keep）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const HOME = os.homedir();
const REPO = path.join(HOME, 'source', 'repos', 'dsh-setup');
const TEMPLATE = path.join(REPO, 'profiles', 'web');
const PROFILE_NAME = '_p0scratch';
const PROFILE_DIR = path.join(HOME, '.dsh', 'profiles', PROFILE_NAME);
const KEEP = process.argv.includes('--keep');
const SKIP_INSTALL = process.argv.includes('--skip-install');

const log = (s) => console.log(s);

// ---------- 0. 清理旧的一次性 profile ----------
if (fs.existsSync(PROFILE_DIR)) {
  log(`  清理已存在的 ${PROFILE_DIR}`);
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}

// ---------- 1. 复制模板 ----------
fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.cpSync(TEMPLATE, PROFILE_DIR, { recursive: true });
log(`  ✓ 模板已复制到 ${PROFILE_DIR}`);
for (const f of fs.readdirSync(PROFILE_DIR)) log(`      ${f}`);

// ---------- 2. 安装 ----------
let installOk = false;
let installOut = '';
if (!SKIP_INSTALL) {
  log('\n  ==> 安装中（dsh plugin --profile ' + PROFILE_NAME + ' install）…');
  const r = spawnSync('dsh', ['plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR, encoding: 'utf8', shell: true, timeout: 30 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  installOut = ((r.stdout || '') + (r.stderr || '')).toString();
  installOk = r.status === 0;
  log(`  安装 ${installOk ? '成功' : '失败'} (exit ${r.status})`);
  // 只打印有信息量的行
  const interesting = installOut.split(/\r?\n/).filter((l) =>
    /incompatible|allow-version|ERR_|error|warn|Progress|Done|Packages:|\+{3,}|-{3,}/i.test(l) &&
    !/^\s*$/.test(l));
  for (const l of interesting.slice(-35)) log(`      ${l.trim().slice(0, 160)}`);
} else {
  log('\n  (跳过安装)');
}

// ---------- 3. 兼容性判定（宿主自己打的） ----------
const incompatLines = installOut.split(/\r?\n/).filter((l) => /incompatible|allow-version/i.test(l));
log(`\n  ==> 宿主兼容性判定：${incompatLines.length === 0 ? '未报告任何不兼容插件' : incompatLines.length + ' 条'}`);
for (const l of incompatLines.slice(0, 10)) log(`      ${l.trim().slice(0, 160)}`);

// ---------- 4. 复刻 setup 的冒烟测试 ----------
const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'));
const bundles = pkg.dsh?.profile?.bundles ?? [];
const fails = [];
log(`\n  ==> 冒烟测试：${bundles.length} 个 bundle`);
for (const b of bundles) {
  if (b.startsWith('@deepseek-ai/')) continue;   // 官方层由 dsh 宿主提供
  const dir = path.join(PROFILE_DIR, 'node_modules', b);
  const pj = path.join(dir, 'package.json');
  if (!fs.existsSync(pj)) { fails.push(`${b} (未安装)`); continue; }
  const bp = JSON.parse(fs.readFileSync(pj, 'utf8'));
  const main = bp.main || 'index.js';
  if (!fs.existsSync(path.join(dir, main)) && !fs.existsSync(path.join(dir, 'dist', 'index.js'))) {
    fails.push(`${b} (缺少入口: ${main} / dist/index.js)`);
  }
}
if (fails.length) { for (const f of fails) log(`      [FAIL] ${f}`); }
else log('      全部 bundle 入口就位');

// ---------- 5. 插件自己的 peer 声明是否被满足 ----------
// 这是今天那批改动的下游验证：模板装出来的插件必须都带 0.2.0 世代的 peer 声明。
let withPeers = 0, withoutPeers = 0;
const noPeers = [];
const snowDir = path.join(PROFILE_DIR, 'node_modules', '@snow-the');
if (fs.existsSync(snowDir)) {
  for (const n of fs.readdirSync(snowDir)) {
    const pj = path.join(snowDir, n, 'package.json');
    if (!fs.existsSync(pj)) continue;
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const off = Object.keys(j.peerDependencies || {}).filter((k) => k === '@deepseek-ai/dsh' || k.startsWith('@deepseek-ai/dsh-'));
    if (off.length) withPeers++; else { withoutPeers++; noPeers.push(`${j.name}@${j.version}`); }
  }
}
log(`\n  ==> @snow-the/* 声明检查：${withPeers} 个带官方 peer，${withoutPeers} 个没有`);
if (noPeers.length) for (const n of noPeers) log(`      [无 peer] ${n}`);

// ---------- 6. 结论 ----------
const verdict = [];
if (!SKIP_INSTALL && !installOk) verdict.push('安装失败');
if (incompatLines.length) verdict.push(`宿主报告 ${incompatLines.length} 条不兼容`);
if (fails.length) verdict.push(`${fails.length} 个 bundle 缺入口`);
if (withoutPeers) verdict.push(`${withoutPeers} 个插件无 peer 声明`);

log(`\n  ====== 结论: ${verdict.length === 0 ? '通过' : '失败 —— ' + verdict.join('；')} ======`);

if (!KEEP) {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  log(`  已清理 ${PROFILE_DIR}`);
} else {
  log(`  保留 ${PROFILE_DIR}（--keep）`);
}
process.exit(verdict.length === 0 ? 0 : 1);
