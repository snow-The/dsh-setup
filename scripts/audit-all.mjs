#!/usr/bin/env node
/**
 * audit-all.mjs —— 一次跑完四条审计轴，并给出**一个**结论。
 *
 * 四条轴各自回答不同的问题，谁都替代不了谁：
 *   依赖   audit-plugins    —— 装的这些包还在不在、是不是负重
 *   同代   audit-generation —— 插件和宿主是不是同一代（需要 --host）
 *   运行时 audit-runtime    —— 起进程 / 开端口 / 定时器 / 绝对路径的静态清单
 *   日志   audit-logs       —— 前缀、等级、值 dump
 *
 * 这个脚本只做汇总，不重写各轴判定 —— 每个轴自己的退出码就是它的结论。
 *
 * 退出码政策：任一条轴失败 => 1。四条轴都只在**真问题**上失败
 * （依赖装不回来 / 同代硬伤 / 日志违规），不对建议性提醒失败 ——
 * 所以它可以直接挂在安装流程里当门禁。
 *
 * 用法：
 *   node scripts/audit-all.mjs --profile-dir ~/.dsh/profiles/web
 *   node scripts/audit-all.mjs --profile-dir ~/.dsh/profiles/web --host <宿主 node_modules>
 */
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const rawProfile = argOf('profile-dir');
const rawHost = argOf('host');
const EXPECT_HOST = argOf('expect-host');
if (!rawProfile) {
  console.error('需要 --profile-dir <profile 目录>（可选 --host <宿主 node_modules>）');
  process.exit(2);
}
const tidy = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
const PROFILE = tidy(rawProfile);
const HOST = rawHost ? tidy(rawHost) : null;
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const AXES = [
  { id: 'deps', file: 'audit-plugins.mjs', label: '依赖（在不在 / 是不是负重）', args: ['--profile-dir', PROFILE] },
  { id: 'generation', file: 'audit-generation.mjs', label: '同代（插件 vs 宿主）', args: ['--profile-dir', PROFILE, '--host', HOST], needs: 'host' },
  { id: 'runtime', file: 'audit-runtime.mjs', label: '运行时（进程 / 端口 / 定时器 / 绝对路径）', args: ['--profile-dir', PROFILE, ...(EXPECT_HOST ? ['--expect-host', EXPECT_HOST] : [])] },
  { id: 'logs', file: 'audit-logs.mjs', label: '日志（前缀 / 等级 / 值 dump）', args: ['--profile-dir', PROFILE] },
];

const results = [];
for (const axis of AXES) {
  if (axis.needs === 'host' && !HOST) {
    results.push({ ...axis, status: 'skipped', detail: '需要 --host' });
    continue;
  }
  const script = path.join(HERE, axis.file);
  const r = spawnSync(process.execPath, [script, ...axis.args], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const code = r.status ?? 1;
  results.push({ ...axis, status: code === 0 ? 'pass' : 'fail', code, out });
}

console.log('');
for (const r of results) {
  const mark = r.status === 'pass' ? '✓' : r.status === 'skipped' ? '–' : '✗';
  console.log(`${mark} ${r.label}${r.detail ? `（${r.detail}）` : ''}`);
  if (r.status === 'fail') {
    // 只回显失败轴的关键行，避免把整份报告再打一遍
    const lines = (r.out ?? '').split('\n').filter((l) => l.trim());
    const tail = lines.slice(-8);
    for (const l of tail) console.log(`    ${l}`);
  }
}

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skipped');
console.log('');
console.log(`通过 ${results.length - failed.length - skipped.length} / 失败 ${failed.length} / 跳过 ${skipped.length}`);
process.exit(failed.length ? 1 : 0);
