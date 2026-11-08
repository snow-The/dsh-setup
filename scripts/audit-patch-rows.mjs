/**
 * 把一份真实 profile 的 cordis.patch.yml 与 profiles/web/patch-rows.json 对账。
 *
 * 为什么需要它：patch-rows.json 是「这台机器挂了什么」的可校验记录，
 * 但它只在被人手工更新时才变。删了一条 row、加了一条 row，记录不会自己知道 ——
 * 而少了的那条不会报错，它只是**功能静默消失**（皮肤中心没了、宠物不出现、
 * 鉴权行被删掉而没人察觉）。这个脚本把「记录 vs 现实」的漂移变成可见的。
 *
 * 用法：
 *   node scripts/audit-patch-rows.mjs --live ~/.dsh/profiles/web/cordis.patch.yml
 *       只报告，不改文件；有未登记或已消失的 row 就退出 1
 *   node scripts/audit-patch-rows.mjs --live <path> --write
 *       未登记的 row 以 class=unclassified 写进 patch-rows.json（门禁会因此失败，
 *       直到人给出 structural / personal 的判断 —— 未分类是显式的第三种状态，
 *       不是默认通过）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePatchRows, indexRows } from './patch-rows-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INV = path.join(ROOT, 'profiles', 'web', 'patch-rows.json');

const argv = process.argv.slice(2);
const liveArg = argv[argv.indexOf('--live') + 1];
const WRITE = argv.includes('--write');
if (!argv.includes('--live') || !liveArg || liveArg.startsWith('--')) {
  console.error('需要 --live <profile 的 cordis.patch.yml 路径>（例：~/.dsh/profiles/web/cordis.patch.yml）');
  process.exit(2);
}
const expand = (p) => (p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p);
const livePath = path.resolve(expand(liveArg));
if (!fs.existsSync(livePath)) {
  console.error(`找不到 ${livePath}`);
  process.exit(2);
}

const inv = JSON.parse(fs.readFileSync(INV, 'utf8'));
const recorded = new Map((inv.rows ?? []).map((r) => [r.id, r]));
const live = parsePatchRows(livePath);
const { dups } = indexRows(live);

const unregistered = live.filter((r) => !recorded.has(r.id));
const vanished = [...recorded.keys()].filter((id) => !live.some((r) => r.id === id));
const unclassified = (inv.rows ?? []).filter((r) => !['structural', 'personal'].includes(r.class));

console.log(`实际 patch: ${path.relative(process.cwd(), livePath)}  (${live.length} 条 row)`);
console.log(`记录:       profiles/web/patch-rows.json  (${recorded.size} 条)`);
console.log('');

if (dups.length) console.log(`  ✗ 实际 patch 里有重复 id: ${[...new Set(dups)].join(', ')}`);
if (unregistered.length) {
  console.log(`  ✗ 实际有、记录没有的 row（${unregistered.length}）：`);
  for (const r of unregistered) console.log(`      ${r.id}${r.name ? `  name=${r.name}` : ''}${r.disabled ? '  (disabled)' : ''}  @line ${r.line}`);
}
if (vanished.length) {
  console.log(`  ! 记录有、实际已消失的 row（${vanished.length}）—— 功能静默消失，确认是有意删除再把它从记录里去掉：`);
  for (const id of vanished) console.log(`      ${id}`);
}
if (unclassified.length) {
  console.log(`  ✗ 记录里未分类的 row（${unclassified.length}）：${unclassified.map((r) => r.id).join(', ')}`);
}

if (WRITE && unregistered.length) {
  for (const r of unregistered) {
    inv.rows.push({
      id: r.id,
      ...(r.name ? { name: r.name } : {}),
      ...(r.disabled ? { disabled: true } : {}),
      class: 'unclassified',
      why: `未分类：由 ${new Date().toISOString().slice(0, 10)} 的 audit-patch-rows --write 从实际 patch 抄入。必须给出 structural 或 personal 与理由。`,
    });
  }
  fs.writeFileSync(INV, JSON.stringify(inv, null, 2) + '\n');
  console.log(`\n  已把 ${unregistered.length} 条未登记 row 以 class=unclassified 写入记录。门禁会保持失败直到分类完成。`);
}

const bad = dups.length + unregistered.length + unclassified.length;
if (bad) process.exit(1);
console.log('  ✓ 记录与实际一致，且每条都已分类');
