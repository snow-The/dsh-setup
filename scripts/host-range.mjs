// host-range.mjs — 「这个插件声明的宿主范围，认不认这一代宿主」。
//
// 为什么要自己写：宿主门禁判断的是 `engines.dsh`（优先）或 `peerDependencies['@deepseek-ai/dsh']`，
// 而它判定时用的是 `semver.satisfies(rt, range, { includePrerelease: true })` ——
// 预发布号是【参与比较】的。本仓库原来的 semverCmp 把 `0.2.1-rc.2` 和 `0.2.1-rc.3`
// 视为同一个版本（它只比 [major,minor,patch]），于是审计只能说"落后"，答不了
// "新版是不是这一代装不了"。实测代价：@linxin666/* 的 0.4.11 要 `>=0.2.1-rc.3`，
// 在 rc.2 上会被门禁整包拒载，而审计把它标成"可升"。
//
// 覆盖面：只实现宿主插件实际写过的形态 ——
//   `>=0.2.1-rc.2`、`>=0.2.1-rc.2 <0.3.0-0`、`0.2.0-rc.2 || 0.2.1-rc.2`、精确版本。
// 遇到不认识的语法就**抛错**，不猜默认值：一个静默的 "true" 会让审计把装不上的包
// 报成可升，正是我们要避免的那种谎。

const RE_VER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** @returns {{nums:number[],pre:string[]}|null} */
export function parseVer(v) {
  const m = RE_VER.exec(String(v ?? '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** semver 优先级：数字段逐个比，然后带预发布的**小于**同版本的正式版。 */
export function cmpVer(a, b) {
  const x = typeof a === 'string' ? parseVer(a) : a;
  const y = typeof b === 'string' ? parseVer(b) : b;
  if (!x || !y) throw new Error(`无法解析版本: ${a} / ${b}`);
  for (let i = 0; i < 3; i++) {
    const d = x.nums[i] - y.nums[i];
    if (d) return d < 0 ? -1 : 1;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;              // 1.0.0 > 1.0.0-rc.1
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;         // 前缀更短者更小
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { const d = Number(p) - Number(q); if (d) return d < 0 ? -1 : 1; continue; }
    if (pn !== qn) return pn ? -1 : 1;      // 数字标识符 < 字母标识符
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** 单个比较子（如 `>=0.2.1-rc.2`）或精确版本。 */
function testComparator(tok, version) {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(tok);
  if (!m) throw new Error(`无法理解的比较子: ${tok}`);
  const op = m[1] ?? '=';
  const target = m[2].trim().replace(/^v/, '');
  const c = cmpVer(version, target);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    default: throw new Error(`无法理解的运算符: ${op}`);
  }
}

/**
 * @param {string} range 宿主范围，例如 `>=0.2.1-rc.2 <0.3.0-0` 或 `0.2.0-rc.2 || 0.2.1-rc.2`
 * @param {string} version 宿主版本，例如 `0.2.1-rc.2`
 * @returns {boolean}
 */
export function satisfiesDsh(range, version) {
  if (typeof range !== 'string' || range.trim() === '') {
    throw new Error('宿主范围为空 —— 空字符串在门禁里恒不满足，不能当"不限"解释');
  }
  return range.split('||').map((alt) => alt.trim()).filter(Boolean).some((alt) => {
    // 空白分隔 = AND；`>=0.2.1-rc.2` 这类整段进比较子
    const toks = alt.split(/\s+/).filter(Boolean);
    return toks.every((t) => testComparator(t, version));
  });
}
