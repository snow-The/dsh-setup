// esm-host-hooks.mjs — 把 @deepseek-ai/* 的解析【严格】重定向到指定宿主的 node_modules
//
// 为什么需要：插件把宿主包声明为 peerDependencies，运行时由宿主提供，插件目录里没有它们。
// 但实测发现"没有钩子也能解析成功"—— 因为 ~/.dsh/profiles/node_modules 下躺着一份
// @deepseek-ai/dsh-tools@0.1.5-rc.3 的远古副本，Node 向上查找就命中了。
// 于是任何"能加载"的结论都可能是在一个错误世代上得出的。
//
// 做法：保持裸说明符不变，只把 parentURL 换到宿主 node_modules 里的一个锚点文件，
// 于是 Node 会像从宿主里 import 一样去查找。映射不到就抛错，绝不回退。
//
// 注意：不能直接 nextResolve(<目录文件URL>) —— Node 对文件 URL 不做目录解析，
// 会报 "Directory import ... is not supported resolving ES modules"。
//
// 由 esm-host-map.mjs 通过 module.register() 安装，宿主路径经 HOST_NM 环境变量传入。

import { pathToFileURL } from 'node:url';

const HOST_NM = process.env.HOST_NM;
const ANCHOR = HOST_NM
  ? pathToFileURL(HOST_NM).href.replace(/\/?$/, '/') + '__host_anchor.js'
  : null;

export async function resolve(specifier, context, nextResolve) {
  if (ANCHOR && specifier.startsWith('@deepseek-ai/')) {
    try {
      return await nextResolve(specifier, { ...context, parentURL: ANCHOR });
    } catch (e) {
      throw new Error(
        `strict host mapping: ${specifier} is not resolvable inside ${HOST_NM} `
        + `(${String(e?.message ?? e).split('\n')[0]}). `
        + 'Refusing to fall back to whatever copy happens to be on the lookup path.',
      );
    }
  }
  return nextResolve(specifier, context);
}
