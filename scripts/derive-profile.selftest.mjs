#!/usr/bin/env node
/**
 * derive-profile.selftest.mjs — 推导脚本的变异测试。
 *
 * 理由和 check-template.selftest.mjs 一样：一个不能失败的守卫不是守卫。
 * derive-profile.mjs 有 7 条结构断言 + 1 条"生成物必须与意图一致"，
 * 每一条都必须被证明会落闸，否则它就是装饰。
 *
 * 除最后两条外都用 --offline（断言在查 npm 之前就跑完了，所以不需要网络）。
 * 需要网络的两条：
 *   · 对照：未改动的模板必须 check 通过
 *   · 手改生成物必须被抓到
 *
 * 用法：node scripts/derive-profile.selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeNpmView } from './npm-view.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-selftest-'));

function scaffold() {
  const dst = fs.mkdtempSync(path.join(TMP, 'case-'));
  fs.mkdirSync(path.join(dst, 'profiles', 'web'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'scripts'), { recursive: true });
  for (const rel of [
    'profiles/web/plugins.intent.json',
    'profiles/web/package.json',
    'profiles/web/pnpm-workspace.yaml',
  ]) fs.copyFileSync(path.join(ROOT, rel), path.join(dst, rel));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'derive-profile.mjs'), path.join(dst, 'scripts', 'derive-profile.mjs'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'npm-view.mjs'), path.join(dst, 'scripts', 'npm-view.mjs'));
  return dst;
}

function run(dst, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(dst, 'scripts', 'derive-profile.mjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
}

const intentPath = (d) => path.join(d, 'profiles', 'web', 'plugins.intent.json');
const readIntent = (d) => JSON.parse(fs.readFileSync(intentPath(d), 'utf8'));
const writeIntent = (d, j) => fs.writeFileSync(intentPath(d), JSON.stringify(j, null, 2) + '\n');

const cases = [
  {
    label: '对照：未改动的模板必须 check 通过',
    expectFail: false,
    args: [],
  },
  {
    label: '宿主层又被写进 dependencies（同一插件两个副本）',
    expectFail: true,
    expect: '两个副本',
    args: ['--offline'],
    mutate: (d) => { const j = readIntent(d); j.npm['@deepseek-ai/dsh-base'] = '0.2.1-rc.2'; writeIntent(d, j); },
  },
  {
    label: 'bundleOrder 里加一个没有依赖来源的包',
    expectFail: true,
    expect: '既不是宿主层',
    args: ['--offline'],
    mutate: (d) => { const j = readIntent(d); j.bundleOrder.push('@nobody/ghost'); writeIntent(d, j); },
  },
  {
    label: '装了却不挂载（依赖不在 bundleOrder 里）',
    expectFail: true,
    expect: '纯负重',
    args: ['--offline'],
    mutate: (d) => { const j = readIntent(d); j.npm['@tt-a1i/archify-dsh'] = '1.0.0'; j.bundleOrder = j.bundleOrder.filter((b) => b !== '@tt-a1i/archify-dsh'); writeIntent(d, j); },
  },
  {
    label: 'bundleOrder 里出现重复条目',
    expectFail: true,
    expect: '重复',
    args: ['--offline'],
    mutate: (d) => { const j = readIntent(d); j.bundleOrder.push(j.bundleOrder[j.bundleOrder.length - 1]); writeIntent(d, j); },
  },
  {
    label: 'npm 依赖被写成范围而不是精确版本',
    expectFail: true,
    expect: '精确版本',
    args: ['--offline'],
    mutate: (d) => { const j = readIntent(d); j.npm['@linxin666/dsh-web-all'] = '^0.4.7'; writeIntent(d, j); },
  },
  {
    label: 'derivedOverridesFrom 指向一个非 npm 依赖',
    expectFail: true,
    expect: '不是精确钉版本的 npm 依赖',
    args: ['--offline'],
    mutate: (d) => { const j = readIntent(d); j.derivedOverridesFrom = ['@snow-the/dsh-search']; writeIntent(d, j); },
  },
  {
    label: '意图里出现拼错的未知字段',
    expectFail: true,
    expect: '未知字段',
    args: ['--offline'],
    mutate: (d) => { const j = readIntent(d); j.buildDep = []; writeIntent(d, j); },
  },
  {
    label: '手改生成物（package.json 与意图脱节）',
    expectFail: true,
    expect: '生成物与意图不一致',
    args: [],
    mutate: (d) => {
      const p = path.join(d, 'profiles', 'web', 'package.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      j.dependencies['@injected/by-hand'] = '1.0.0';
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    },
  },
];

console.log('derive-profile 自检（变异测试）\n');
let good = 0, bad = 0;
for (const c of cases) {
  const d = scaffold();
  if (c.mutate) c.mutate(d);
  const r = run(d, c.args);
  const failed = r.code !== 0;
  let correct = c.expectFail ? failed : !failed;
  let detail = '';

  if (correct && c.expect && !r.out.includes(c.expect)) {
    correct = false;
    detail = `归因失败：期望输出包含 "${c.expect}"，实际没有`;
  } else if (correct && c.expect) {
    // 显示【命中期望】的那一行，而不是第一行 —— 一条变异可能同时触发多条断言，
    // 显示第一行会让人以为抓到它的是别的规则。
    const line = r.out.split('\n').find((l) => l.includes('✗') && l.includes(c.expect));
    detail = line ? `→ 抓到: ${line.trim().slice(0, 100)}` : '';
  }

  if (correct) { good++; console.log(`  ✓ ${c.label}`); }
  else {
    bad++;
    console.log(`  ✗ ${c.label}`);
    console.log(`      期望 ${c.expectFail ? '失败' : '通过'}，实际 ${failed ? '失败' : '通过'}（exit ${r.code}）`);
    if (detail) console.log(`      ${detail}`);
    else {
      const line = r.out.split('\n').find((l) => l.includes('✗'));
      if (line) console.log(`      输出: ${line.trim()}`);
    }
  }
  if (correct && detail) console.log(`      ${detail}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ---------- npm view 的输出形状 ----------
// 这些不是模板变异，而是直接对规范化函数做的断言 —— 它们防的是 npm 自己的行为变化。
// 2026-10-19 实测：npm 12 把单结果包成数组之后，旧代码把每个 npm 依赖都判成"没有构建脚本"，
// 生成物安静地丢掉六条 allowBuilds，全程无报错。所以 npm 11 和 npm 12 两种形状都必须被钉住。
const shapeCases = [
  {
    label: 'npm 11 形状：scripts 是裸对象',
    call: () => normalizeNpmView('{"prepare":"tsdown"}', 'p@1.0.0', 'scripts'),
    ok: (v) => v?.prepare === 'tsdown',
  },
  {
    label: 'npm 12 形状：scripts 是单元素数组（这就是那次静默故障）',
    call: () => normalizeNpmView('[{"prepare":"tsdown"}]', 'p@1.0.0', 'scripts'),
    ok: (v) => v?.prepare === 'tsdown',
  },
  {
    label: '空输出 → null（字段不存在，不是"没有构建脚本"的猜测）',
    call: () => normalizeNpmView('  \n ', 'p@1.0.0', 'scripts'),
    ok: (v) => v === null,
  },
  {
    label: '空数组 → null',
    call: () => normalizeNpmView('[]', 'p@1.0.0', 'scripts'),
    ok: (v) => v === null,
  },
  {
    label: '多结果 → 抛错（说明符不精确，继续会取错版本）',
    call: () => normalizeNpmView('[{"a":1},{"b":2}]', 'p@1.0.0', 'scripts'),
    throws: true,
  },
  {
    label: '非 JSON 输出 → 抛错（外部契约变了）',
    call: () => normalizeNpmView('command not found: npm', 'p@1.0.0', 'scripts'),
    throws: true,
  },
  {
    label: '标量 → 抛错',
    call: () => normalizeNpmView('"0.1.0"', 'p@1.0.0', 'scripts'),
    throws: true,
  },
];

for (const c of shapeCases) {
  let threw = false, value;
  try { value = c.call(); } catch { threw = true; }
  const correct = c.throws ? threw : (!threw && c.ok(value));
  if (correct) { good++; console.log(`  ✓ ${c.label}`); }
  else {
    bad++;
    console.log(`  ✗ ${c.label}`);
    console.log(`      期望${c.throws ? '抛错' : '正常返回'}，实际${threw ? '抛错' : `返回 ${JSON.stringify(value)}`}`);
  }
}

console.log(`\n  ${bad === 0 ? '自检通过' : '自检失败'}：${good} 正确 / ${bad} 错误（共 ${cases.length + shapeCases.length} 例）`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
