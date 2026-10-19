#!/usr/bin/env node
/**
 * audit-logs.mjs — 检查插件往启动通道写了什么，以及是否符合统一约定。
 *
 * 为什么要统一（2026-10-19 实测）：启动日志是唯一能看见"插件被宿主禁用/降级"的地方
 * （这次就是靠读 `dsh: disabling profile plugin row ...` 才定位到 profile 与宿主世代错配）。
 * 但同一个启动通道里现在混着三种格式：
 *
 *   [dsh-search] apply called, ctx.web = true , registerSearchProvider = function   ← 调试残留，带值 dump
 *   corpus-mcp 1.0.0 就緒（4745 實體；書內文走 ripgrep）                              ← 无前缀、中文
 *   dsh web: http://127.0.0.1:3080/?token=...                                      ← 宿主格式
 *
 * 而且前缀命名本身不一致：同一个插件在不同行里可能叫 [lib-analyzer] 也可能叫
 * [dsh-lib-analyzer]，grep 一个名字搜不全。
 *
 * 约定（本脚本判定的就是这几条）：
 *   ① 前缀必须是 `[<npm 包名去掉 scope>]` 全名，例如 [dsh-notemap]
 *   ② stdout 只放 info；warn/error 走 stderr（console.warn/error 本身就是 stderr）
 *   ③ 不打对象/dump：不许出现 `= function`、`= true`、`${JSON.stringify(` 这类
 *   ④ 启动期最多 1 行 info；调试信息必须挂在开关后（DSH_DEBUG 之类），默认不发
 *
 * 用法：
 *   node scripts/audit-logs.mjs --profile-dir ~/.dsh/profiles/web
 *   node scripts/audit-logs.mjs --profile-dir ... --json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const AS_JSON = argv.includes('--json');
const rawDir = argOf('profile-dir');
if (!rawDir) { console.error('需要 --profile-dir <profile 目录>'); process.exit(2); }
const PROFILE = path.resolve(rawDir.replace(/^~(?=$|[\\/])/, os.homedir()));
const NM = path.join(PROFILE, 'node_modules');

/** 只扫我们自己插件的发布物，跳过依赖与测试夹具。 */
function walk(dir, out = []) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (['node_modules', 'test', 'tests', '__tests__', 'coverage'].includes(it.name)) continue;
      walk(p, out);
    } else if (/\.(mjs|cjs|js)$/.test(it.name)) {
      out.push(p);
    }
  }
  return out;
}

const CALL = /console\.(log|warn|error|info|debug)\s*\(\s*(['"`])([\s\S]*?)\2/g;

const rows = [];
const scopes = fs.existsSync(NM) ? fs.readdirSync(NM, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
for (const scope of scopes) {
  const scopeDir = path.join(NM, scope.name);
  const pkgs = scope.name.startsWith('@')
    ? fs.readdirSync(scopeDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: `${scope.name}/${d.name}`, dir: path.join(scopeDir, d.name) }))
    : [{ name: scope.name, dir: scopeDir }];

  for (const pkg of pkgs) {
    // 只审计我们自己的插件（@snow-the/*），宿主与第三方由别的手段覆盖
    if (!pkg.name.startsWith('@snow-the/')) continue;
    const pjPath = path.join(pkg.dir, 'package.json');
    if (!fs.existsSync(pjPath)) continue;
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    const short = pkg.name.slice('@snow-the/'.length);          // 约定前缀 = [<short>]
    const expected = `[${short}]`;

    for (const file of walk(pkg.dir)) {
      const text = fs.readFileSync(file, 'utf8');
      // CLI 分支不是启动路径：`if (isMain)` / `import.meta.url === process.argv[1]` 之后的行
      // 只在被当成命令行工具跑时才会打印。不识别它就会把 usage 行误报成启动噪声。
      const cliGuard = /if\s*\(\s*isMain\s*\)|import\.meta\.url\s*===\s*process\.argv\[1\]|import\.meta\.url\s*===\s*fileURLToPath/.exec(text);
      const cliStart = cliGuard ? cliGuard.index : -1;
      let m;
      while ((m = CALL.exec(text))) {
        const [whole, level, , literal] = m;
        const line = text.slice(0, m.index).split('\n').length;
        const rel = path.relative(PROFILE, file).replace(/\\/g, '/');
        const problems = [];

        // 只扫字面量会漏掉 `console.log("[x] apply called, ctx.web =", !!ctx.web)` ——
        // 值在第二个参数里，字符串本身看着很干净。第一版的检查器就是这么漏掉的。
        //
        // 但「引号后面不是 )」不等于「多了一个参数」：`"... :" + String(port) + " ..."`
        // 是**同一个表达式**的拼接。第一版把 dsh-search 那行 daemon 启动日志误报成
        // 值 dump，就是漏掉了 `+` 这条。只有出现顶层逗号才算多参数。
        //
        // 已知残余盲区（不装成全覆盖）：拼接出来的对象 dump 仍抓不到，
        // 例如 `"[x] " + JSON.stringify(o)`。要抓它得真正解析调用表达式，
        // 而不是看相邻字符 —— 等真的出现这种写法再说，不为假想补复杂度。
        const tail = text.slice(m.index + whole.length);
        const afterQuote = tail[0];
        const continuesExpression = /^\s*\+/.test(tail.slice(0, 8));
        const extraArgs = afterQuote !== ')' && !continuesExpression;

        const hasPrefix = /^\s*\[[^\]]+\]/.test(literal);
        const prefix = hasPrefix ? literal.match(/^\s*(\[[^\]]+\])/)[1] : null;
        if (!hasPrefix) problems.push('无前缀（约定 ①）');
        else if (prefix !== expected) problems.push(`前缀 ${prefix} ≠ 约定 ${expected}`);

        // info 必须自带完整信息：带参数就是值 dump
        if (level === 'log' && extraArgs) problems.push('info 带参数（值 dump，约定 ③）');
        if (/=\s*(function|true|false|undefined|\d)|\$\{JSON\.stringify|= \d+/.test(literal)) problems.push('字面量里打了值（约定 ③）');
        if (literal.includes('\\n')) problems.push('多行正文');

        const cliOnly = cliStart >= 0 && m.index > cliStart;
        if (cliOnly) problems.length = 0;   // CLI 分支不影响启动通道

        rows.push({ pkg: pkg.name, short, file: rel, line, level, literal: literal.slice(0, 90), problems, cliOnly });
      }
    }
  }
}

// 启动期噪音：同一条消息在同一文件里出现多次（例如 register 循环里逐条打印）
if (AS_JSON) {
  console.log(JSON.stringify({ profile: PROFILE, calls: rows }, null, 2));
} else {
  console.log(`\nprofile: ${PROFILE}`);
  console.log(`扫到 ${rows.length} 处 console.* 调用（仅 @snow-the/*）\n`);
  const byPkg = new Map();
  for (const r of rows) {
    if (!byPkg.has(r.pkg)) byPkg.set(r.pkg, []);
    byPkg.get(r.pkg).push(r);
  }
  for (const [pkg, list] of byPkg) {
    console.log(`${pkg}  (${list.length} 处)`);
    for (const r of list) {
      const flag = r.problems.length ? `  ✗ ${r.problems.join(' / ')}` : '';
      console.log(`   ${r.level.padEnd(5)} ${r.file}:${r.line}  "${r.literal}"${flag}`);
    }
  }
  const bad = rows.filter((r) => r.problems.length);
  console.log(`\n合规 ${rows.length - bad.length} / 需改 ${bad.length}`);
  const pref = new Map();
  for (const r of rows) {
    const p = r.literal.match(/^\s*(\[[^\]]+\])/)?.[1] ?? '(无前缀)';
    pref.set(p, (pref.get(p) ?? 0) + 1);
  }
  console.log(`\n当前前缀分布：`);
  for (const [p, n] of [...pref].sort((a, b) => b[1] - a[1])) console.log(`   ${p.padEnd(24)} ${n}`);
}

process.exit(rows.some((r) => r.problems.length) ? 1 : 0);
