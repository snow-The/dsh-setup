#!/usr/bin/env node
/**
 * check-template.mjs 的自检（变异测试）。
 *
 * 一个不能失败的守卫不是守卫。本脚本把模板复制到临时目录，逐条注入
 * 【已知应该被抓到】的腐化，断言检查器确实报错。
 *
 * 2026-10-19 重构 —— 从"退出码非 0 就算抓到"升级为三条更严的断言：
 *
 *   1. 【精确归因】每条变异必须声明 expectId，断言**正是那条规则**抓到的。
 *      旧写法只断言 exit != 0，于是"塞回 hash 键"即使是被"git 依赖未放行"误抓，
 *      测试照样绿 —— 而真正要验的那条规则从没被证明过。这是假覆盖。
 *
 *   2. 【覆盖完整性】check-template.mjs 的 CHECKS 里登记的每一条，都必须至少
 *      被一个变异用例覆盖。否则新增一条检查却忘了给它写变异，没有任何机制会提醒。
 *
 *   3. 【自证机制本身】专门有一个用例去破坏 check-template 的
 *      "登记过的检查必须全部执行过"机制，断言它会落闸。否则那条机制可能自己就是死的。
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
function runCheck(dst, extraArgs = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(dst, 'scripts', 'check-template.mjs'), ...extraArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
  // ---- 1: manifest 本体 ----
  {
    label: '把 package.json 写成非法 JSON',
    expectFail: true,
    expectId: '1',
    mutate: (d) => fs.writeFileSync(path.join(d, 'profiles', 'web', 'package.json'), '{ "dependencies": { 坏了 }\n'),
  },
  {
    label: 'bundle 清单里加一个没有依赖来源的包',
    expectFail: true,
    expectId: '1a',
    mutate: (d) => { const j = readPkg(d); j.dsh.profile.bundles.push('@nobody/ghost-plugin'); writePkg(d, j); },
  },
  {
    label: '注入退役包 @liustack/modsearch',
    expectFail: true,
    expectId: '1b',
    mutate: (d) => { const j = readPkg(d); j.dependencies['@liustack/modsearch'] = '^5.10.0'; writePkg(d, j); },
  },
  {
    label: '把 @snow-the/* 钉成精确版本',
    expectFail: true,
    expectId: '1c',
    mutate: (d) => { const j = readPkg(d); j.dependencies['@snow-the/dsh-search'] = '0.4.1'; writePkg(d, j); },
  },
  {
    label: '恢复 pnpm.overrides（0.1.x 时代补丁）',
    expectFail: true,
    expectId: '1d',
    mutate: (d) => { const j = readPkg(d); j.pnpm = { overrides: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' } }; writePkg(d, j); },
  },
  {
    // patchReload 不是 live 时只是一条提示，不构成失败 —— 但它仍然必须被覆盖。
    label: '删掉 dsh.profile.patchReload（应给出提示而非失败）',
    expectFail: false,
    expectId: '1e',
    mutate: (d) => { const j = readPkg(d); delete j.dsh.profile.patchReload; writePkg(d, j); },
  },
  {
    // 2026-10-04 笔电实测: 全新安装时 ^0.12.2 解析到 0.12.4，
    // 而 0.12.4 的 peer 指向 0.2.1-alpha.1（下一代宿主）→ 宿主门禁拒绝整个安装。
    label: '把宿主世代耦合的包改回浮动范围',
    expectFail: true,
    expectId: '1f',
    mutate: (d) => { const j = readPkg(d); j.dependencies['@mars-sea/dsh-commandcode-provider'] = '^0.12.2'; writePkg(d, j); },
  },
  {
    // 2026-10-18: @linxin666/* 在 0.4.7 也跨到了 0.2.1 世代，所以它们进了 HOST_COUPLED。
    label: '把 @linxin666/dsh-web-all 改回浮动范围',
    expectFail: true,
    expectId: '1f',
    mutate: (d) => { const j = readPkg(d); j.dependencies['@linxin666/dsh-web-all'] = '^0.4.2'; writePkg(d, j); },
  },
  {
    // 2026-10-19: 宿主自带 305 个 @deepseek-ai/* 包。再当依赖装一份 = 同一插件两个副本，
    // 宿主升级后 profile 那份会静默滞留旧版本。（已用隔离 profile 做过对照实验证明是重复。）
    label: '把宿主自有的包又声明成 profile 依赖',
    expectFail: true,
    expectId: '1g',
    mutate: (d) => { const j = readPkg(d); j.dependencies['@deepseek-ai/dsh-mcp-client'] = '0.2.1-rc.2'; writePkg(d, j); },
  },
  {
    // overrides 只许约束第三方传递依赖；覆盖宿主包必须落闸。
    label: '在 overrides 里给宿主包打补丁',
    expectFail: true,
    expectId: '1d',
    mutate: (d) => {
      const j = readPkg(d);
      j.pnpm = { overrides: { ...(j.pnpm?.overrides ?? {}), '@deepseek-ai/dsh-agent': '0.1.1-rc.2' } };
      writePkg(d, j);
    },
  },
  // ---- 2: allowBuilds ----
  {
    label: '删掉 pnpm-workspace.yaml',
    expectFail: true,
    expectId: '2',
    mutate: (d) => fs.rmSync(wsFile(d)),
  },
  {
    label: '删掉一个 git 依赖的 allowBuilds 条目',
    expectFail: true,
    expectId: '2a',
    mutate: (d) => {
      const p = wsFile(d);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^\s+"@snow-the\/dsh-search": true\s*$/m, ''));
    },
  },
  {
    label: '塞回一条 hash 形式的 allowBuilds 键',
    expectFail: true,
    expectId: '2b',
    mutate: (d) => {
      const p = wsFile(d);
      fs.appendFileSync(p, '  "@snow-the/dsh-search@https://codeload.github.com/snow-The/dsh-search/tar.gz/deadbeef": true\n');
    },
  },
  {
    label: '塞入一条 sha 为空的 allowBuilds 坏条目',
    expectFail: true,
    expectId: '2c',
    mutate: (d) => {
      const p = wsFile(d);
      fs.appendFileSync(p, '  "@snow-the/dsh-search@https://codeload.github.com/snow-The/dsh-search/tar.gz/": true\n');
    },
  },
  // ---- 3 / 4: patch 层 ----
  {
    label: 'cordis.patch.yml 里制造重复声明',
    expectFail: true,
    expectId: '3',
    mutate: (d) => {
      const p = path.join(d, 'profiles', 'web', 'cordis.patch.yml');
      fs.appendFileSync(p, "\n- insert:\n    - id: mcp-mslearn\n      name: '@deepseek-ai/dsh-mcp-client'\n");
    },
  },
  {
    label: '把 cordis.yml 写成非空列表',
    expectFail: true,
    expectId: '4',
    mutate: (d) => fs.writeFileSync(path.join(d, 'profiles', 'web', 'cordis.yml'), "- id: something\n"),
  },
  // ---- 5: 脚本 ----
  {
    label: '删除 setup.sh',
    expectFail: true,
    expectId: '5',
    mutate: (d) => fs.rmSync(path.join(d, 'setup.sh')),
  },
  {
    // Windows PowerShell 5.1 无 BOM 时按 ANSI 码页读脚本，中文乱码 → 整个文件解析失败。
    label: '剥掉 setup.ps1 的 UTF-8 BOM',
    expectFail: true,
    expectId: '5a',
    mutate: (d) => {
      const p = path.join(d, 'setup.ps1');
      const b = fs.readFileSync(p);
      if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) fs.writeFileSync(p, b.subarray(3));
    },
  },
  {
    // 同一根因的第三面：PS 5.1 的 Get-Content 按 ANSI 解码无 BOM 的 UTF-8，
    // 第三方 package.json 里的中文乱码后打断 JSON。
    label: '在 setup.ps1 里塞一句裸 Get-Content',
    expectFail: true,
    expectId: '5b',
    mutate: (d) => {
      const p = path.join(d, 'setup.ps1');
      fs.appendFileSync(p, '\n$probe = Get-Content -Raw "x.json" | ConvertFrom-Json\n');
    },
  },
  // ---- 6: 自证机制本身 ----
  {
    // 在 CHECKS 里登记一条永远不会被触发的检查。
    // 如果"登记过的检查必须执行过"这条机制是活的，它必须立刻以 [6] 落闸；
    // 如果它死了，这里会静默通过 —— 那才是真正危险的。
    label: '登记一条永不执行的检查（自证机制必须落闸）',
    expectFail: true,
    expectId: '6',
    mutate: (d) => {
      const p = path.join(d, 'scripts', 'check-template.mjs');
      const src = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, src.replace('const CHECKS = {', "const CHECKS = {\n  '9z': '故意登记但永不执行',"));
    },
  },
];

// ---------- 覆盖断言 ----------
// 先从一份干净副本读出 CHECKS 的全部 ID 与自证专用 ID。
const cleanScaffold = scaffold();
let declaredIds = [];
let syntheticIds = [];
try {
  const payload = JSON.parse(runCheck(cleanScaffold, ['--list-checks']).out);
  declaredIds = payload.checks;
  syntheticIds = payload.synthetic ?? [];
} catch (e) {
  console.error('无法从 --list-checks 读取检查清单: ' + e.message);
  process.exit(1);
}
fs.rmSync(cleanScaffold, { recursive: true, force: true });

const covered = new Set(cases.map((c) => c.expectId).filter(Boolean));
const uncovered = declaredIds.filter((id) => !covered.has(id));
const stray = [...covered].filter((id) => !declaredIds.includes(id) && !syntheticIds.includes(id));

console.log('check-template 自检（变异测试）\n');
console.log(`  检查清单: ${declaredIds.length} 条（${declaredIds.join(', ')}）`);
console.log(`  变异用例: ${cases.length} 例\n`);

let good = 0, bad = 0;
for (const c of cases) {
  const d = scaffold();
  c.mutate(d);
  const r = runCheck(d);
  const failed = r.code !== 0;

  let correct = c.expectFail ? failed : !failed;
  let detail = '';

  // 精确归因：必须是指定的那条规则抓到的
  if (correct && c.expectId) {
    const line = r.out.split('\n').find((l) => l.includes(`[${c.expectId}]`) && (l.includes('✗') || l.includes('·')));
    if (!line) {
      correct = false;
      const anyBad = r.out.split('\n').find((l) => l.includes('✗'));
      detail = `归因失败：期望由 [${c.expectId}] 抓到，但输出里没有它${anyBad ? `（实际是: ${anyBad.trim().slice(0, 90)}）` : ''}`;
    } else if (c.expectFail) {
      detail = `→ 抓到: ${line.trim().slice(0, 110)}`;
    } else {
      detail = `→ 提示: ${line.trim().slice(0, 110)}`;
    }
  }

  if (correct) { good++; console.log(`  ✓ ${c.label}`); }
  else {
    bad++;
    console.log(`  ✗ ${c.label}`);
    console.log(`      期望 ${c.expectFail ? '失败' : '通过'}，实际 ${failed ? '失败' : '通过'}（exit ${r.code}）`);
    if (detail) console.log(`      ${detail}`);
    const line = r.out.split('\n').find((l) => l.includes('✗'));
    if (line && !detail) console.log(`      输出: ${line.trim()}`);
  }
  if (correct && detail && c.expectId) console.log(`      ${detail}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ---------- 覆盖结果 ----------
console.log('');
if (uncovered.length) {
  bad++;
  console.log(`  ✗ 覆盖不完整：以下检查没有任何变异用例证明它会落闸: ${uncovered.join(', ')}`);
  for (const id of uncovered) console.log(`      - [${id}]`);
} else {
  console.log(`  ✓ 覆盖完整：${declaredIds.length} 条检查全部有变异用例证明会落闸`);
}
if (stray.length) {
  bad++;
  console.log(`  ✗ 有用例声明了不存在的检查 ID（清单与用例已漂移）: ${stray.join(', ')}`);
}

console.log(`\n  ${bad === 0 ? '自检通过' : '自检失败'}：${good} 正确 / ${bad} 错误（共 ${cases.length} 例）`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
