#!/usr/bin/env node
/**
 * verify-all.mjs — 一条命令跑完这个仓库的验证层级。Windows / Linux 同一份。
 *
 * 为什么不挂在 CI 上（2026-10-19 决定）：GitHub 的 runner 不是我们的机器，行为控不住；
 * 而这个模板的验证需要真的装一份宿主、真的起一次服务。所以验证放在我们自己的
 * Windows 和 Linux 机器上跑，命令就是下面这几条，不依赖任何外部服务。
 *
 * 层级是有先后的，越靠下越接近真相，也越贵：
 *   ① 推导自洽        —— 生成物能否从意图还原（纯静态）
 *   ② 模板自洽        —— 模板自身是否一致（纯静态）
 *   ③ 推导变异自检    —— ①的每条断言是否真的会落闸（纯静态）
 *   ④ 检查器变异自检  —— ②的每条检查是否真的会落闸（纯静态）
 *   ⑤ 真启动一次      —— 装配、服务、无报错（需要一份宿主：--dsh）
 *   ⑥ 插件入口初始化  —— 每个插件在【钉住的宿主】上能否真的 init（需要宿主 node_modules：--host）
 *
 * ①-④ 总是跑。⑤⑥ 需要显式给路径 —— 因为"猜一个宿主"正是本仓库反复踩的坑：
 * 不加约束时 Node 会沿查找路径命中另一个世代的副本，然后给你一个漂亮的假通过。
 * 没给路径时它们被标记为 SKIP 并写明缺哪个参数，绝不静默算通过。
 *
 * 用法：
 *   node scripts/verify-all.mjs                     # 只跑静态四项
 *   node scripts/verify-all.mjs --dsh <宿主 bin> --host <宿主 node_modules> [--profile web]
 *   node scripts/verify-all.mjs --json
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const PROFILE = argOf('profile') ?? 'web';
const DSH = argOf('dsh');
const HOST = argOf('host');
const TIMEOUT = argOf('timeout') ?? '300';
const AS_JSON = argv.includes('--json');

const STATIC = [
  { id: 'derive', title: '推导自洽（生成物与意图一致）', file: 'derive-profile.mjs' },
  { id: 'template', title: '模板自洽（检查表逐条执行）', file: 'check-template.mjs' },
  { id: 'mut-derive', title: '推导断言的变异自检', file: 'derive-profile.selftest.mjs' },
  { id: 'mut-template', title: '检查表的变异自检', file: 'check-template.selftest.mjs' },
];

const GATED = [
  {
    id: 'boot',
    title: '真启动一次（装配 / 服务 / 无报错）',
    file: 'boot-check.mjs',
    missing: DSH ? null : '--dsh',
    args: () => ['--dsh', DSH, '--profile', PROFILE, '--timeout', TIMEOUT],
  },
  {
    id: 'load',
    title: '插件入口在钉住的宿主上初始化',
    file: 'plugin-load-check.mjs',
    missing: HOST ? null : '--host',
    args: () => ['--profile', PROFILE, '--host', HOST],
  },
];

// 子进程的 stderr 里会有 Node 自己的噪音（废弃警告等）。判定行不能是它 ——
// 本仓库实测过：不加过滤时"真启动一次"那一行显示的是 DEP0190 警告，而不是 PASS。
const NOISE = /^\(node:\d+\)|^\(Use `node --trace|DeprecationWarning/;

function run(file, args) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, file), ...args], {
    cwd: path.dirname(HERE),
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
  });
  const ms = Date.now() - started;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
  const clean = out.split('\n').filter((l) => l.trim() !== '' && !NOISE.test(l));
  const code = r.error ? 1 : (r.status ?? 1);
  return { ms, code, out, tail: clean.slice(-4), last: clean[clean.length - 1] ?? '' };
}

/** 终端显示宽度：CJK 占两列，否则中英混排的表格会歪。 */
const dwidth = (s) => [...s].reduce(
  (n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1),
  0,
);
const dpad = (s, w) => s + ' '.repeat(Math.max(0, w - dwidth(s)));

const rows = [];
for (const step of STATIC) {
  const r = run(step.file, []);
  rows.push({ id: step.id, title: step.title, status: r.code === 0 ? 'pass' : 'fail', ms: r.ms, detail: r.last, tail: r.tail });
}
for (const step of GATED) {
  if (step.missing) {
    rows.push({ id: step.id, title: step.title, status: 'skip', ms: 0, detail: `未提供 ${step.missing}`, tail: [] });
    continue;
  }
  const r = run(step.file, step.args());
  rows.push({ id: step.id, title: step.title, status: r.code === 0 ? 'pass' : 'fail', ms: r.ms, detail: r.last, tail: r.tail });
}

const failed = rows.filter((r) => r.status === 'fail');
const skipped = rows.filter((r) => r.status === 'skip');

if (AS_JSON) {
  console.log(JSON.stringify({ ok: failed.length === 0, profile: PROFILE, rows }, null, 2));
} else {
  const pad = Math.max(...rows.map((r) => dwidth(r.title)));
  const mark = { pass: '✓', fail: '✗', skip: '·' };
  console.log('');
  for (const r of rows) {
    console.log(`  ${mark[r.status]} ${dpad(r.title, pad)}  ${String(r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '').padStart(6)}  ${r.detail}`);
    if (r.status === 'fail') for (const l of r.tail) console.log(`      ${l}`);
  }
  console.log('');
  console.log(`  通过 ${rows.filter((r) => r.status === 'pass').length} / 失败 ${failed.length} / 跳过 ${skipped.length}`);
  for (const s of skipped) console.log(`  · ${s.title} 跳过：${s.detail}`);
  if (skipped.length) {
    console.log('  （跳过不等于通过。要覆盖启动层与加载层，给出 --dsh 与 --host。）');
  }
}

process.exit(failed.length ? 1 : 0);
