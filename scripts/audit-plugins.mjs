#!/usr/bin/env node
/**
 * audit-plugins.mjs — 对一个 profile 的每个依赖做六维审计。
 *
 * 为什么需要它（2026-10-19 实例）：
 *   @tt-a1i/archify-dsh 在 npm 上的 latest 是 1.0.0，仓库里 integrations/deepseek-harness
 *   的 package.json 也还是 1.0.0 —— 只比【版本号】永远发现不了问题。
 *   但发布之后仓库又合了 `fix(dsh): preserve default skills across installation and upgrade`，
 *   而 npm 包的 cordis.patch.yml 里 includeDefaultRoots 仍是 false（仓库里已改成 true）。
 *   也就是说：版本号冻结，内容落后，谁只看 version 谁就被骗。
 *
 * 六个维度（每条都能给出证据，不是判断）：
 *   ① 来源可达      新机器能不能把它装回来
 *   ② 版本新鲜      钉版 vs 上游最新
 *   ③ 内容新鲜      npm 包的发布时间 vs 仓库对应目录的最后提交
 *   ④ 世代兼容      它声明认哪个宿主世代
 *   ⑤ 入口存在      main/exports 指向的文件真的在不在
 *   ⑥ 挂载一致      dependencies 与 bundleOrder 是否对得上
 *
 * 用法：
 *   node scripts/audit-plugins.mjs --profile-dir ~/.dsh/profiles/web
 *   node scripts/audit-plugins.mjs --profile-dir ../profiles/web --json
 *   node scripts/audit-plugins.mjs --profile-dir ... --runtime 0.2.1-rc.2
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { npmView } from './npm-view.mjs';
import { satisfiesDsh } from './host-range.mjs';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const AS_JSON = argv.includes('--json');
// 这一代宿主。给了它，审计才能回答"最新版是不是这一代装不了"，否则只能回答"有没有新版"。
const RUNTIME = argOf('runtime');

/** 某版本的宿主范围：engines.dsh 优先（门禁也是这个顺序），退回 peerDependencies['@deepseek-ai/dsh']。 */
function hostRangeOf(name, version) {
  try {
    const engines = npmView(`${name}@${version}`, 'engines');
    if (engines && typeof engines === 'object' && typeof engines.dsh === 'string' && engines.dsh.trim()) return engines.dsh.trim();
  } catch { /* 形状不认识就当没声明 */ }
  try {
    const peers = npmView(`${name}@${version}`, 'peerDependencies');
    if (peers && typeof peers === 'object' && typeof peers['@deepseek-ai/dsh'] === 'string') return peers['@deepseek-ai/dsh'].trim();
  } catch { /* 同上 */ }
  return null;
}

const rawDir = argOf('profile-dir');
if (!rawDir) {
  console.error('需要 --profile-dir <profile 目录>（例如 ~/.dsh/profiles/web）');
  process.exit(2);
}
const PROFILE_DIR = path.resolve(rawDir.replace(/^~(?=$|[\\/])/, os.homedir()));
const PKG = path.join(PROFILE_DIR, 'package.json');
if (!fs.existsSync(PKG)) {
  console.error(`找不到 ${PKG}`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const deps = manifest.dependencies ?? {};
const bundles = manifest.dsh?.profile?.bundles ?? [];
const NM = path.join(PROFILE_DIR, 'node_modules');

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32', ...opts,
    }).trim();
  } catch { return undefined; }
}

/** 读已装包的 package.json（没装 → null）。 */
function installed(name) {
  const p = path.join(NM, ...name.split('/'), 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 从 repository 字段解析 owner/repo 与子目录。 */
function repoInfo(pj) {
  const r = pj?.repository;
  const url = typeof r === 'string' ? r : r?.url;
  if (!url) return null;
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url.replace(/^git\+/, ''));
  if (!m) return null;
  return { owner: m[1], repo: m[2], directory: typeof r === 'object' ? r.directory : undefined };
}

/** 仓库某目录最后一笔提交时间（gh 认证优先，退回匿名 API）。 */
function lastCommitAt(info) {
  if (!info) return undefined;
  const q = `repos/${info.owner}/${info.repo}/commits?per_page=1${info.directory ? `&path=${encodeURIComponent(info.directory)}` : ''}`;
  const viaGh = sh('gh', ['api', q, '--jq', '.[0].commit.committer.date']);
  if (viaGh) return { at: viaGh, via: 'gh' };
  const viaCurl = sh('curl', ['-s', `https://api.github.com/${q}`]);
  if (viaCurl) {
    try {
      const arr = JSON.parse(viaCurl);
      if (Array.isArray(arr) && arr[0]) return { at: arr[0].commit.committer.date, via: 'api' };
    } catch { /* 限流或非 JSON */ }
  }
  return undefined;
}

/** 展开 exports 里可能出现的通配符（./src/*、./locale/*.json）。
 *  这些不是字面路径 —— 直接 existsSync 会全部报"缺失"，那是误报。 */
function expandGlob(pkgDir, candidate) {
  if (!candidate.includes('*')) {
    return { literal: true, found: fs.existsSync(path.join(pkgDir, candidate)) ? [candidate] : [] };
  }
  const dir = path.dirname(candidate);
  const base = path.basename(candidate);
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  try {
    const hits = fs.readdirSync(path.join(pkgDir, dir)).filter((f) => re.test(f));
    return { literal: false, found: hits.map((f) => path.join(dir, f)) };
  } catch {
    return { literal: false, found: [] };
  }
}

/** 宿主包：npm 的 dist-tag/latest 对它们没有意义（它们随宿主的发布列车走），
 *  拿 latest 去比会给出"降级"的荒谬建议（实测 0.2.0-rc.2 → 0.0.1-rc.1）。 */
const isHostPkg = (name) => name.startsWith('@deepseek-ai/');

const semverNum = (t) => String(t).replace(/^v/, '').split('-')[0].split('.').map((x) => Number(x) || 0);
function semverCmp(a, b) {
  const x = semverNum(a), y = semverNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const rows = [];
for (const [name, spec] of Object.entries(deps)) {
  const row = {
    name, spec, kind: '', source: '', latest: '', fresh: '', content: '',
    engines: '', entry: '', mounted: bundles.includes(name) ? 'yes' : 'no', notes: [],
  };
  const pj = installed(name);

  // ---------- ① 来源 ----------
  if (/^\d/.test(spec)) {
    row.kind = 'npm';
    const exists = npmView(`${name}@${spec}`, 'version');
    row.source = exists ? 'npm 上存在' : '（npm 查不到这个版本！）';
    if (!exists) row.notes.push('钉的版本在 npm 上找不到');
  } else if (spec.startsWith('github:')) {
    row.kind = 'github';
    const rest = spec.slice('github:'.length);
    const [repo, ref] = rest.split('#');
    row.source = repo;
    if (ref) {
      const hit = sh('git', ['ls-remote', `https://github.com/${repo}`, `refs/tags/${ref}`]);
      row.source += hit ? ` @${ref} 存在` : ` @${ref} 【不存在】`;
      if (!hit) row.notes.push(`tag ${ref} 在远端不存在`);
    } else {
      const head = sh('git', ['ls-remote', `https://github.com/${repo}`, 'HEAD']);
      row.source += head ? ` 浮动（HEAD ${head.slice(0, 7)}）` : ' 【仓库不可达】';
      if (!head) row.notes.push('仓库不可达');
    }
  } else if (spec.startsWith('file:')) {
    row.kind = 'file';
    const dir = spec.slice('file:'.length);
    const exists = fs.existsSync(dir);
    const remote = exists ? sh('git', ['-C', dir, 'remote', 'get-url', 'origin']) : undefined;
    const dirty = exists && sh('git', ['-C', dir, 'status', '--porcelain']);
    row.source = exists ? (remote ? `本地 git（origin ${remote.replace(/^.*github\.com[:/]/, '')}）` : '本地目录，【没有 git 远端】') : '【本地目录不存在】';
    if (exists && !remote) row.notes.push('没有远端 → 新机器装不回来');
    if (dirty) row.notes.push('工作区有未提交改动');
  } else {
    row.kind = 'other';
    row.source = spec;
  }

  // ---------- ② 版本新鲜 ----------
  if (row.kind === 'npm' && isHostPkg(name)) {
    row.latest = '随宿主发布';
    row.fresh = '宿主包';
  } else if (row.kind === 'npm') {
    const latest = npmView(name, 'version');
    row.latest = latest ?? '（查询失败）';
    if (!latest || latest === spec) {
      row.fresh = latest ? '最新' : '（查询失败）';
    } else {
      // 新版存在 ≠ 本世代能用。宿主门禁看 engines.dsh / peerDependencies['@deepseek-ai/dsh']，
      // 而它判定时 includePrerelease:true —— rc 号是参与比较的。所以这里必须真的去问
      // 新一代声明了什么，不能把"落后"一律当成"可升"（2026-10-27 实测：@linxin666/* 的
      // 0.4.11 要 >=0.2.1-rc.3，装到 rc.2 上会被整包拒载）。
      const peerRange = hostRangeOf(name, latest);
      if (!RUNTIME) {
        row.fresh = `落后（最新 ${latest}；未给 --runtime，没核实新一代是否适配）`;
        row.notes.push(`可升 ${spec} → ${latest}（先确认它认这一代宿主）`);
      } else if (peerRange && !satisfiesDsh(peerRange, RUNTIME)) {
        row.fresh = `本世代最新（${latest} 要宿主 ${peerRange}）`;
        row.notes.push(`${latest} 的宿主范围 ${peerRange} 不含 ${RUNTIME} —— 所以 ${spec} 就是这一代能用的最新，别升`);
      } else {
        row.fresh = `落后（最新 ${latest}）`;
        row.notes.push(`可升 ${spec} → ${latest}${peerRange ? `（宿主范围 ${peerRange} 认 ${RUNTIME}）` : '（它没声明宿主范围）'}`);
      }
    }
  } else if (row.kind === 'github' && spec.includes('#')) {
    const repo = spec.slice('github:'.length).split('#')[0];
    const tags = (sh('git', ['ls-remote', '--tags', '--refs', `https://github.com/${repo}`]) ?? '')
      .split('\n').map((l) => l.split('refs/tags/')[1]).filter(Boolean);
    if (tags.length) {
      // 字典序 ≠ 版本序（ls-remote 输出按 ref 名排序，v2.9.9 会排在 v2.13.0 后面）
      const max = [...tags].sort(semverCmp).pop();
      row.latest = max;
      const cur = spec.split('#')[1];
      row.fresh = cur === max ? '最新' : `落后（最新 tag ${max}）`;
      if (cur !== max) row.notes.push(`可升 ${cur} → ${max}`);
    } else {
      row.latest = '（无 tag）';
      row.fresh = '浮动仓库';
    }
  } else if (row.kind === 'github') {
    row.latest = '跟随 HEAD';
    row.fresh = '浮动';
  } else if (row.kind === 'file') {
    const dir = spec.slice('file:'.length);
    const head = fs.existsSync(dir) ? sh('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']) : undefined;
    row.latest = head ? `本地 HEAD ${head}` : '—';
    row.fresh = '跟随工作区';
  }

  // ---------- ③ 内容新鲜（发布滞后）----------
  // 只有 npm 包才谈得上"发布滞后"：包内是某次 publish 的快照，仓库可能已经走远。
  if (row.kind === 'npm' && pj) {
    const info = repoInfo(pj);
    if (info) {
      const published = npmView(name, 'time', ),
        publishAt = published && typeof published === 'object' ? published[spec] : undefined;
      const last = lastCommitAt(info);
      if (publishAt && last?.at) {
        const lag = (Date.parse(last.at) - Date.parse(publishAt)) / 86400000;
        // 范围必须写出来：有 directory 时看的是该子目录，没有时看的是【整仓】——
        // 整仓视角会因为有无关提交而误报，读者要能自己判断这条信号有多强。
        const scope = info.directory ? `子目录 ${info.directory}` : '整仓（无子目录信息，弱信号）';
        if (lag > 0.5) {
          row.content = `仓库比发布物新 ${lag.toFixed(1)} 天`;
          row.notes.push(`发布之后还有 ${lag.toFixed(1)} 天的提交（${scope}）—— 版本号可能没变但内容变了`);
        } else {
          row.content = '一致（发布后无新提交）';
        }
      } else {
        row.content = '无法判定（缺发布时间或提交时间）';
      }
    } else {
      row.content = '无 repository 信息';
    }
  } else if (row.kind !== 'npm') {
    row.content = '不适用（跟随上游）';
  }

  // ---------- ④ 世代兼容 ----------
  if (pj && isHostPkg(name)) {
    row.engines = '宿主包（随宿主版本，不看自己声明）';
  } else if (pj) {
    const eng = pj.engines?.dsh;
    const peer = pj.peerDependencies?.['@deepseek-ai/dsh'];
    const parts = [];
    if (eng) parts.push(`engines.dsh=${eng}`);
    if (peer) parts.push(`peer dsh=${peer}`);
    row.engines = parts.length ? parts.join(' · ') : '（未声明宿主世代）';
    if (!parts.length) row.notes.push('没声明 engines.dsh / peer dsh —— 宿主门禁无从判定');
  } else {
    row.engines = '（未安装）';
    row.notes.push('依赖未安装，无法检查入口与世代');
  }

  // ---------- ⑤ 入口存在 ----------
  if (pj) {
    const candidates = [];
    if (typeof pj.main === 'string') candidates.push(pj.main);
    if (pj.exports && typeof pj.exports === 'object') {
      for (const v of Object.values(pj.exports)) {
        if (typeof v === 'string') candidates.push(v);
        else if (v && typeof v === 'object') for (const w of Object.values(v)) if (typeof w === 'string') candidates.push(w);
      }
    }
    if (!candidates.length) {
      row.entry = '（无 main/exports）';
      row.notes.push('没有 main/exports —— 宿主无法加载');
    } else {
      const pkgDir = path.join(NM, ...name.split('/'));
      const expanded = candidates.map((c) => ({ candidate: c, ...expandGlob(pkgDir, c) }));
      const missingLiteral = expanded.filter((e) => e.literal && e.found.length === 0);
      const emptyWildcard = expanded.filter((e) => !e.literal && e.found.length === 0);
      if (missingLiteral.length) {
        row.entry = `【缺】${missingLiteral[0].candidate}`;
        row.notes.push(`入口文件不存在：${missingLiteral[0].candidate}`);
      } else if (emptyWildcard.length) {
        // 通配入口匹配为空：可能是该子目录本来就没有文件（如没有 locale），
        // 也可能真的坏了 —— 只标出来，不判定为缺失。
        row.entry = `通配入口匹配为空：${emptyWildcard[0].candidate}`;
      } else {
        row.entry = `${candidates.length}/${candidates.length} 存在`;
      }
      // dsh bundle 还需要 patch 文件
      const patch = pj.dsh?.bundle?.patch;
      if (patch && !fs.existsSync(path.join(pkgDir, patch))) {
        row.notes.push(`dsh.bundle.patch 指向的 ${patch} 不存在`);
        row.entry += ` · patch 缺失`;
      }
    }
  }

  // ---------- ⑥ 挂载一致 ----------
  if (!row.mounted) row.notes.push('装了但不在 bundleOrder 里（纯负重）');

  rows.push(row);
}

// bundleOrder 里挂了但没来源的（宿主层除外：@deepseek-ai/* 由宿主提供）
const orphanBundles = bundles.filter((b) => !Object.hasOwn(deps, b) && !b.startsWith('@deepseek-ai/'));

if (AS_JSON) {
  console.log(JSON.stringify({ profileDir: PROFILE_DIR, rows, orphanBundles }, null, 2));
} else {
  const w = (s, n) => { const t = String(s ?? ''); return t + ' '.repeat(Math.max(0, n - [...t].reduce((a, c) => a + (/[\u2E80-\uA4CF\uAC00-\uD7A3]/.test(c) ? 2 : 1), 0))); };
  console.log(`\nprofile: ${PROFILE_DIR}`);
  console.log(`依赖 ${rows.length} 个 · 挂载 ${bundles.length} 条\n`);
  for (const r of rows) {
    console.log(`${w(r.name, 44)} ${w(r.spec, 16)} ${w(r.fresh, 22)} ${r.content}`);
  }
  const withNotes = rows.filter((r) => r.notes.length);
  console.log(`\n—— 需要看的 ${withNotes.length} 个 ——`);
  for (const r of withNotes) {
    console.log(`  ${r.name}`);
    for (const n of r.notes) console.log(`     · ${n}`);
  }
  if (orphanBundles.length) {
    console.log(`\n挂载了但没有依赖来源：${orphanBundles.join(', ')}`);
  }
}

process.exit(rows.some((r) => r.notes.some((n) => n.includes('不存在') || n.includes('装不回来') || n.includes('纯负重'))) ? 1 : 0);
