#!/usr/bin/env node
/**
 * audit-generation.mjs — 断言「插件这一侧」和「宿主这一侧」是同一代。
 *
 * 这个脚本存在的理由，是 2026-10-19 一天里连续踩到的五个故障，它们看起来互不相关，
 * 其实都在同一个盲区里：**没有任何地方断言过"宿主是哪一代、插件是不是对着这一代"**。
 *
 *   ① 插件解析到 0.1.5-rc.3（来自 profiles/node_modules 里的陈旧 junction 农场），
 *      而宿主是 0.2.1 —— 全绿，因为 API 面结构性兼容。
 *   ② 三个插件的 dsh.client.inject 指向 0.2.1 里已删除的
 *      @deepseek-ai/dsh-client-ui-primitives / -slots。
 *      —— 这条最初被我写成"客户端静默不挂载"，是错的。对着加载器源码验过：
 *      dsh-client-modules/lib/client.js:789 是 `if (dependency !== void 0)`，
 *      找不到就当没有，消费者照常 arrive。所以它只丢"加载顺序"意图，不会阻止挂载。
 *      真正会坏的是另一件事：client bundle 把 @deepseek-ai/* 客户端包当模块 require（官方明令禁止）。
 *      两者现在分开判，见 ②。
 *   ③ 插件的 dsh.compatibility.dshReleases 只写到 0.2.0-rc.2，生态已经 0.2.1。
 *   ④ 代码里 import 的 @deepseek-ai/* 在目标宿主里根本不存在。
 *   ⑤ profile 又装了一份宿主自带的包 —— 同一插件两个副本。
 *
 * 每条判定都给出证据（哪个文件、哪一行、解析到了哪），不猜。
 *
 * 用法：
 *   node scripts/audit-generation.mjs --profile-dir ~/.dsh/profiles/web --host <宿主 node_modules>
 *   node scripts/audit-generation.mjs --profile-dir ... --host ... --json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const AS_JSON = argv.includes('--json');

const rawProfile = argOf('profile-dir');
const rawHost = argOf('host');
if (!rawProfile || !rawHost) {
  console.error('需要 --profile-dir <profile 目录> 与 --host <宿主的 node_modules>');
  process.exit(2);
}
const tidy = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
const PROFILE = tidy(rawProfile);
const HOST = tidy(rawHost);
const NM = path.join(PROFILE, 'node_modules');

if (!fs.existsSync(HOST)) { console.error(`宿主目录不存在: ${HOST}`); process.exit(2); }

/** 宿主版本：优先读宿主里 @deepseek-ai/dsh 的 package.json。 */
function hostVersion() {
  for (const p of [
    path.join(HOST, '@deepseek-ai', 'dsh', 'package.json'),
    path.join(HOST, '..', 'package.json'),
  ]) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.name === '@deepseek-ai/dsh') return j.version; } catch { }
  }
  return undefined;
}
const HOST_VERSION = hostVersion();
if (!HOST_VERSION) { console.error(`读不出宿主版本（${HOST} 里没有 @deepseek-ai/dsh/package.json）`); process.exit(2); }

/** 宿主里到底有哪些 @deepseek-ai/* 包。 */
function hostPackages() {
  const set = new Set();
  const dirs = [HOST, path.join(HOST, '@deepseek-ai')];
  for (const d of dirs) {
    let items; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (!it.isDirectory() && !it.isSymbolicLink()) continue;
      const p = path.join(d, it.name);
      if (it.name.startsWith('@deepseek-ai') && d === HOST) {
        try { for (const s of fs.readdirSync(p)) set.add(`@deepseek-ai/${s}`); } catch { }
      } else if (d !== HOST) set.add(`@deepseek-ai/${it.name}`);
      else if (fs.existsSync(path.join(p, 'package.json'))) set.add(it.name);
    }
  }
  return set;
}
const HOST_PKGS = hostPackages();

function walk(dir, out = []) {
  let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) { if (['node_modules', 'test', 'tests'].includes(it.name)) continue; walk(p, out); }
    else if (/\.(mjs|cjs|js)$/.test(it.name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](@deepseek-ai\/[^'"]+)['"]/g;

const rows = [];
if (fs.existsSync(NM)) {
  for (const scope of fs.readdirSync(NM, { withFileTypes: true })) {
    if (!scope.isDirectory() || !scope.name.startsWith('@')) continue;
    const scopeDir = path.join(NM, scope.name);
    for (const d of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pkgDir = path.join(scopeDir, d.name);
      const pjPath = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pjPath)) continue;
      let pj; try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch { continue; }
      // 只审我们自己的插件；宿主包与第三方由别的手段覆盖
      if (!String(pj.name ?? '').startsWith('@snow-the/')) continue;

      const problems = [];
      const info = { pkg: pj.name, version: pj.version, imports: [], missingImports: [], clientInject: [], missingInject: [], declared: null, verified: null };

      // ① 代码里 import 的 @deepseek-ai/* 必须存在于目标宿主
      const seen = new Set();
      for (const f of walk(pkgDir)) {
        const text = fs.readFileSync(f, 'utf8');
        let m;
        IMPORT_RE.lastIndex = 0;
        while ((m = IMPORT_RE.exec(text))) {
          const spec = m[1];
          const base = spec.split('/').slice(0, 2).join('/');   // @scope/name
          if (seen.has(base)) continue;
          seen.add(base);
          info.imports.push(base);
          if (!HOST_PKGS.has(base)) {
            const line = text.slice(0, m.index).split('\n').length;
            info.missingImports.push(`${base} (${path.relative(PROFILE, f).replace(/\\/g, '/')}:${line})`);
          }
        }
      }
      for (const m of info.missingImports) problems.push({ severity: 'hard', text: `import 的包在目标宿主里不存在: ${m}` });

      // ② 客户端声明有两种失效，性质完全不同，必须分开判：
      //    (a) hard —— client bundle 把 @deepseek-ai/* 客户端包当模块 require。
      //        官方 plugin 文档明令禁止："Do not require('@deepseek-ai/dsh-client-ui-primitives')
      //        or load any other Harness Client package as a module"。组件一抛错就整条
      //        slot 条目变空白（控制台 slot entry crashed in '<slot>'），而且纯 JS 插件没有类型检查兜着。
      //    (b) soft —— dsh.client.inject 里写了宿主已不存在的包。
      //        dsh-client-modules/lib/client.js:789 是 `if (dependency !== void 0)`：找不到就当没有，
      //        消费者照常 arrive。所以它不会阻止挂载，只是那条"加载顺序"意图落空、声明变成假话。
      const clientEntry = typeof pj.exports?.['./client'] === 'string'
        ? pj.exports['./client']
        : pj.exports?.['./client']?.default;
      const clientFile = typeof clientEntry === 'string' ? path.join(pkgDir, clientEntry) : null;
      if (clientFile && fs.existsSync(clientFile)) {
        const src = fs.readFileSync(clientFile, 'utf8');
        const requireRe = /require\(\s*['"](@deepseek-ai\/[a-z0-9-]+)['"]\s*\)/g;
        const seen = new Set();
        let mm;
        while ((mm = requireRe.exec(src)) !== null) seen.add(mm[1]);
        for (const n of seen) {
          if (/dsh-client/.test(n)) {
            problems.push({ severity: 'hard', text: `client bundle 把 Harness Client 包当模块加载: ${n}（官方禁止；组件抛错会静默清空该 slot 条目）` });
          }
        }
      }

      const inject = pj.dsh?.client?.inject;
      if (Array.isArray(inject)) {
        info.clientInject = inject;
        for (const n of inject) {
          if (!HOST_PKGS.has(n)) {
            info.missingInject.push(n);
            problems.push({ severity: 'soft', text: `dsh.client.inject 指向已不存在的包: ${n} —— 加载器静默跳过该条（client.js:789），只丢加载顺序，不阻止挂载` });
          }
        }
      }

      // ③ 兼容声明的两个字段，性质不同，必须分开看：
      //    · engines.dsh  —— 宿主门禁真正读的（0.2.1 起它优先且排他）。不声明 = 宿主无法判定 = 装到哪都被接受。
      //    · dshReleases  —— 给市场/UI 看的声明，不参与门禁。
      //    这条是 dsh-insights-kit 的自查提醒我的：它抓到了"engines.dsh 未声明"，而我只查了 dshReleases。
      //    不设成 hard：不会让现有功能坏掉；但它让"兼容性"这件事变成不可判定，所以单独标注。
      info.enginesDsh = pj.engines?.dsh ?? null;
      if (!info.enginesDsh) {
        problems.push({ severity: 'note', text: 'engines.dsh 未声明 —— 宿主门禁无法判定它能不能装在这代宿主上（装到哪都会被接受）' });
      }

      const rel = pj.dsh?.compatibility?.dshReleases;
      info.declared = Array.isArray(rel) ? rel : null;
      info.verified = pj.dsh?.compatibility?.verifiedAgainst ?? null;
      if (!info.declared || !info.declared.includes(HOST_VERSION)) {
        problems.push({ severity: 'soft', text: `dsh.compatibility.dshReleases 不含 ${HOST_VERSION}（现有: ${JSON.stringify(info.declared)}）` });
      }

      // ④ 解析必须落在【这个】宿主里（不是查找路径上别的副本）—— 硬伤
      let resolvedIn = null;
      try {
        const anchor = path.join(pkgDir, 'noop.js');
        const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-tools');
        let dir = path.dirname(entry);
        for (let i = 0; i < 8; i++) {
          if (fs.existsSync(path.join(dir, '@deepseek-ai', 'dsh', 'package.json'))) { resolvedIn = dir; break; }
          dir = path.dirname(dir);
        }
        if (!resolvedIn) problems.push({ severity: 'hard', text: `@deepseek-ai/dsh-tools 解析到了宿主之外: ${entry}` });
      } catch {
        if (info.imports.includes('@deepseek-ai/dsh-tools')) problems.push({ severity: 'hard', text: '@deepseek-ai/dsh-tools 解析不到' });
      }

      rows.push({ ...info, problems });
    }
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ host: HOST, hostVersion: HOST_VERSION, hostPackageCount: HOST_PKGS.size, plugins: rows }, null, 2));
} else {
  const w = (s, n) => { const t = String(s ?? ''); const dw = [...t].reduce((a, c) => a + (/[\u2E80-\u4A4F\uAC00-\uD7A3]/.test(c) ? 2 : 1), 0); return t + ' '.repeat(Math.max(0, n - dw)); };
  const hard = (r) => r.problems.filter((p) => p.severity === 'hard');
  const soft = (r) => r.problems.filter((p) => p.severity === 'soft');
  const note = (r) => r.problems.filter((p) => p.severity === 'note');

  console.log(`\n宿主: ${HOST}`);
  console.log(`世代: ${HOST_VERSION}   （宿主里有 ${HOST_PKGS.size} 个 @deepseek-ai/* 包）`);
  console.log(`profile: ${PROFILE}   插件 ${rows.length} 个\n`);
  console.log(w('插件', 34) + w('import', 8) + w('client inject', 14) + w('声明', 6) + '硬伤');
  console.log('-'.repeat(96));
  for (const r of rows) {
    const okImports = r.imports.length - r.missingImports.length;
    const okInject = r.clientInject.length - r.missingInject.length;
    const declOk = r.declared?.includes(HOST_VERSION) ? 'yes' : '旧';
    const injectCell = r.clientInject.length ? `${okInject}/${r.clientInject.length}` : '—';
    console.log(w(r.pkg, 34) + w(`${okImports}/${r.imports.length}`, 8) + w(injectCell, 14) + w(declOk, 6) + (hard(r).length ? `✗ ${hard(r).length}` : '✓'));
  }

  const broken = rows.filter((r) => hard(r).length);
  const stale = rows.filter((r) => !hard(r).length && soft(r).length);
  const unknown = rows.filter((r) => !hard(r).length && note(r).length);
  // 汇总必须用【互斥】归类：一个插件可以同时"声明落后"和"门禁不可判定"，
  // 各桶直接相加会得到负数（第一版就是 -13）。
  const statusOf = (r) => (hard(r).length ? 'hard' : note(r).length ? 'unknown' : soft(r).length ? 'soft' : 'clean');
  const counts = { hard: 0, unknown: 0, soft: 0, clean: 0 };
  for (const r of rows) counts[statusOf(r)]++;
  console.log(`\n硬伤（会坏）${counts.hard} · 门禁不可判定 ${counts.unknown} · 仅声明落后 ${counts.soft} · 完全合规 ${counts.clean}`);

  if (broken.length) {
    console.log('── 硬伤：这些会让功能直接失效，而且通常是静默的 ──');
    for (const r of broken) {
      console.log(`  ${r.pkg}@${r.version}`);
      for (const p of hard(r)) console.log(`     · ${p.text}`);
    }
  }
  if (stale.length) {
    console.log('\n── 声明落后：不是故障，但必须有人决定「验过了吗」 ──');
    const versions = new Map();
    for (const r of stale) {
      const key = JSON.stringify(r.declared);
      versions.set(key, [...(versions.get(key) ?? []), r.pkg.replace('@snow-the/', '')]);
    }
    for (const [k, list] of versions) console.log(`  dshReleases=${k}: ${list.length} 个 —— ${list.join(', ')}`);
  }
  if (unknown.length) {
    console.log('\n── 门禁不可判定：engines.dsh 未声明（宿主读的是它，不是 dshReleases）──');
    console.log(`  ${unknown.map((r) => r.pkg.replace('@snow-the/', '')).join(', ')}`);
  }
}

process.exit(rows.some((r) => r.problems.some((p) => p.severity === 'hard')) ? 1 : 0);
