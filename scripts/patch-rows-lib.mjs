/**
 * 解析 cordis.patch.yml 里的 row —— 只要「哪些 row 存在、各自挂的是谁」，
 * 不解析 config。理由：这一层唯一需要跨机器核对的事实就是「挂载面」，
 * config 值几乎全是每台机器自己的选择（模型、主题、权限、面板位置）。
 *
 * 形状（两种都见过，都在真实文件里）：
 *   - id: web            ← 顶层 row，target 已有插件
 *     config: { ... }
 *   - insert:            ← 插入列表
 *       - id: session-bus
 *         name: '@snow-the/dsh-session-bus'
 *
 * 刻意不用 YAML 库：这里只需要 id / name / disabled 三个标量，
 * 而 `!!js` 表达式与 tab 缩进会让通用解析器做出我们不想要的解释。
 * 只认「行首缩进 + "- id:"」这种唯一稳定的锚点。
 */
import fs from 'node:fs';

/** @returns {{id: string, name: string|null, disabled: boolean, line: number}[]} */
export function parsePatchRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const rows = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/^(\s*)-\s+id:\s*(\S+)\s*$/);
    if (m) {
      if (cur) rows.push(cur);
      cur = { id: m[2].replace(/^['"]|['"]$/g, ''), name: null, disabled: false, line: i + 1 };
      continue;
    }
    if (!cur) continue;
    // row 到下一个 row（或空行之后的顶层键）为止
    const nm = l.match(/^\s+name:\s*(.+?)\s*$/);
    if (nm && cur.name === null) {
      cur.name = nm[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^\s+disabled:\s*true\s*$/.test(l)) cur.disabled = true;
  }
  if (cur) rows.push(cur);
  return rows;
}

/** 把 rows 变成 id -> row 的表，重复 id 单独报出来（重复本身就是故障）。 */
export function indexRows(rows) {
  const map = new Map();
  const dups = [];
  for (const r of rows) {
    if (map.has(r.id)) dups.push(r.id);
    else map.set(r.id, r);
  }
  return { map, dups };
}
