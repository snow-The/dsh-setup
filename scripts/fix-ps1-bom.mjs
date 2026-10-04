// fix-ps1-bom.mjs — 给含非 ASCII 的 .ps1 加 UTF-8 BOM
//
// 为什么必须:
//   Windows PowerShell 5.1(标准 Windows 自带的 powershell.exe)**在没有 BOM 时按系统 ANSI
//   码页解码脚本**。中文系统上是 GBK(936),于是 UTF-8 的中文变成乱码 ——
//   而多字节 UTF-8 序列里会出现能打断字符串字面量的字节,导致【整个文件解析失败】。
//
//   PowerShell 是先解析整个文件再执行,所以解析失败 = 一行都没跑。
//   表现就是"一键部署脚本在这台机器上完全不动"。
//
//   pwsh 7 默认 UTF-8,所以开发机上永远不会暴露这个问题 —— 只有新机器会。
//   这正是"新机器装不回来"的典型形态:BOM 缺失。
//
// 用法: node fix-ps1-bom.mjs [--check]    (--check 只报告不写)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_ONLY = process.argv.includes('--check');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter(p => p.toLowerCase().endsWith('.ps1'));
if (files.length === 0) { console.log('  没有 .ps1 文件'); process.exit(0); }

let fixed = 0, ok = 0, bad = [];

for (const f of files) {
  const buf = fs.readFileSync(f);
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const hasNonAscii = buf.some(b => b > 127);

  if (!hasNonAscii) {
    // 纯 ASCII 的 .ps1 不受影响 —— 但仍建议加 BOM,保持一致性
    console.log(`  ${hasBom ? '✓' : '·'} ${rel}  (纯 ASCII，不受影响)`);
    if (hasBom) ok++; else ok++;
    continue;
  }

  if (hasBom) { console.log(`  ✓ ${rel}  已有 BOM`); ok++; continue; }

  console.log(`  ★ ${rel}  含非 ASCII 且【无 BOM】→ PS 5.1 上会解析失败`);
  bad.push(rel);
  if (!CHECK_ONLY) {
    fs.writeFileSync(f, Buffer.concat([BOM, buf]));
    console.log(`      已修复（+3 字节 BOM）`);
    fixed++;
  }
}

console.log('');
if (CHECK_ONLY) {
  if (bad.length) { console.log(`✗ ${bad.length} 个 .ps1 缺 BOM: ${bad.join(', ')}`); process.exit(1); }
  console.log(`✓ 全部 ${ok} 个 .ps1 编码正确`);
} else {
  console.log(`✓ 检查 ${files.length} 个 .ps1，修复 ${fixed} 个`);
}
