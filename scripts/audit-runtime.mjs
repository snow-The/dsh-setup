#!/usr/bin/env node
/**
 * audit-runtime.mjs — 扫插件的【运行时足迹】：谁会偷偷起进程 / 占端口 / 起定时器 / 焊绝对路径。
 *
 * 为什么（2026-10-19 实例）：OC 语料那个 MCP 被挂成 `transport: stdio + command: node`，
 * 于是每次启动 DSH 都 spawn 一个 node 子进程、打开 22 MB SQLite，还把 6 个工具塞进
 * 每一个会话 —— 而它本质上是某个项目自己的独立服务。这类"把项目的生命周期寄生成宿主"
 * 的做法，光看 package.json / patch 是看不出来的，得看【代码里做了什么】。
 *
 * 判据（每条都给出 file:line，不猜）：
 *   ① spawn / execFile / exec / fork      起子进程
 *   ② createServer / listen              占端口
 *   ③ setInterval                        常驻定时器
 *   ④ C:/ 、/home/ 、~/ 开头的绝对路径    不可移植 / 绑定某台机器
 *
 * ⚠ 这是【静态清单】，不是"启动时会执行"的证明。调用点在函数里 = 按需触发；
 *    要判断"启动时到底发生了什么"，唯一可靠的办法是【测量】进程树与端口：
 *
 *      Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dsh.lib.bin.js' }
 *      Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in <上面的 pid 树> }
 *
 *    第一版这里用"调用点上方 5 行有没有 if/env"推断，把
 *    `try { execSync('zstd -d …') }` 这种按需调用的解压也标成了"启动即发生" ——
 *    一个看起来在判断、实际在猜的结论。现在只报事实（有这处调用、开关在不在附近）。
 *
 * 用法：
 *   node scripts/audit-runtime.mjs --profile-dir ~/.dsh/profiles/web
 *   node scripts/audit-runtime.mjs --profile-dir ... --json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const AS_JSON = argv.includes('--json');
const EXPECT_HOST = argOf('expect-host');   // 例如 0.2.1-rc.2
const rawDir = argOf('profile-dir');
if (!rawDir) { console.error('需要 --profile-dir <profile 目录>'); process.exit(2); }
const PROFILE = path.resolve(rawDir.replace(/^~(?=$|[\\/])/, os.homedir()));
const NM = path.join(PROFILE, 'node_modules');

function walk(dir, out = []) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (['node_modules', 'test', 'tests', '__tests__', 'coverage'].includes(it.name)) continue;
      walk(p, out);
    } else if (/\.(mjs|cjs|js)$/.test(it.name)) out.push(p);
  }
  return out;
}

const PATTERNS = [
  { id: 'spawn',   label: '起子进程',   re: /\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/g },
  { id: 'server',  label: '占端口',     re: /\b(createServer|\.listen)\s*\(/g },
  { id: 'timer',   label: '常驻定时器', re: /\bsetInterval\s*\(/g },
  { id: 'abspath', label: '绝对路径',   re: /(['"`])(?:[A-Za-z]:[\\/]|\/home\/|~\/)/g },
];

/** 取命中行所在行号与整行（截断），并看这一行/附近是否被开关守住。 */
function context(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lines = text.split('\n');
  const raw = (lines[line - 1] ?? '').trim();
  // 往上找 4 行看有没有守卫（if / env / 开关）
  const window = lines.slice(Math.max(0, line - 5), line).join('\n');
  const guarded = /process\.env\.|if\s*\(|&&|\?\?|===/.test(window);
  return { line, raw: raw.slice(0, 140), guarded };
}

const rows = [];
const scopes = fs.existsSync(NM) ? fs.readdirSync(NM, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
for (const scope of scopes) {
  if (!scope.name.startsWith('@')) continue;
  const scopeDir = path.join(NM, scope.name);
  for (const d of fs.readdirSync(scopeDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const name = `${scope.name}/${d.name}`;
    if (!name.startsWith('@snow-the/')) continue;
    const pkgDir = path.join(scopeDir, d.name);
    for (const file of walk(pkgDir)) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(PROFILE, file).replace(/\\/g, '/');
      for (const p of PATTERNS) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(text))) {
          const c = context(text, m.index);
          rows.push({ pkg: name, kind: p.id, file: rel, ...c });
        }
      }
    }
  }
}

/* ── 宿主世代一致性 ──
 * 插件实际解析到的 @deepseek-ai/* 版本，必须等于运行中的宿主版本。
 * 这是实测到的真实故障：插件的 @deepseek-ai/* 全部解析到 0.1.5-rc.3
 * （来自 profiles/node_modules 里一套陈旧的 junction 农场），而宿主是 0.2.1 ——
 * 全程无报错，因为 API 面结构性兼容。用 createRequire 走同一套查找，不往插件目录写文件。 */
function nearestVersion(startFile, name) {
  let dir = path.dirname(startFile);
  for (let i = 0; i < 8; i++) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pj.name === name) return { version: pj.version, dir };
    } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }
  return null;
}

const resolution = [];
if (EXPECT_HOST) {
  for (const pkg of [...new Set(rows.map((r) => r.pkg))].sort()) {
    const anchor = path.join(NM, ...pkg.split('/'), 'package.json');
    if (!fs.existsSync(anchor)) continue;
    try {
      const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-tools');
      const hit = nearestVersion(entry, '@deepseek-ai/dsh-tools');
      resolution.push({ pkg, version: hit?.version ?? '?', dir: hit?.dir ?? '', ok: hit?.version === EXPECT_HOST });
    } catch {
      resolution.push({ pkg, version: '(解析不到)', dir: '', ok: false });
    }
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ profile: PROFILE, hits: rows, resolution }, null, 2));
} else {
  const byPkg = new Map();
  for (const r of rows) {
    if (!byPkg.has(r.pkg)) byPkg.set(r.pkg, []);
    byPkg.get(r.pkg).push(r);
  }
  console.log(`\nprofile: ${PROFILE}`);
  console.log(`扫到 ${rows.length} 处运行时足迹（仅 @snow-the/*）\n`);
  for (const [pkg, list] of [...byPkg].sort()) {
    const kinds = [...new Set(list.map((r) => r.kind))];
    console.log(`${pkg}   [${kinds.join(', ')}]`);
    for (const r of list) {
      const g = r.guarded ? '（附近有开关迹象）' : '（附近无开关迹象 —— 静态启发式，不代表启动即执行）';
      console.log(`   ${r.kind.padEnd(8)} ${r.file}:${r.line}${g}`);
      if (!r.guarded) console.log(`            ${r.raw}`);
    }
  }
  console.log(`\n附近看不到开关的 ${rows.filter((r) => !r.guarded && r.kind !== 'abspath').length} 处：`);
  for (const r of rows.filter((x) => !x.guarded && x.kind !== 'abspath')) console.log(`   ${r.pkg}  ${r.kind}  ${r.file}:${r.line}`);
  console.log('\n注意：以上是静态清单。要回答"启动时真的起了什么"，请看进程树与端口（见文件头注释）。');

  if (EXPECT_HOST) {
    const bad = resolution.filter((r) => !r.ok);
    console.log(`\n宿主世代一致性（期望 @deepseek-ai/dsh-tools = ${EXPECT_HOST}）：${resolution.length - bad.length}/${resolution.length} 一致`);
    for (const r of bad) console.log(`   ✗ ${r.pkg}  ->  ${r.version}  ${r.dir ? `(${r.dir.replace(/^.*node_modules/, '…node_modules')})` : ''}`);
    if (!bad.length) console.log('   全部插件都解析到运行中的那一代宿主。');
  }
}

process.exit(0);
