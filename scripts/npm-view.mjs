// npm-view.mjs — 规范化 `npm view <spec> <field> --json` 的输出。
//
// 为什么值得单独一个文件：这是本仓库唯一依赖【外部契约】的地方，而它变过一次，
// 变的时候没有任何东西报错（2026-10-19 实测）：
//
//   npm 11.x:  npm view <pkg> scripts --json  →  { "prepare": "tsdown", … }
//   npm 12.x:  npm view <pkg> scripts --json  →  [ { "prepare": "tsdown", … } ]
//
// 旧代码 `JSON.parse` 之后直接 `Object.hasOwn(scripts, 'prepare')` —— 对数组恒为 false。
// 于是"这个包有没有 prepare"在 npm 12 上一律答"没有"：生成物安静地丢掉 allowBuilds 里的
// npm 段（六个包），而任何在这台机器上跑 `--write` 的人都会提交一份残缺清单 ——
// 后果是全新安装时那些包不再跑 prepare，装出来的插件是坏的，且全程无报错。
//
// 所以这里做两件事：
//   ① 把【已知】的形状差异抹平（单元素数组 → 对象）；
//   ② 遇到【不认识】的形状立刻抛错，而不是猜一个默认值。
// 第 ② 条是重点：静默的默认值正是这个 bug 造成伤害的方式。

import { execFileSync } from 'node:child_process';

const BUILD_KEYS = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * 把原始 stdout 规范化成 JSON 值（数组包装会被拆掉）。
 * 这里**不**判定类型 —— 期望什么类型由调用方声明（见 npmView 的 as 选项）。
 * 理由是同一个接口既会被问"这个包的 scripts 对象"，也会被问"它的 version 字符串"，
 * 在不知道期望的情况下拒绝标量，会把正常查询误判成契约异常。
 * @param {string} raw npm 的 stdout
 * @param {string} spec 用于报错的说明符
 * @param {string} field 字段名
 * @returns {*} 空输出 → null（该字段不存在）
 * @throws 输出不是 JSON，或形状不认识
 */
export function normalizeNpmView(raw, spec, field) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `npm view ${spec} ${field} 的输出不是 JSON（前 120 字符: ${text.slice(0, 120)}）——`
      + ' 外部契约变了，拒绝猜。',
    );
  }

  // npm 12 把单结果包成数组。多于一个结果说明说明符不够精确，那是另一类错误。
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return null;
    if (parsed.length > 1) {
      throw new Error(
        `npm view ${spec} ${field} 返回了 ${parsed.length} 个结果（期望 1 个）——`
        + ' 说明符不够精确，继续下去会静默取错版本。',
      );
    }
    parsed = parsed[0];
  }

  return parsed ?? null;
}

/** 这个包的 scripts 里是否有任何会在安装时执行的钩子。 */
export function hasBuildScript(scripts) {
  return !!scripts && BUILD_KEYS.some((k) => Object.hasOwn(scripts, k));
}

/**
 * 断言"我要的是对象"。暴露成独立函数，是为了它能被直接单测 ——
 * 埋在 npmView 里的类型检查等于在测试里跑不起来。
 * @throws 值不是对象也不是 null
 */
export function assertObjectShape(value, spec, field) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `npm view ${spec} ${field} 返回了 ${Array.isArray(value) ? 'array' : typeof value}，期望对象 —— 拒绝猜。`,
    );
  }
  return value;
}

/**
 * 查询一个包字段。
 * @param {string} spec 例如 'pkg@1.0.0'
 * @param {string} field 例如 'scripts' / 'version' / 'time'
 * @param {{as?: 'any'|'object'}} [opts] as='object' 时要求结果是对象或 null，
 *   否则抛错 —— 声明"我要的是对象"，就不会在拿到标量时静默当成空对象。
 * @returns {object|null|undefined} undefined 表示【子进程失败】（网络或包不存在）
 * @throws 拿到了输出但形状不认识 / 与 as 声明不符
 */
export function npmView(spec, field, opts = {}) {
  const { as = 'any' } = opts;
  let raw;
  try {
    raw = execFileSync('npm', ['view', spec, field, '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
  const value = normalizeNpmView(raw, spec, field);
  return as === 'object' ? assertObjectShape(value, spec, field) : value;
}
