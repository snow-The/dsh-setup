#!/usr/bin/env node
/**
 * derive-profile.mjs — 从【意图】推导出 profile 的生成物（零依赖）。
 *
 * 为什么要有它：
 *   这个模板此前的 24 条依赖、30 行 allowBuilds、4 条 overrides 全是手工维护的快照。
 *   历史是 20 多条 fix/sync/chore/bump —— 每一处腐化都被单独记住，没有任何一处能被整体验证。
 *   现在把"人该决定什么"收敛到 profiles/web/plugins.intent.json，
 *   其余全部由规则推导；生成物与意图不一致时 CI 直接拒。
 *
 * 推导规则（每条都有理由，不是约定俗成）：
 *
 *   1. dependencies
 *        = intent.npm（精确版本）+ intent.github（owner/repo[#ref]，转成 github: 形式）
 *      npm 必须精确钉版本：这些包按宿主世代分段发布，而 ^ 与 ~ 对 0.x.y 完全等价
 *      （都是 <0.(x+1).0），拦不住补丁级的世代跳变。
 *
 *   2. pnpm.overrides
 *        = 对 intent.derivedOverridesFrom 里每个包，查它【当前版本】的 dependencies，
 *          把其中所有带 ^/~ 的子包钉到【同一个版本】。
 *      这一条是推导出来的，不是抄的 —— 所以"那 4 条 override"永远不会过期。
 *
 *   3. pnpm-workspace.yaml 的 allowBuilds
 *        = 所有 github:/file: 依赖        （它们的 prepare 脚本必须放行，缺一条就装不上）
 *        ∪ 声明了 preinstall/install/postinstall/prepare 的 npm 依赖
 *        ∪ intent.buildDeps               （传递依赖里的原生包，推导不出来，必须显式声明）
 *      旧写法把全部 24 个依赖都列上，理由是"多列无害" —— 那不是理由，是没人算过。
 *      现在这 4 个纯 npm 包（没有构建脚本）会自然消失。
 *
 *   4. dsh.profile.bundles
 *        = intent.bundleOrder（原样）。顺序是人的决定，脚本不猜。
 *
 * 断言（任一不满足即失败，不落盘）：
 *   · hostBundles 与 dependencies 不能有交集（否则同一插件两个副本）
 *   · bundleOrder 里每一条要么是宿主层、要么在 dependencies 里有来源
 *   · 每个 dependency 都必须出现在 bundleOrder 里（装了却不挂载 = 纯负重）
 *   · bundleOrder 无重复
 *   · npm 版本必须是精确版本，不能是范围
 *   · derivedOverridesFrom 里每个包必须是 npm 依赖
 *
 * 用法：
 *   node scripts/derive-profile.mjs            # 检查生成物是否与意图一致（默认，安全）
 *   node scripts/derive-profile.mjs --write    # 重新生成并落盘
 *   node scripts/derive-profile.mjs --offline  # 跳过 npm 查询（只验证结构与依赖/顺序）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmView, hasBuildScript } from './npm-view.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, 'profiles', 'web');
const INTENT_PATH = path.join(PROFILE, 'plugins.intent.json');
const PKG_PATH = path.join(PROFILE, 'package.json');
const WS_PATH = path.join(PROFILE, 'pnpm-workspace.yaml');

const WRITE = process.argv.includes('--write');
const OFFLINE = process.argv.includes('--offline');

const problems = [];
const fail = (m) => problems.push(m);

// ---------- 读取意图 ----------
let intent;
try {
  intent = JSON.parse(fs.readFileSync(INTENT_PATH, 'utf8'));
} catch (e) {
  console.error(`无法解析 ${path.relative(ROOT, INTENT_PATH)}: ${e.message}`);
  process.exit(1);
}

// 以 $comment 开头的键是给人看的文档，不参与推导
const forReal = Object.keys(intent).filter((k) => !k.startsWith('$'));
const KNOWN = new Set(['profileName', 'packageManager', 'patchReload', 'runtime', 'hostBundles',
  'npm', 'github', 'derivedOverridesFrom', 'buildDeps', 'bundleOrder']);
for (const k of forReal) if (!KNOWN.has(k)) fail(`意图里有未知字段 "${k}"（拼错了？）`);

const npmDeps = intent.npm ?? {};
const ghDeps = intent.github ?? {};
const hostBundles = intent.hostBundles ?? [];
const buildDeps = intent.buildDeps ?? [];
const bundleOrder = intent.bundleOrder ?? [];

// ---------- 结构断言 ----------
for (const [name, v] of Object.entries(npmDeps)) {
  if (!/^\d+\.\d+\.\d+$/.test(String(v))) fail(`npm 依赖 ${name} 的版本是 "${v}"，必须是精确版本（不能是范围）`);
}
for (const [name, v] of Object.entries(ghDeps)) {
  if (!/^[\w.-]+\/[\w.-]+(#[\w./-]+)?$/.test(String(v))) fail(`github 依赖 ${name} 的值 "${v}" 不是 owner/repo[#ref] 形式`);
}
for (const b of hostBundles) if (!/^@deepseek-ai\//.test(b)) fail(`hostBundles 里的 ${b} 不是 @deepseek-ai/* 包名`);

const deps = {};
for (const [k, v] of Object.entries(npmDeps)) deps[k] = v;
for (const [k, v] of Object.entries(ghDeps)) deps[k] = `github:${v}`;

for (const b of hostBundles) if (Object.hasOwn(deps, b)) {
  fail(`${b} 同时出现在 hostBundles 和 dependencies 里 —— 同一插件两个副本，宿主升级后 profile 那份会滞留旧版本`);
}

if (new Set(bundleOrder).size !== bundleOrder.length) {
  const seen = new Set(), dup = new Set();
  for (const b of bundleOrder) { if (seen.has(b)) dup.add(b); seen.add(b); }
  fail(`bundleOrder 有重复: ${[...dup].join(', ')}`);
}

const hostSet = new Set(hostBundles);
for (const b of bundleOrder) {
  if (hostSet.has(b)) continue;
  if (!Object.hasOwn(deps, b)) fail(`bundleOrder 里的 ${b} 既不是宿主层、也不在 dependencies 里有来源（新机器会加载失败）`);
}
for (const d of Object.keys(deps)) {
  if (!bundleOrder.includes(d)) fail(`依赖 ${d} 不在 bundleOrder 里 —— 装了却从不挂载，是纯负重`);
}

for (const p of intent.derivedOverridesFrom ?? []) {
  if (!Object.hasOwn(npmDeps, p)) fail(`derivedOverridesFrom 里的 ${p} 不是精确钉版本的 npm 依赖（无法据此推导 override）`);
}

// ---------- npm 查询 ----------
// 输出规范化与形状校验都在 npm-view.mjs 里 —— 那里记录了这个接口变过一次、
// 而那次变化静默改变了本脚本的产物（见该文件的头注释）。

/** 推导 overrides：把 derivedOverridesFrom 里各包当前版本的 caret 子依赖钉到同一版本。 */
function deriveOverrides() {
  const out = {};
  for (const parent of intent.derivedOverridesFrom ?? []) {
    const version = npmDeps[parent];
    const subDeps = npmView(`${parent}@${version}`, 'dependencies');
    if (subDeps === undefined) {
      if (!OFFLINE) fail(`查不到 ${parent}@${version} 的 dependencies（网络？）`);
      continue;
    }
    if (!subDeps) continue;
    const floating = Object.entries(subDeps).filter(([, r]) => /^[\^~]/.test(String(r)));
    for (const [name] of floating) out[name] = version;
  }
  // overrides 的键排序，保证产物稳定
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 推导 allowBuilds。 */
function deriveAllowBuilds(overrides) {
  const gitLike = Object.entries(deps)
    .filter(([, v]) => /^(github:|git\+|https?:|file:)/.test(String(v)))
    .map(([k]) => k);

  const npmWithBuild = [];
  for (const [name, version] of Object.entries(npmDeps)) {
    const scripts = npmView(`${name}@${version}`, 'scripts');
    if (scripts === undefined) {
      if (!OFFLINE) fail(`查不到 ${name}@${version} 的 scripts（网络？）`);
      continue;
    }
    if (hasBuildScript(scripts)) npmWithBuild.push(name);
  }

  const sort = (a) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return { gitLike: sort(gitLike), npmWithBuild: sort(npmWithBuild), buildDeps: sort(buildDeps) };
}

// 外部契约（npm view 的输出形状）不认识时，npm-view.mjs 会抛错。
// 这里选择【直接停】而不是把它收进 problems 继续跑：形状不认识意味着我对世界的理解过时了，
// 继续推导只会产出一份看起来正常、实际少了几条 allowBuilds 的清单 —— 那正是已经发生过的故障。
let overrides, allow;
try {
  overrides = deriveOverrides();
  allow = deriveAllowBuilds(overrides);

  // 被 override 钉住的子包同样会被真实安装，所以按【同一条规则】判定，而不是默认放行。
  // （第一版这里直接把它们塞进放行列表 —— 那是猜，不是推导。）
  for (const [name, version] of Object.entries(overrides)) {
    const scripts = npmView(`${name}@${version}`, 'scripts');
    if (scripts === undefined) { if (!OFFLINE) fail(`查不到 ${name}@${version} 的 scripts（网络？）`); continue; }
    if (hasBuildScript(scripts) && !allow.npmWithBuild.includes(name)) allow.npmWithBuild.push(name);
  }
  allow.npmWithBuild.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

// ---------- 渲染 ----------
function renderPackageJson() {
  const sortedDeps = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  const obj = {
    name: intent.profileName,
    private: true,
    ...(intent.packageManager ? { packageManager: intent.packageManager } : {}),
    dependencies: sortedDeps,
    ...(Object.keys(overrides).length ? { pnpm: { overrides } } : {}),
    dsh: { profile: { bundles: bundleOrder, ...(intent.patchReload ? { patchReload: intent.patchReload } : {}) } },
  };
  return JSON.stringify(obj, null, 2) + '\n';
}

function renderAllowBuildsBlock() {
  const q = (n) => `  "${n}": true`;
  const lines = [
    '# Git-hosted plugins must run their build (prepare) script, and pnpm refuses unless each one is',
    '# allowlisted. This list is NOT optional: a missing entry makes a fresh install die with',
    '# ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED and leaves the plugin without its dist/.',
    '#',
    '# GENERATED by scripts/derive-profile.mjs from plugins.intent.json — do not hand-edit.',
    '# The old rule here was "keep this list in sync with `dependencies`" and it listed all 24',
    '# dependencies on the grounds that an extra entry is harmless. That was not a rule, it was',
    '# nobody having computed it: four of those npm packages run no build script at all.',
    '#',
    '# Do NOT paste `name@https://codeload.../tar.gz/<sha>` rows: those were emitted by an older',
    '# pnpm for ONE resolved install and go stale the moment the repo moves. Bare names are what',
    '# pnpm 10 wants — which is why this profile pins packageManager to pnpm 10 (pnpm 11 changed',
    '# the key format to the hashed form).',
    'allowBuilds:',
    '  # --- github:/file: deps: each builds its own dist/ in a prepare script ---',
    ...allow.gitLike.map(q),
    '  # --- npm deps that declare a build script ---',
    ...allow.npmWithBuild.map(q),
    '  # --- transitive native/tooling packages declared in plugins.intent.json buildDeps ---',
    ...allow.buildDeps.map(q),
  ];
  return lines.join('\n') + '\n';
}

/** 把 workspace yaml 里的 allowBuilds 段（含其上方紧邻的注释）换成生成版。 */
function applyAllowBuilds(current) {
  const lines = current.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^allowBuilds:\s*$/.test(l));
  if (idx < 0) return null;

  // 向上吞掉紧邻的整段注释（那是这一段自己的文档）
  let start = idx;
  while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;

  // 向下找到段尾：第一条顶格的非空非注释行
  let end = idx + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '') { end++; continue; }
    if (/^\s/.test(l) || /^\s*#/.test(l)) { end++; continue; }
    break;
  }
  // 段尾的空行留给后面的内容
  while (end > idx + 1 && lines[end - 1].trim() === '') end--;

  const head = lines.slice(0, start).join('\n').replace(/\n+$/, '\n');
  const tail = lines.slice(end).join('\n').replace(/^\n+/, '');
  // head 与生成段之间固定留一个空行（原来那里就有，不该被推导吞掉）
  return head + (head.endsWith('\n') ? '' : '\n') + '\n' + renderAllowBuildsBlock() + (tail ? '\n' + tail : '');
}

// ---------- 比对 / 落盘 ----------
const newPkg = renderPackageJson();
const curPkg = fs.readFileSync(PKG_PATH, 'utf8');
const curWs = fs.readFileSync(WS_PATH, 'utf8');
const newWs = applyAllowBuilds(curWs);

if (newWs === null) fail('pnpm-workspace.yaml 里找不到 allowBuilds: 段，无法推导');

function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return { line: i + 1, cur: la[i], next: lb[i] };
  }
  return null;
}

const diffs = [];
if (curPkg !== newPkg) diffs.push({ file: 'profiles/web/package.json', d: firstDiff(curPkg, newPkg) });
if (newWs !== null && curWs !== newWs) diffs.push({ file: 'profiles/web/pnpm-workspace.yaml', d: firstDiff(curWs, newWs) });

console.log(`意图: ${path.relative(ROOT, INTENT_PATH)}`);
console.log(`  npm ${Object.keys(npmDeps).length} 个 · github ${Object.keys(ghDeps).length} 个 · 宿主层 ${hostBundles.length} 个 · 挂载 ${bundleOrder.length} 条`);
console.log(`  推导: overrides ${Object.keys(overrides).length} 条 · allowBuilds ${allow.gitLike.length + allow.npmWithBuild.length + allow.buildDeps.length} 条`);
console.log('');

if (problems.length) {
  console.log('  断言失败：');
  for (const p of problems) console.log(`    ✗ ${p}`);
  console.log(`\n  共 ${problems.length} 项失败，未落盘。`);
  process.exit(1);
}
console.log('  ✓ 结构断言全部通过');

if (diffs.length === 0) {
  console.log('  ✓ 生成物与意图一致');
  process.exit(0);
}

if (!WRITE) {
  console.log('  ✗ 生成物与意图不一致（有人手改了生成物，或改了意图没重新推导）：');
  for (const { file, d } of diffs) {
    console.log(`    ${file}:${d?.line ?? '?'}`);
    if (d) {
      console.log(`      当前: ${JSON.stringify(d.cur)}`);
      console.log(`      应为: ${JSON.stringify(d.next)}`);
    }
  }
  console.log('\n  修法: node scripts/derive-profile.mjs --write');
  process.exit(1);
}

fs.writeFileSync(PKG_PATH, newPkg, 'utf8');
if (newWs !== null) fs.writeFileSync(WS_PATH, newWs, 'utf8');
console.log(`  ✓ 已重新生成 ${diffs.map((x) => x.file).join(' 与 ')}`);
