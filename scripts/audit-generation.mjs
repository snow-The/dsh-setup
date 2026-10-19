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
 *      @deepseek-ai/dsh-client-ui-primitives / -slots —— 客户端静默不挂载。
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

      // ② dsh.client.inject 的每一项都必须是宿主里真实存在的包
      const inject = pj.dsh?.client?.inject;
      if (Array.isArray(inject)) {
        info.clientInject = inject;
        for (const n of inject) {
          if (!HOST_PKGS.has(n)) {
            info.missingInject.push(n);
            problems.push({ severity: 'hard', text: `dsh.client.inject 指向已不存在的包: ${n} —— 客户端会静默不挂载` });
          }
        }
      }

      // ③ 兼容声明是否覆盖这一代。
      //    这是【软项】：dshReleases 是给市场/UI 看的声明，宿主门禁用的是 engines.dsh 与 peer 范围。
      //    声明落后不等于会坏，但必须有人决定"验过了吗、要不要抬"。所以单列，不计入硬失败 ——
      //    否则 17 个插件全红，这个工具就会被人无视，那才是真正的失败。
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
  console.log(`\n硬伤（会坏）${broken.length} 个 · 声明落后（需人工确认）${stale.length} 个 · 完全合规 ${rows.length - broken.length - stale.length} 个\n`);

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
}

process.exit(rows.some((r) => r.problems.some((p) => p.severity === 'hard')) ? 1 : 0);
