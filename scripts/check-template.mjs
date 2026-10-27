#!/usr/bin/env node
/**
 * dsh-setup 模板一致性检查（零依赖）。
 *
 * 存在理由：这个模板曾经腐化到 README 与代码互相矛盾 —— 弃用包留在清单里、
 * 顶层"信息副本"把 @snow-the/* 钉在 0.1.x 精确版本、allowBuilds 缺条目、
 * pnpm.overrides 还压着 0.1.x 时代的 dsh-agent。这些都是**能被机器判定的**，
 * 却一直没人判。本脚本把它们变成 CI 断言。
 *
 * 自证约定（2026-10-19 重构）：
 *   每条检查都有**稳定 ID**，输出里带 `[1a]`。这不是装饰 ——
 *   - check-template.selftest.mjs 断言"某条变异必须由**指定的那条**规则抓到"，
 *     而不是笼统的"退出码非 0"。否则一条变异被别的规则误抓，测试照样绿，
 *     而那条真正要验的规则从没被证明过。
 *   - 本脚本运行到最后会断言 **CHECKS 里登记过的每一条都真的执行过**。
 *     代码与清单一旦漂移（某条检查因为分支改动不再运行），立刻失败。
 *     这一条防的正是"规则静默不触发"—— 比规则本身出错更危险。
 *
 * 用法：
 *   node scripts/check-template.mjs            跑检查
 *   node scripts/check-template.mjs --list-checks   列出全部检查 ID（给自检读覆盖用）
 *
 * 退出码 0 = 模板自洽；1 = 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, 'profiles', 'web');

// ---------- 检查登记表 ----------
// 这里的每一条都必须在本进程里至少被触发一次，否则结尾断言失败。
// 新增检查时：先在这里登记，再加一条对应的变异用例，然后才允许写实现逻辑。
const CHECKS = {
  '1': 'profiles/web/package.json 可解析',
  '1a': '每个非官方 bundle 都有对应的 dependency',
  '1b': '依赖里没有已退役的包',
  '1c': '@snow-the/* 使用浮动 github: 引用，未钉精确版本',
  '1d': 'pnpm.overrides 只约束第三方传递依赖，未覆盖宿主包',
  '1e': 'dsh.profile.patchReload 为 live',
  '1f': '宿主世代耦合的包精确钉版本',
  '1g': '宿主自有的 @deepseek-ai/* 未重复声明为 profile 依赖',
  '2': 'pnpm-workspace.yaml 可读、allowBuilds 可解析',
  '2a': '全部 git 依赖都有 allowBuilds 条目',
  '2b': 'allowBuilds 不含 hash 形式的键',
  '2c': 'allowBuilds 不含 sha 为空的坏条目',
  '2d': '.npmrc 关掉 peer 自动安装（干净安装不依赖 pnpm 默认值）',
  '3': 'cordis.patch.yml 无重复声明',
  '3a': 'cordis.patch.yml 未挂载外部 MCP（外部服务走 skill + CLI）',
  '4': 'cordis.yml 是空列表',
  '5': 'setup.ps1 / setup.sh 都在',
  '5a': '含非 ASCII 的 .ps1 都带 UTF-8 BOM',
  '5b': 'setup.ps1 不使用裸 Get-Content',
  '7': 'README 的文件树列出了 scripts/ 下的全部脚本',
  '8': '第三方门禁盲区记录与模板依赖一致（不陈旧）',
};

if (process.argv.includes('--list-checks')) {
  // checks   = 需要被变异用例覆盖的真实检查
  // synthetic = 自证机制自己的 ID（'6' 由结尾断言产生，不是一条"检查"），
  //             自检脚本可以引用它，但不要求它出现在 CHECKS 里。
  process.stdout.write(JSON.stringify({ checks: Object.keys(CHECKS), synthetic: ['6'] }, null, 2) + '\n');
  process.exit(0);
}

const hit = new Set();
const fails = [];
const passes = [];
const warn = [];
const ok = (id, m) => { hit.add(id); passes.push({ id, m }); };
const bad = (id, m) => { hit.add(id); fails.push({ id, m }); };
const note = (id, m) => { hit.add(id); warn.push({ id, m }); };

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
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  ok('1', 'profiles/web/package.json 解析成功');
} catch (e) {
  bad('1', `profiles/web/package.json 无法解析: ${e.message}`);
}

if (pkg) {
  const deps = pkg.dependencies ?? {};
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  ok('1', `profiles/web/package.json 解析成功（${Object.keys(deps).length} 依赖 / ${bundles.length} bundles）`);

  // 1a. bundles 必须都有来源
  const hostProvided = (n) => n.startsWith('@deepseek-ai/');
  const missing = bundles.filter((b) => !hostProvided(b) && !Object.hasOwn(deps, b));
  if (missing.length) bad('1a', `bundle 在 dependencies 里没有来源（新机器会加载失败）: ${missing.join(', ')}`);
  else ok('1a', '每个非官方 bundle 都有对应的 dependency');

  // 1b. 退役包
  const retiredFound = Object.keys(deps).filter((d) => RETIRED.has(d));
  if (retiredFound.length) for (const r of retiredFound) bad('1b', `依赖里含已退役包 ${r}（${RETIRED.get(r)}）`);
  else ok('1b', '依赖里没有已退役的包');

  // 1c. @snow-the/* 一律浮动引用，不得钉精确版本
  const pinned = Object.entries(deps).filter(([k, v]) => k.startsWith('@snow-the/') && /^\d/.test(String(v)));
  if (pinned.length) bad('1c', `@snow-the/* 被钉成精确版本（会漂移/过期）: ${pinned.map(([k, v]) => `${k}@${v}`).join(', ')}`);
  else ok('1c', '@snow-the/* 全部使用浮动 github: 引用');

  // 1d. pnpm.overrides 只允许用来【约束第三方传递依赖】，不许用来给宿主打补丁。
  //
  // 这条原先是一刀切"不该有 overrides" —— 那是对 0.1.x 时代 `@deepseek-ai/dsh-agent`
  // 那类【宿主补丁】的反应。2026-10-18 出现了合法用法：
  //   @linxin666/dsh-web-all@0.4.x 的内部有 4 个子包写成 `^0.4.x`，会浮动到下一代，
  //   而下一代要求宿主 >=0.2.1-rc.2 —— 在旧宿主上整组装不上（宿主拒绝并回滚）。
  //   把它们钉死只能靠 overrides。
  // 所以规则收窄到它真正想防的东西：不许覆盖 @deepseek-ai/*。
  const overrides = pkg.pnpm?.overrides ?? {};
  const hostOverrides = Object.keys(overrides).filter((k) => k.startsWith('@deepseek-ai/'));
  if (hostOverrides.length) {
    bad('1d', `pnpm.overrides 覆盖了宿主包（0.1.x 时代的做法，在 0.2.x 上会打架）: ${hostOverrides.join(', ')}`);
  } else if (Object.keys(overrides).length) {
    ok('1d', `pnpm.overrides 只约束第三方传递依赖（${Object.keys(overrides).length} 条），未碰宿主包`);
  } else ok('1d', '没有 pnpm.overrides');

  // 1e. patchReload
  if (pkg.dsh?.profile?.patchReload !== 'live') note('1e', 'dsh.profile.patchReload 未设为 "live"');
  else ok('1e', 'dsh.profile.patchReload 为 "live"');

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
  // 我们自己的机器没暴露它，因为本机 lockfile 早就钉在旧版本了 —— 只有全新安装会中招，
  // 也就是只有"新机器"会中招。这正是本模板存在的理由。
  //
  // 2026-10-19 更新：这条规则的价值被再次证实。宿主 0.2.1-rc.2 发布后，
  // commandcode 先发 0.14.0（只认 0.2.1-rc.2），1.5 小时后又发 0.14.1 补成双支持；
  // @linxin666/* 的 0.4.7 则整个 19 个子包都要求 >=0.2.1-rc.2。
  // 浮动引用会在这些发布窗口里随机炸掉全新安装。
  const HOST_COUPLED = new Map([
    ['@mars-sea/dsh-commandcode-provider', '版本表按宿主世代分段：0.12.2/0.12.3 认 0.2.0-rc.2，0.12.4 跳到 0.2.1-alpha.1，0.14.0 只认 0.2.1-rc.2，0.14.1+ 才双支持。^ 和 ~ 对 0.x.y 等价，都拦不住，必须精确钉。'],
    ['@linxin666/dsh-web-all', '0.4.7 把全部 19 个子包的 peer 改成 >=0.2.1-rc.2；0.4.6 及以前是 >=0.2.0-rc.2。另注：它内部有 4 个子包写成 caret，需要靠 pnpm.overrides 一并钉住。'],
    ['@linxin666/dsh-session-archive', '同上：0.4.7 要求 >=0.2.1-rc.2，0.4.6 是 >=0.2.0-rc.2。'],
  ]);
  {
    const drifted = [];
    let pinnedCount = 0;
    for (const [name, why] of HOST_COUPLED) {
      const v = deps[name];
      if (v === undefined) continue;                       // 没装就不管
      if (!/^\d+\.\d+\.\d+$/.test(String(v))) drifted.push(`${name}="${v}"（${why}）`);
      else pinnedCount++;
    }
    if (drifted.length) bad('1f', `宿主世代耦合的包被写成浮动范围（全新安装会被宿主门禁拒绝）: ${drifted.join('; ')}`);
    else ok('1f', `${pinnedCount} 个宿主世代耦合的包都已精确钉版本`);
  }

  // 1g. 宿主自有的 @deepseek-ai/* 不得再作为 profile 依赖装一份。
  //
  // 2026-10-19 实测：宿主自己的 node_modules 里带了 305 个 @deepseek-ai/* 包，
  // 含 dsh-base / dsh-web-app / dsh-mcp-client / dsh-experimental-agent-team-profile。
  // 在 profile 里再钉一份 = 同一个插件两个副本：宿主升级后 profile 那份会静默留在旧版本，
  // 而且两份都注册同一批服务。这是典型的"重复所有者"。
  //
  // 在隔离 profile 上做过对照实验：把 dsh-mcp-client 与
  // dsh-experimental-agent-team-profile 从 dependencies 里删掉后重新安装，
  //   dump-config: exit 0，stderr 0 字节，loader 行 348（与删除前完全一致）
  //   启动: 6s，HTTP 200，__DSH_BOOT__=true，49,360 字节（与删除前完全一致）
  // 所以它们纯属重复；bundles 里保留即可，宿主会解析。
  const hostOwned = Object.keys(deps).filter((d) => d.startsWith('@deepseek-ai/'));
  if (hostOwned.length) {
    bad('1g', `profile 依赖里含宿主自有包（与宿主自带的副本重复，宿主升级后会滞留旧版本）: ${hostOwned.join(', ')}。它们由宿主提供：从 dependencies 删掉，bundles 里保留即可`);
  } else ok('1g', '没有重复声明宿主自有的 @deepseek-ai/* 包');
}

// ---------- 2. allowBuilds 与依赖对齐 ----------
const wsPath = path.join(PROFILE, 'pnpm-workspace.yaml');
const ws = read(wsPath);
const allowed = new Set();
if (!ws) bad('2', 'profiles/web/pnpm-workspace.yaml 缺失');
else {
  // 收集 allowBuilds 的键。
  // 注意：引号键或裸键都要支持，且**引号键里允许含冒号** —— hash 形式的键长这样：
  //   "@snow-the/dsh-search@https://codeload.github.com/.../tar.gz/<sha>": true
  // 早先的写法用 [^":]+ 排除冒号，导致这类键一条都收集不到，"排除 hash 键"的断言因此形同虚设
  // （由 check-template.selftest.mjs 的变异用例抓出）。
  let inBlock = false;
  for (const line of ws.split(/\r?\n/)) {
    if (/^allowBuilds:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (/^\S/.test(line) && line.trim() !== '') { inBlock = false; continue; }
      const m = /^\s+(?:"([^"]+)"|([^:]+)):\s*true\s*$/.exec(line);
      if (m) allowed.add(m[1] ?? m[2].trim());
    }
  }
  ok('2', `pnpm-workspace.yaml allowBuilds 解析出 ${allowed.size} 条`);

  // 2a. 每个 git/url 形式的依赖都必须被放行 —— 缺条目会让全新安装直接失败
  const gitDeps = Object.entries(pkg?.dependencies ?? {}).filter(([, v]) => /^(github:|git\+|https?:)/.test(String(v)));
  const notAllowed = gitDeps.filter(([k]) => !allowed.has(k)).map(([k]) => k);
  if (notAllowed.length) bad('2a', `git 依赖没有 allowBuilds 条目（全新安装会 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）: ${notAllowed.join(', ')}`);
  else ok('2a', `全部 ${gitDeps.length} 个 git 依赖都已 allowBuilds 放行`);

  // 2b. hash 形式的键是某一次安装的产物，必然过期
  const hashed = [...allowed].filter((k) => k.includes('@https://'));
  if (hashed.length) bad('2b', `allowBuilds 含 hash 形式的键（某次安装的产物，会过期）: ${hashed.length} 条，例如 ${hashed[0]}`);
  else ok('2b', 'allowBuilds 不含 hash 形式的键');

  // 2c. 空 sha
  const emptySha = [...allowed].filter((k) => /tar\.gz\/$/.test(k));
  if (emptySha.length) bad('2c', `allowBuilds 含 sha 为空的坏条目: ${emptySha.join(', ')}`);
  else ok('2c', 'allowBuilds 不含 sha 为空的条目');
}

// ---------- 2d. .npmrc：必须自己关掉 peer 自动安装 ----------
// 2026-10-28 实测：只在 pnpm-workspace.yaml 里写 autoInstallPeers: false 不够 —— 那条
// 要 pnpm 以 workspace 模式读到该文件才生效。一旦安装从别的 cwd 发起，或用户级 pnpm
// 配置把 auto-install-peers 打开（pnpm 10 的默认值就是 true），pnpm 就去装 peer，撞上
// 这一代宿主的分发形态：@deepseek-ai/dsh@>=0.2.1、@deepseek-ai/dsh-llm@>=0.2.1 <0.2.2
// 这类 stable-only 范围，而 npm 上只有 prerelease → ERR_PNPM_NO_MATCHING_VERSION，
// 干净机器直接死在安装步骤。
// 修法是不装 peer，而不是给宿主包打 override —— 那会在 profile 里再造一份副本，正是
// [1d] 拦着的事。
const npmrc = read(path.join(PROFILE, '.npmrc'));
if (npmrc === null) {
  bad('2d', 'profiles/web/.npmrc 缺失 —— 用户级 pnpm 配置一旦打开 auto-install-peers，干净机器安装会直接失败');
} else if (!/^\s*auto-install-peers\s*=\s*false\s*$/m.test(npmrc)) {
  bad('2d', 'profiles/web/.npmrc 没有 `auto-install-peers=false`（pnpm-workspace.yaml 里的那条只在 workspace 模式生效，不够）');
} else {
  ok('2d', '.npmrc 关掉了 peer 自动安装（干净安装不再取决于 pnpm 的默认值）');
}

// ---------- 3. patch 层 ----------
const patchPath = path.join(PROFILE, 'cordis.patch.yml');
const patch = read(patchPath);
if (!patch) bad('3', 'profiles/web/cordis.patch.yml 缺失');
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
  if (dupes.length) bad('3', `cordis.patch.yml 里有重复声明（后者的 options 会覆盖前者）: ${dupes.map(([id, l]) => `${id} @${l.map((x) => ':' + x.line).join(',')}`).join('; ')}`);
  else ok('3', `cordis.patch.yml 解析出 ${decls.length} 条声明，无重复`);

  // 3a：外部 MCP 不进模板。判据是同代审计逼出来的：MCP 的 tool schema 是每一次
  // 请求都要付的常驻开销，跟这一轮用不用得着毫无关系（REA 那个 207 工具挂载实测
  // 约 3.1MB schema/请求）。外部服务正确的形状是 skill + CLI —— 不调用就不花钱。
  const mcpDecls = rows.filter((r) => r.name === '@deepseek-ai/dsh-mcp-client');
  const transports = lines.filter((l) => /^\s*transport:\s*\S/.test(l.replace(/(^|\s)#.*$/, '')));
  if (mcpDecls.length || transports.length) bad('3a', `cordis.patch.yml 挂载了外部 MCP（${mcpDecls.length} 条 dsh-mcp-client 声明、${transports.length} 条 transport 配置）—— tool schema 会常驻每次请求，改用 skill + CLI`);
  else ok('3a', 'cordis.patch.yml 没有挂载外部 MCP（外部服务走 skill + CLI）');
}

// ---------- 4. cordis.yml 必须是空列表 ----------
const cordisPath = path.join(PROFILE, 'cordis.yml');
const cordis = read(cordisPath);
if (cordis === null) bad('4', 'profiles/web/cordis.yml 缺失');
else if (!/^\s*\[\s*\]\s*$/m.test(cordis.replace(/(^|\s)#.*$/gm, ''))) bad('4', 'cordis.yml 不是空列表 `[]`（profile 根应保持为空，配置写在 cordis.patch.yml）');
else ok('4', 'cordis.yml 是空列表');

// ---------- 5. setup 脚本存在 ----------
{
  const miss = ['setup.ps1', 'setup.sh'].filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (miss.length) bad('5', `${miss.join(' / ')} 缺失`);
  else ok('5', 'setup.ps1 / setup.sh 都在');
}

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
  let checked = 0, offenders = 0;
  for (const p of walkPs1(ROOT)) {
    checked++;
    const buf = fs.readFileSync(p);
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const nonAscii = buf.some((b) => b > 127);
    if (nonAscii && !hasBom) {
      offenders++;
      bad('5a', `${rel} 含非 ASCII 但缺 UTF-8 BOM —— Windows PowerShell 5.1 会按 ANSI 码页解码，中文乱码导致整个文件解析失败、一行都不执行。修: node scripts/fix-ps1-bom.mjs`);
    }
  }
  if (!offenders) ok('5a', `${checked} 个 .ps1 的编码在 PowerShell 5.1 下可解析`);
}

// 5b. setup.ps1 不得用【裸 Get-Content】读文件。
// 同一个根因的第三面：PS 5.1 的 Get-Content 对无 BOM 的文件按 ANSI 码页解码。
// 第三方包的 package.json 多是 UTF-8 无 BOM，只要含一个中文字符串（dshmarket 的描述就写着
// "可视化插件市场"），读出来就是乱码，而乱码里的引号会打断 JSON → ConvertFrom-Json 抛异常，
// 冒烟测试整个崩掉。必须走 [System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)。
{
  const p = path.join(ROOT, 'setup.ps1');
  if (!fs.existsSync(p)) note('5b', 'setup.ps1 不存在，跳过裸 Get-Content 检查');
  else {
    const offenders = [];
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/(^|\s)#.*$/, '');          // 去掉行尾注释
      if (/\bGet-Content\b/.test(code) && !/-(Encoding|Raw\s+-Encoding)\b/.test(code)) {
        offenders.push(`:${i + 1}`);
      }
    });
    if (offenders.length) {
      bad('5b', `setup.ps1 用了裸 Get-Content（PS 5.1 按 ANSI 解码，无 BOM 的 UTF-8 JSON 会解析失败）: ${offenders.join(', ')}。改用 [System.IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)`);
    } else ok('5b', 'setup.ps1 没有裸 Get-Content（PS 5.1 下读文件是安全的）');
  }
}

// ---------- 7. README 的文件树必须列出全部脚本 ----------
// 2026-10-19 的实况：README 的文件树漏了 4 个脚本（derive-profile、两个自检、e2e-verify、
// fix-ps1-bom），还是照着旧结构写的。散文与代码脱节是必然的，所以能机械判定的就别靠自觉。
// 这里只查"列没列出来"，不查散文里那些数字 —— 数数字的检查自己就会烂。
{
  const readmePath = path.join(ROOT, 'README.md');
  const readme = read(readmePath);
  if (readme === null) bad('7', 'README.md 缺失');
  else {
    const scriptsDir = path.join(ROOT, 'scripts');
    let files = [];
    try { files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')); } catch { /* 无 scripts 目录 */ }
    const missingInReadme = files.filter((f) => !readme.includes(f));
    if (missingInReadme.length) {
      bad('7', `README 的文件树没列出这些脚本（文档与代码已脱节）: ${missingInReadme.join(', ')}`);
    } else ok('7', `README 的文件树列出了全部 ${files.length} 个脚本`);
  }
}

// ---------- 8. 第三方门禁盲区记录不能陈旧 ----------
// 有些第三方包没声明 engines.dsh / peer，或者声明的是 0.2.1 里已删除的包 ——
// 宿主门禁对它们无从判定，装到哪一代都被接受。这些盲区必须**可查**，
// 不能只活在一次审计输出里（那跑完就没了，下一个人还得重新发现一遍）。
//
// 这条检查只防**记录陈旧**：包被删、版本被改而记录没跟，立刻落闸。
// 刻意不联网复核第三方现在的元数据 —— 模板自检不该依赖网络，也不该因为它挂了而失败。
{
  const gapsPath = path.join(ROOT, 'profiles', 'web', 'third-party-gaps.json');
  const pkgPath = path.join(ROOT, 'profiles', 'web', 'package.json');
  const gapsRaw = read(gapsPath);
  const pkgRaw = read(pkgPath);
  const problems = [];
  let count = 0;

  if (gapsRaw === null) problems.push('profiles/web/third-party-gaps.json 缺失 —— 盲区必须有可查的记录');
  else if (pkgRaw === null) problems.push('profiles/web/package.json 缺失，无法核对');
  else {
    let gaps = null;
    let deps = null;
    try { gaps = JSON.parse(gapsRaw).gaps; } catch (e) { problems.push(`third-party-gaps.json 不是合法 JSON: ${e.message}`); }
    try { deps = JSON.parse(pkgRaw).dependencies ?? {}; } catch (e) { problems.push(`package.json 不是合法 JSON: ${e.message}`); }

    if (gaps !== null && deps !== null) {
      if (!Array.isArray(gaps) || gaps.length === 0) {
        problems.push('没有任何条目 —— 若盲区确实已消失，请删掉这个文件并撤掉本条检查，不要留空壳');
      } else {
        const REQUIRED = ['pkg', 'spec', 'gap', 'effect', 'compensate', 'recorded'];
        const seen = new Set();
        for (const g of gaps) {
          const missing = REQUIRED.filter((k) => typeof g?.[k] !== 'string' || !g[k].trim());
          if (missing.length) { problems.push(`${g?.pkg ?? '(无包名)'} 缺字段 ${missing.join('/')}`); continue; }
          if (seen.has(g.pkg)) problems.push(`${g.pkg} 重复登记`);
          seen.add(g.pkg);
          if (!(g.pkg in deps)) problems.push(`${g.pkg} 已不在模板依赖里 —— 记录陈旧`);
          else if (deps[g.pkg] !== g.spec) problems.push(`${g.pkg} 记录 spec=${g.spec} ≠ 模板 ${deps[g.pkg]} —— 记录陈旧`);
        }
        count = gaps.length;
      }
    }
  }

  if (problems.length) bad('8', `第三方门禁盲区记录不可用: ${problems.join('; ')}`);
  else ok('8', `${count} 条第三方门禁盲区记录与模板依赖逐字一致`);
}

// ---------- 6. 自证：登记过的检查必须全部真的执行过 ----------
// 这一条防的是"规则静默不触发"：分支改动让某条检查再也不运行，
// 而它仍然在 CHECKS 里、仍然出现在文档里 —— 那比没有这条检查更危险。
{
  const unhit = Object.keys(CHECKS).filter((id) => !hit.has(id));
  if (unhit.length) {
    fails.push({ id: '6', m: `登记过但本次未执行（代码与清单已漂移）: ${unhit.map((id) => `${id}(${CHECKS[id]})`).join(', ')}` });
  } else {
    passes.push({ id: '6', m: `${Object.keys(CHECKS).length} 条登记的检查全部执行过` });
  }
}

// ---------- 输出 ----------
console.log('dsh-setup 模板一致性检查\n');
for (const p of passes) console.log(`  ✓ [${p.id}] ${p.m}`);
for (const w of warn) console.log(`  · [${w.id}] ${w.m}`);
for (const f of fails) console.log(`  ✗ [${f.id}] ${f.m}`);
console.log(`\n  ${fails.length === 0 ? '通过' : '失败'}: ${passes.length} 项通过, ${fails.length} 项失败, ${warn.length} 项提示`);
process.exit(fails.length ? 1 : 0);
