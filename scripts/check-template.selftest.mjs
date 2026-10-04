#!/usr/bin/env node
/**
 * check-template.mjs 的自检（变异测试）。
 *
 * 一个不能失败的守卫不是守卫。本脚本把模板复制到临时目录，逐条注入
 * 【已知应该被抓到】的腐化，断言检查器确实报错；并断言干净副本仍然通过。
 *
 * 用法：node scripts/check-template.selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-setup-selftest-'));

/** 把模板骨架复制到 dst（只复制检查器会读的文件）。 */
function scaffold() {
  const dst = fs.mkdtempSync(path.join(TMP, 'case-'));
  fs.mkdirSync(path.join(dst, 'profiles', 'web'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'scripts'), { recursive: true });
  for (const rel of [
    'profiles/web/package.json',
    'profiles/web/pnpm-workspace.yaml',
    'profiles/web/cordis.patch.yml',
    'profiles/web/cordis.yml',
    'setup.ps1',
    'setup.sh',
  ]) {
    fs.copyFileSync(path.join(ROOT, rel), path.join(dst, rel));
  }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'check-template.mjs'), path.join(dst, 'scripts', 'check-template.mjs'));
  return dst;
}

/** 在 dst 上跑检查器，返回 {code, out}。 */
function runCheck(dst) {
  try {
    const out = execFileSync(process.execPath, [path.join(dst, 'scripts', 'check-template.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
}

const readPkg = (d) => JSON.parse(fs.readFileSync(path.join(d, 'profiles', 'web', 'package.json'), 'utf8'));
const writePkg = (d, j) => fs.writeFileSync(path.join(d, 'profiles', 'web', 'package.json'), JSON.stringify(j, null, 2) + '\n');
const wsFile = (d) => path.join(d, 'profiles', 'web', 'pnpm-workspace.yaml');

const cases = [
  {
    label: '对照：未改动的模板必须通过',
    expectFail: false,
    mutate: () => {},
  },
  {
    label: '注入退役包 @liustack/modsearch',
    expectFail: true,
    mutate: (d) => { const j = readPkg(d); j.dependencies['@liustack/modsearch'] = '^5.10.0'; writePkg(d, j); },
  },
  {
    label: '把 @snow-the/* 钉成精确版本',
    expectFail: true,
    mutate: (d) => { const j = readPkg(d); j.dependencies['@snow-the/dsh-search'] = '0.4.1'; writePkg(d, j); },
  },
  {
    label: '恢复 pnpm.overrides（0.1.x 时代补丁）',
    expectFail: true,
    mutate: (d) => { const j = readPkg(d); j.pnpm = { overrides: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' } }; writePkg(d, j); },
  },
  {
    label: '删掉一个 git 依赖的 allowBuilds 条目',
    expectFail: true,
    mutate: (d) => {
      const p = wsFile(d);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^\s+"@snow-the\/dsh-search": true\s*$/m, ''));
    },
  },
  {
    label: '塞回一条 hash 形式的 allowBuilds 键',
    expectFail: true,
    mutate: (d) => {
      const p = wsFile(d);
      fs.appendFileSync(p, '  "@snow-the/dsh-search@https://codeload.github.com/snow-The/dsh-search/tar.gz/deadbeef": true\n');
    },
  },
  {
    label: 'bundle 清单里加一个没有依赖来源的包',
    expectFail: true,
    mutate: (d) => { const j = readPkg(d); j.dsh.profile.bundles.push('@nobody/ghost-plugin'); writePkg(d, j); },
  },
  {
    label: 'cordis.patch.yml 里制造重复声明',
    expectFail: true,
    mutate: (d) => {
      const p = path.join(d, 'profiles', 'web', 'cordis.patch.yml');
      fs.appendFileSync(p, "\n- insert:\n    - id: mcp-mslearn\n      name: '@deepseek-ai/dsh-mcp-client'\n");
    },
  },
  {
    label: '把 cordis.yml 写成非空列表',
    expectFail: true,
    mutate: (d) => fs.writeFileSync(path.join(d, 'profiles', 'web', 'cordis.yml'), "- id: something\n"),
  },
  {
    label: '删除 setup.sh',
    expectFail: true,
    mutate: (d) => fs.rmSync(path.join(d, 'setup.sh')),
  },
  {
    // 2026-10-04 笔电实测: 全新安装时 ^0.12.2 解析到 0.12.4，
    // 而 0.12.4 的 peer 指向 0.2.1-alpha.1（下一代宿主）→ 宿主门禁拒绝整个安装。
    label: '把宿主世代耦合的包改回浮动范围',
    expectFail: true,
    mutate: (d) => { const j = readPkg(d); j.dependencies['@mars-sea/dsh-commandcode-provider'] = '^0.12.2'; writePkg(d, j); },
  },
  {
    // Windows PowerShell 5.1 无 BOM 时按 ANSI 码页读脚本，中文乱码 → 整个文件解析失败。
    label: '剥掉 setup.ps1 的 UTF-8 BOM',
    expectFail: true,
    mutate: (d) => {
      const p = path.join(d, 'setup.ps1');
      const b = fs.readFileSync(p);
      if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) fs.writeFileSync(p, b.subarray(3));
    },
  },
];

console.log('check-template 自检（变异测试）\n');
let good = 0, bad = 0;
for (const c of cases) {
  const d = scaffold();
  c.mutate(d);
  const r = runCheck(d);
  const failed = r.code !== 0;
  const correct = c.expectFail ? failed : !failed;
  if (correct) { good++; console.log(`  ✓ ${c.label}`); }
  else {
    bad++;
    console.log(`  ✗ ${c.label}`);
    console.log(`      期望 ${c.expectFail ? '失败' : '通过'}，实际 ${failed ? '失败' : '通过'}（exit ${r.code}）`);
    const line = r.out.split('\n').find((l) => l.includes('✗'));
    if (line) console.log(`      输出: ${line.trim()}`);
  }
  if (c.expectFail && failed) {
    const hit = r.out.split('\n').find((l) => l.includes('✗'));
    if (hit) console.log(`      → 抓到: ${hit.trim().slice(0, 120)}`);
  }
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${bad === 0 ? '自检通过' : '自检失败'}：${good} 正确 / ${bad} 错误（共 ${cases.length} 例）`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
