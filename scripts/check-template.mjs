#!/usr/bin/env node
/**
 * dsh-setup 模板一致性检查（零依赖）。
 *
 * 存在理由：这个模板曾经腐化到 README 与代码互相矛盾 —— 弃用包留在清单里、
 * 顶层"信息副本"把 @snow-the/* 钉在 0.1.x 精确版本、allowBuilds 缺条目、
 * pnpm.overrides 还压着 0.1.x 时代的 dsh-agent。这些都是**能被机器判定的**，
 * 却一直没人判。本脚本把它们变成 CI 断言。
 *
 * 退出码 0 = 模板自洽；1 = 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, 'profiles', 'web');

const fails = [];
const passes = [];
const warn = [];
const ok = (m) => passes.push(m);
const bad = (m) => fails.push(m);
const note = (m) => warn.push(m);

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { bad(`${path.relative(ROOT, p)} 无法解析: ${e.message}`); return null; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ---------- 已退役的包：出现在依赖里即为腐化 ----------
// 每一条都附了退役理由，这样守卫本身就是文档。
const RETIRED = new Map([
  ['@liustack/modsearch', '作者已声明弃用（DSH 0.2.0 原生读图 / 有更好替代）'],
  ['@liustack/modlens', '作者已声明弃用'],
  ['@anionex/dsh-vision-toolkit', '作者已声明弃用；DSH 0.2.0 原生读图'],
  ['@nanmicoder/dsh-agent-teams', '被原生 @deepseek-ai/dsh-experimental-agent-team-profile 取代'],
  ['@openviking/dsh-memory-plugin', 'peer 为 >=0.1.0-rc.6 <0.2.0，在 0.2.0 宿主上必然 ERESOLVE'],
  ['dsh-web', '被 @linxin666/dsh-web-all 取代'],
  ['@linxin666/dsh-web-ui-all', '被 @linxin666/dsh-web-all 取代'],
  ['@linxin666/dsh-client-ui-skin-center', '被 @linxin666/dsh-web-all 内聚'],
  ['@snow-the/dsh-ui-shim', '已退役：它服务于"同时装有两套 UI"的时期（给 DOM 打 data-pane / data-dsh-frame，让插件不依赖官方会变的 class 名）。现在只剩 dsh-web-all 一套 UI；全部自研插件里零处消费它打的标记，两个 profile 也都没装它。它原先 inject 的 @deepseek-ai/dsh-client-runtime 在 0.2.0 里根本不存在 —— 它在 0.2.0 上从未真正跑起来过。'],
]);

// ---------- 1. profile 清单 ----------
const pkgPath = path.join(PROFILE, 'package.json');
const pkg = readJson(pkgPath);
if (pkg) {
  const deps = pkg.dependencies ?? {};
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  ok(`profiles/web/package.json 解析成功（${Object.keys(deps).length} 依赖 / ${bundles.length} bundles）`);

  // 1a. bundles 必须都有来源
  const hostProvided = (n) => n.startsWith('@deepseek-ai/');
  const missing = bundles.filter((b) => !hostProvided(b) && !Object.hasOwn(deps, b));
  if (missing.length) bad(`bundle 在 dependencies 里没有来源（新机器会加载失败）: ${missing.join(', ')}`);
  else ok('每个非官方 bundle 都有对应的 dependency');

  // 1b. 退役包
  const retiredFound = Object.keys(deps).filter((d) => RETIRED.has(d));
  if (retiredFound.length) for (const r of retiredFound) bad(`依赖里含已退役包 ${r}（${RETIRED.get(r)}）`);
  else ok('依赖里没有已退役的包');

  // 1c. @snow-the/* 一律浮动引用，不得钉精确版本
  const pinned = Object.entries(deps).filter(([k, v]) => k.startsWith('@snow-the/') && /^\d/.test(String(v)));
  if (pinned.length) bad(`@snow-the/* 被钉成精确版本（会漂移/过期）: ${pinned.map(([k, v]) => `${k}@${v}`).join(', ')}`);
  else ok('@snow-the/* 全部使用浮动 github: 引用');

  // 1d. pnpm.overrides 是 0.1.x 时代的补丁，不该再有
  if (pkg.pnpm?.overrides && Object.keys(pkg.pnpm.overrides).length) {
    bad(`package.json 仍有 pnpm.overrides（0.1.x 时代的宿主补丁，在 0.2.0 上会打架）: ${JSON.stringify(pkg.pnpm.overrides)}`);
  } else ok('没有 pnpm.overrides');

  // 1e. patchReload
  if (pkg.dsh?.profile?.patchReload !== 'live') note('dsh.profile.patchReload 未设为 "live"');

  // 1f. 宿主世代耦合的第三方包必须【精确钉版本】，不能浮动。
  //
  // 2026-10-04 实测：在一台笔电上全新安装，宿主门禁拒绝了整个安装 ——
  //   @mars-sea/dsh-commandcode-provider@0.12.4 is incompatible with dsh 0.2.0-rc.2
  //   peerDependencies { "@deepseek-ai/dsh-llm": "0.2.1-alpha.1", ... }
  // 模板当时写的是 ^0.12.2，而它的版本表是：
  //   0.12.2  dsh-llm=0.2.0-rc.2      ← 可用
  //   0.12.3  dsh-llm=0.2.0-rc.2      ← 可用
  //   0.12.4  dsh-llm=0.2.1-alpha.1   ← 换成下一代宿主了
  // 【一个 patch 号就换了要求的宿主世代】—— 对这种包，浮动引用是主动制造故障。
  //
  // 而且 ^ 和 ~ 在这里都救不了：对 0.x.y 版本两者等价，都是 >=0.12.2 <0.13.0，
  // 都包含 0.12.4。只能精确钉。
  //
  // 我们自己的机器没暴露它，因为本机 lockfile 早就钉在 0.12.2 了 —— 只有全新安装会中招，
  // 也就是只有"新机器"会中招。这正是本模板存在的理由。
  const HOST_COUPLED = new Map([
    ['@mars-sea/dsh-commandcode-provider', '0.12.4 把 peer 从 dsh-llm=0.2.0-rc.2 换成 0.2.1-alpha.1（下一代宿主）。^/~ 对 0.x.y 等价，都拦不住，必须精确钉。'],
  ]);
  {
    const drifted = [];
    for (const [name, why] of HOST_COUPLED) {
      const v = deps[name];
      if (v === undefined) continue;                       // 没装就不管
      if (!/^\d+\.\d+\.\d+$/.test(String(v))) drifted.push(`${name}="${v}"（${why}）`);
    }
    if (drifted.length) bad(`宿主世代耦合的包被写成浮动范围（全新安装会被宿主门禁拒绝）: ${drifted.join('; ')}`);
    else ok(`${HOST_COUPLED.size} 个宿主世代耦合的包都已精确钉版本`);
  }
}

// ---------- 2. allowBuilds 与依赖对齐 ----------
const wsPath = path.join(PROFILE, 'pnpm-workspace.yaml');
const ws = read(wsPath);
if (!ws) bad('profiles/web/pnpm-workspace.yaml 缺失');
else {
  // 收集 allowBuilds 的键。
  // 注意：引号键或裸键都要支持，且**引号键里允许含冒号** —— hash 形式的键长这样：
  //   "@snow-the/dsh-search@https://codeload.github.com/.../tar.gz/<sha>": true
  // 早先的写法用 [^":]+ 排除冒号，导致这类键一条都收集不到，"排除 hash 键"的断言因此形同虚设
  // （由 check-template.selftest.mjs 的变异用例抓出）。
  const allowed = new Set();
  let inBlock = false;
  for (const line of ws.split(/\r?\n/)) {
    if (/^allowBuilds:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (/^\S/.test(line) && line.trim() !== '') { inBlock = false; continue; }
      const m = /^\s+(?:"([^"]+)"|([^:]+)):\s*true\s*$/.exec(line);
      if (m) allowed.add(m[1] ?? m[2].trim());
    }
  }
  ok(`pnpm-workspace.yaml allowBuilds 解析出 ${allowed.size} 条`);

  // 2a. 每个 git/url 形式的依赖都必须被放行 —— 缺条目会让全新安装直接失败
  const gitDeps = Object.entries(pkg?.dependencies ?? {}).filter(([, v]) => /^(github:|git\+|https?:)/.test(String(v)));
  const notAllowed = gitDeps.filter(([k]) => !allowed.has(k)).map(([k]) => k);
  if (notAllowed.length) bad(`git 依赖没有 allowBuilds 条目（全新安装会 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）: ${notAllowed.join(', ')}`);
  else ok(`全部 ${gitDeps.length} 个 git 依赖都已 allowBuilds 放行`);

  // 2b. hash 形式的键是某一次安装的产物，必然过期
  const hashed = [...allowed].filter((k) => k.includes('@https://'));
  if (hashed.length) bad(`allowBuilds 含 hash 形式的键（某次安装的产物，会过期）: ${hashed.length} 条，例如 ${hashed[0]}`);
  else ok('allowBuilds 不含 hash 形式的键');

  // 2c. 空 sha
  const emptySha = [...allowed].filter((k) => /tar\.gz\/$/.test(k));
  if (emptySha.length) bad(`allowBuilds 含 sha 为空的坏条目: ${emptySha.join(', ')}`);
}

// ---------- 3. patch 层 ----------
const patchPath = path.join(PROFILE, 'cordis.patch.yml');
const patch = read(patchPath);
if (!patch) bad('profiles/web/cordis.patch.yml 缺失');
else {
  // 复刻 dsh-plugin-doctor 的 doctor_patch 解析模型（一个文件即一张 row 列表；
  // `- id: x` 直接形式与 `- insert:` 包裹形式都声明 entry；带 name 的才是声明）。
  const rows = [];
  let cur = null, curIndent = -1;
  const lines = patch.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].replace(/(^|\s)#.*$/, '');
    if (s.trim() === '') continue;
    const indent = s.length - s.trimStart().length;
    const t = s.trim();
    const m = /^-\s*id:\s*(.+)$/.exec(t);
    if (m) { cur = { id: m[1].trim().replace(/^['"]|['"]$/g, ''), name: null, line: i + 1 }; curIndent = indent; rows.push(cur); continue; }
    if (/^-\s*insert:\s*$/.test(t) || t === 'insert:') { cur = null; continue; }
    const kv = /^(name|disabled):\s*(.+)$/.exec(t);
    if (kv && cur && indent > curIndent) { if (kv[1] === 'name') cur.name = kv[2].trim().replace(/^['"]|['"]$/g, ''); continue; }
    if (cur && indent <= curIndent) { cur = null; curIndent = -1; }
  }
  const decls = rows.filter((r) => r.name);
  const byId = new Map();
  for (const d of decls) { const l = byId.get(d.id) ?? []; l.push(d); byId.set(d.id, l); }
  const dupes = [...byId].filter(([, l]) => l.length > 1);
  if (dupes.length) bad(`cordis.patch.yml 里有重复声明（后者的 options 会覆盖前者）: ${dupes.map(([id, l]) => `${id} @${l.map((x) => ':' + x.line).join(',')}`).join('; ')}`);
  else ok(`cordis.patch.yml 解析出 ${decls.length} 条声明，无重复`);
}

// ---------- 4. cordis.yml 必须是空列表 ----------
const cordisPath = path.join(PROFILE, 'cordis.yml');
const cordis = read(cordisPath);
if (cordis === null) bad('profiles/web/cordis.yml 缺失');
else if (!/^\s*\[\s*\]\s*$/m.test(cordis.replace(/(^|\s)#.*$/gm, ''))) bad('cordis.yml 不是空列表 `[]`（profile 根应保持为空，配置写在 cordis.patch.yml）');
else ok('cordis.yml 是空列表');

// ---------- 5. setup 脚本存在 ----------
for (const f of ['setup.ps1', 'setup.sh']) {
  if (!fs.existsSync(path.join(ROOT, f))) bad(`${f} 缺失`);
}
ok('setup.ps1 / setup.sh 都在');

// 5a. 含非 ASCII 的 .ps1 必须有 UTF-8 BOM。
// 这不是理论问题：2026-10-04 在一台笔电（Windows 自带的 PowerShell 5.1）上实测，
// setup.ps1 整个文件解析失败、报 "Unexpected token"，一行都没执行 —— 一键部署在那台机器上
// 等于不存在。根因是 PS 5.1 在没有 BOM 时按系统 ANSI 码页解码脚本（中文机=GBK），
// UTF-8 的中文乱码后打断了字符串字面量。而开发机是 pwsh 7（默认 UTF-8），所以从未暴露。
// 修法: node scripts/fix-ps1-bom.mjs
function walkPs1(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkPs1(p, out);
    else if (e.name.toLowerCase().endsWith('.ps1')) out.push(p);
  }
  return out;
}
{
  let checked = 0;
  for (const p of walkPs1(ROOT)) {
    checked++;
    const buf = fs.readFileSync(p);
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const nonAscii = buf.some((b) => b > 127);
    if (nonAscii && !hasBom) {
      bad(`${rel} 含非 ASCII 但缺 UTF-8 BOM —— Windows PowerShell 5.1 会按 ANSI 码页解码，中文乱码导致整个文件解析失败、一行都不执行。修: node scripts/fix-ps1-bom.mjs`);
    }
  }
  if (checked && !fails.some((f) => f.includes('BOM'))) ok(`${checked} 个 .ps1 的编码在 PowerShell 5.1 下可解析`);
}

// ---------- 输出 ----------
console.log('dsh-setup 模板一致性检查\n');
for (const p of passes) console.log(`  ✓ ${p}`);
for (const w of warn) console.log(`  · ${w}`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`\n  ${fails.length === 0 ? '通过' : '失败'}: ${passes.length} 项通过, ${fails.length} 项失败, ${warn.length} 项提示`);
process.exit(fails.length ? 1 : 0);
