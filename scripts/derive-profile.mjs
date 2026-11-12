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
 *   3. pnpm-workspace.yaml 的 onlyBuiltDependencies（pnpm 10 的鍵；pnpm 11 才改叫 allowBuilds）
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
import os from 'node:os';
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
// --prefer-local：线上 profile 要的是「工作副本」不是「仓库快照」。
// 理由（实测）：生成物把 23 个自有插件从 file: 改成 github:，而本地常有不
// 未推送的改动（例如 lab 的多写者基础 c0ecfa8）；照抄生成物等于把线上回退成
// 旧版，而且没有任何报错。所以线上用同一个意图 + 本地源。
const PREFER_LOCAL = process.argv.includes('--prefer-local');
// --out <dir>：把生成物写到别处（线上 profile 目录），不污染模板仓库。
const OUT_IDX = process.argv.indexOf('--out');
const OUT_DIR = OUT_IDX >= 0 ? process.argv[OUT_IDX + 1] : null;

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
  'npm', 'github', 'local', 'derivedOverridesFrom', 'buildDeps', 'bundleOrder', 'aggregates']);
for (const k of forReal) if (!KNOWN.has(k)) fail(`意图里有未知字段 "${k}"（拼错了？）`);

const npmDeps = intent.npm ?? {};
const ghDeps = intent.github ?? {};
const localDeps = intent.local ?? {};
const hostBundles = intent.hostBundles ?? [];
const buildDeps = intent.buildDeps ?? [];
const bundleOrder = intent.bundleOrder ?? [];
const aggregates = intent.aggregates ?? {};

/**
 * local 依赖的目录解析。~ 展开成家目录是必须的：
 * 用 ../../ 相对路径时，一旦脚本被复制到别处（selftest 的 scaffold）或从别的 cwd 跑，
 * 同一个意图字符串就指向两个不同的目录 —— 那是"配置看起来对、装出来是错的"。
 * file: 值必须落在绝对路径上，pnpm 才不依赖 cwd。
 */
function localDir(rel) {
  if (rel === '~') return os.homedir();
  if (rel.startsWith('~/') || rel.startsWith('~\\')) return path.join(os.homedir(), rel.slice(2));
  return path.resolve(ROOT, rel);
}

// ---------- 结构断言 ----------
for (const [name, v] of Object.entries(npmDeps)) {
  if (!/^\d+\.\d+\.\d+$/.test(String(v))) fail(`npm 依赖 ${name} 的版本是 "${v}"，必须是精确版本（不能是范围）`);
}
for (const [name, v] of Object.entries(ghDeps)) {
  if (!/^[\w.-]+\/[\w.-]+(#[\w./-]+)?$/.test(String(v))) fail(`github 依赖 ${name} 的值 "${v}" 不是 owner/repo[#ref] 形式`);
}
for (const [name, rel] of Object.entries(localDeps)) {
  if (typeof rel !== 'string' || rel.length === 0) { fail(`local 依赖 ${name} 的值不是路徑`); continue; }
  const dir = localDir(rel);
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) { fail(`local 依赖 ${name} 指向 ${rel}，但那里没有 package.json`); continue; }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch (e) { fail(`local 依赖 ${name} 的 package.json 无法解析: ${e.message}`); continue; }
  // 名字對不上就等於把錯的目錄掛上去 —— 這種錯在宿主啟動時只會表現成「插件沒生效」
  if (pkg.name !== name) fail(`local 依赖 ${name} 指向的目錄其 package.json name 是 "${pkg.name}"`);
}
for (const b of hostBundles) if (!/^@deepseek-ai\//.test(b)) fail(`hostBundles 里的 ${b} 不是 @deepseek-ai/* 包名`);

const deps = {};
for (const [k, v] of Object.entries(npmDeps)) deps[k] = v;
for (const [k, v] of Object.entries(ghDeps)) deps[k] = `github:${v}`;
for (const [k, v] of Object.entries(localDeps)) deps[k] = `file:${localDir(v).replaceAll('\\', '/')}`;

for (const b of hostBundles) if (Object.hasOwn(deps, b)) {
  fail(`${b} 同时出现在 hostBundles 和 dependencies 里 —— 同一插件两个副本，宿主升级后 profile 那份会滞留旧版本`);
}

if (new Set(bundleOrder).size !== bundleOrder.length) {
  const seen = new Set(), dup = new Set();
  for (const b of bundleOrder) { if (seen.has(b)) dup.add(b); seen.add(b); }
  fail(`bundleOrder 有重复: ${[...dup].join(', ')}`);
}

/**
 * 把 github: 依赖换成机器上真实存在的本地目录（工作副本）。
 * 只认 package.json 里 name 完全一致的目录 —— 名字对不上就是把错的东西挂上去，
 * 这种错在宿主启动时只表现成「插件没生效」。找不到就保留 github:，不猜。
 */
function localForGithub(name, spec) {
  const repo = String(spec).split('#')[0];
  const bare = repo.split('/')[1];
  if (!bare) return null;
  for (const base of [path.join(os.homedir(), 'source/repos/dsh-workspace', 'plugins'), path.join(os.homedir(), 'source', 'repos')]) {
    const dir = path.join(base, bare);
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    try {
      if (JSON.parse(fs.readFileSync(pkgFile, 'utf8')).name === name) return dir;
    } catch { /* 目录坏了就当没有；不静默挂上去 */ }
  }
  return null;
}

if (PREFER_LOCAL) {
  const swapped = [];
  for (const [k, v] of Object.entries(deps)) {
    if (!String(v).startsWith('github:')) continue;
    const dir = localForGithub(k, String(v).slice('github:'.length));
    if (dir) { deps[k] = 'file:' + dir.replaceAll('\\', '/'); swapped.push(k); }
  }
  console.log(`  --prefer-local: ${swapped.length} 个 github 依赖改用本地工作副本`);
}

const hostSet = new Set(hostBundles);

// ---------- 聚合包 ----------
// 聚合包（bundle）只插入成员的 row，不搬任何代码；成员仍是独立套件、单独安装。
// 线上 profile 就是这形状：bundles 里列 5 个聚合包，成员只作为依赖装着。
// 所以「装了却从不挂载」的判定必须认得传递挂载，否则会逼着人把成员也列一遍 ——
// 而同一个 id 被两层宣告时，后写入的那层静默胜出（实测自官方 dsh-base：
// 第一次我把 dsh-memory 同时写进聚合包和 profile.bundles，是错的）。
const memberOf = new Map(); // member -> [aggregate]
for (const [bundle, members] of Object.entries(aggregates)) {
  if (!Array.isArray(members) || members.length === 0) { fail(`aggregates 里的 ${bundle} 没有成员列表`); continue; }
  if (!Object.hasOwn(deps, bundle)) fail(`聚合包 ${bundle} 没有依赖来源（npm/github/local 都不在）`);
  if (!bundleOrder.includes(bundle)) fail(`聚合包 ${bundle} 不在 bundleOrder 里 —— 装了却从不挂载`);
  for (const m of members) {
    if (typeof m !== 'string' || !m) { fail(`聚合包 ${bundle} 的成员里有非字符串`); continue; }
    // 成员也必须是依赖：聚合包只写 row，加载时仍按包名从 profile 的 node_modules 解析，
    // 依赖里没有它就等于「声明了却不装」——宿主启动时才炸，而且报的是找不到包。
    if (!Object.hasOwn(deps, m) && !hostSet.has(m)) fail(`聚合包 ${bundle} 的成员 ${m} 没有依赖来源（成员也必须是依赖）`);
    if (bundleOrder.includes(m)) fail(`${m} 同时被聚合包 ${bundle} 宣告、又直接列在 bundleOrder 里 —— 同一 id 两层宣告，后者静默胜出`);
    if (memberOf.has(m)) fail(`${m} 同时属于多个聚合包: ${memberOf.get(m).concat(bundle).join(', ')}`);
    memberOf.set(m, [bundle]);
  }
}
for (const [bundle, members] of Object.entries(aggregates)) {
  if (!Array.isArray(members)) continue;
  for (const m of members) if (hostSet.has(m) && Object.hasOwn(deps, m)) fail(`聚合包成员 ${m} 同时是宿主层，不需要再作为依赖`);
}

for (const b of bundleOrder) {
  if (hostSet.has(b)) continue;
  if (!Object.hasOwn(deps, b)) fail(`bundleOrder 里的 ${b} 既不是宿主层、也不在 dependencies 里有来源（新机器会加载失败）`);
}
for (const d of Object.keys(deps)) {
  if (!bundleOrder.includes(d) && !memberOf.has(d)) fail(`依赖 ${d} 不在 bundleOrder 里、也不是任何聚合包的成员 —— 装了却从不挂载，是纯负重`);
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
    const subDeps = npmView(`${parent}@${version}`, 'dependencies', { as: 'object' });
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
    const scripts = npmView(`${name}@${version}`, 'scripts', { as: 'object' });
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
    const scripts = npmView(`${name}@${version}`, 'scripts', { as: 'object' });
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
  // pnpm 10 的鍵是 onlyBuiltDependencies（字串陣列）；allowBuilds 是 pnpm 11 的 map 形式。
  // 這個 profile 的 intent 釘的是 pnpm@10.14.0，所以只能寫陣列形式——寫 map 會被 pnpm 10 忽略
  // （實測：pnpm config get allowBuilds 只回 [object Object]，build scripts 照樣被擋）。
  const q = (n) => `  - "${n}"`;
  const lines = [
    '# Git-hosted plugins must run their build (prepare) script, and pnpm refuses unless each one is',
    '# allowlisted. This list is NOT optional: a missing entry makes a fresh install die with',
    '# ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED and leaves the plugin without its dist/.',
    '#',
    '# GENERATED by scripts/derive-profile.mjs from plugins.intent.json — do not hand-edit.',
    '# 鍵名是 pnpm 10 的 onlyBuiltDependencies（字串陣列）。pnpm 11 改成 allowBuilds map，',
    '# 兩者互不相容：寫成 v11 形式，pnpm 10 會靜默忽略，於是 build script 全部被擋。',
    '# intent 釘的是 pnpm@10.14.0，所以這裡必須用 v10 的形式。',
    'onlyBuiltDependencies:',
    '  # --- github:/file: deps: each builds its own dist/ in a prepare script ---',
    ...allow.gitLike.map(q),
    '  # --- npm deps that declare a build script ---',
    ...allow.npmWithBuild.map(q),
    '  # --- transitive native/tooling packages declared in plugins.intent.json buildDeps ---',
    ...allow.buildDeps.map(q),
  ];
  return lines.join('\n') + '\n';
}

/** 把 workspace yaml 的 allowBuilds（舊）或 onlyBuiltDependencies（新）段換成生成版。 */
function applyAllowBuilds(current) {
  const lines = current.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^(allowBuilds|onlyBuiltDependencies):\s*$/.test(l));
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
if (OUT_DIR) {
  // --out：以模板仓库的 workspace 为基底渲染，写到目标目录（线上 profile）。
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPkg = path.join(OUT_DIR, 'package.json');
  const outWs = path.join(OUT_DIR, 'pnpm-workspace.yaml');
  const rendered = applyAllowBuilds(fs.readFileSync(WS_PATH, 'utf8'));
  if (rendered === null) { console.error('  找不到 allowBuilds: 段，无法推导'); process.exit(1); }
  if (!WRITE) {
    console.log('  (dry) 将写入 ' + outPkg + ' 与 ' + outWs);
    process.exit(0);
  }
  fs.writeFileSync(outPkg, newPkg, 'utf8');
  fs.writeFileSync(outWs, rendered, 'utf8');
  console.log('  ✓ 已写入 ' + OUT_DIR);
  process.exit(0);
}
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
console.log(`  推导: overrides ${Object.keys(overrides).length} 条 · onlyBuiltDependencies ${allow.gitLike.length + allow.npmWithBuild.length + allow.buildDeps.length} 条`);
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
