// host-map.mjs — 把 @deepseek-ai/* 的解析【严格】钉死到指定宿主的 node_modules。
//
// 为什么需要：插件把宿主包声明为 peerDependencies，自己目录里没有它们，运行时由宿主提供。
// 于是"直接 import 插件入口"看起来最接近真相，但 Node 会一路向上查找 —— 实测在本机
// （2026-10-19）不加约束地 import，解析到的是
//   <npx 缓存>/@deepseek-ai/dsh-tools  v0.1.5-rc.3
// 也就是【另一个世代】的宿主。用它去验 0.2.1 的插件，"通过"毫无意义。
//
// 做法：保持裸说明符不变，只把 parentURL 换到宿主 node_modules 里的一个锚点文件，
// 于是 Node 像"从宿主里 import"一样去查找。映射不到直接抛错，绝不回退。
// 不能直接 nextResolve(<目录 file URL>) —— Node 对文件 URL 不做目录解析，
// 会报 "Directory import ... is not supported resolving ES modules"。
//
// 历史教训（这是本文件存在的第二个理由，也是 selfProof 的由来）：
// 上一版的钩子从 process.env.HOST_NM 读宿主路径，而调用方是通过 --host 参数传的 ——
// 两条通道没接上时钩子【静默退化为直通】。在 CI 的干净环境里那会响亮地失败；但在本机
// 它就静默落到了 0.1.5-rc.3 上并报"全过"。同一个缺陷，一处响一处哑。
//
// 所以：宿主路径是 armHostMap() 的必选参数（没有直通这条退化路径），并且调用方必须调
// selfProof() 证明钩子真的被调用过。
//
// selfProof 的第一版用了「解析结果必须落在宿主目录里」作为判据 —— 那是错的：
// import.meta.resolve 的 parent 永远是【本文件】的位置，不是调用方也不是插件，
// 所以"解析到了别的副本"那条分支在实际布局下几乎永远走不到（实测报的是"解析不到"）。
// 一个读起来像护栏、实际打不着的分支，就是假护栏。
// 现在的判据是【数命中】：registerHooks 是线程内同步的，钩子被调用就 ++，于是
// "钩子到底跑没跑"可以被直接测出来，与路径布局无关。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

let hostNm = null;
let hits = 0;

/** 宿主 node_modules 里的一个假定锚点文件 URL（文件本身不需要存在）。 */
export function hostAnchor(nm) {
  return pathToFileURL(nm).href.replace(/\/?$/, '/') + '__host_anchor.js';
}

/** 钩子被调用的次数。0 表示没武装，或武装后一次都没走到。 */
export function hookHits() {
  return hits;
}

/** 当前钉住的宿主目录。 */
export function armedHost() {
  return hostNm;
}

/**
 * 安装严格解析钩子。hostNm 必填 —— 没有"随便解析"的退化路径。
 * @param {string} nm 宿主 node_modules 的绝对路径
 */
export function armHostMap(nm) {
  if (typeof nm !== 'string' || nm.trim() === '') {
    throw new Error('armHostMap: 必须提供宿主 node_modules 路径（拒绝在未武装的状态下继续）');
  }
  if (typeof registerHooks !== 'function') {
    throw new Error(
      `这台 Node (${process.version}) 没有 module.registerHooks，无法把宿主包钉死。`
      + '拒绝在"能不能解析全看查找路径上碰巧有什么"的状态下跑验证。需 Node >= 22.15。',
    );
  }

  hostNm = nm;
  hits = 0;
  const anchor = hostAnchor(nm);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context);
      hits++;
      try {
        return nextResolve(specifier, { ...context, parentURL: anchor });
      } catch (e) {
        throw new Error(
          `strict host mapping: ${specifier} is not resolvable inside ${nm} `
          + `(${String(e?.message ?? e).split('\n')[0]}). `
          + 'Refusing to fall back to whatever copy happens to be on the lookup path.',
        );
      }
    },
  });
}

/**
 * 自证。三条判据各自对应一种失败，而且【每条都在实际布局下可达】：
 *   ① 目录不对   → 磁盘上找不到 <host>/@deepseek-ai/...
 *   ② 钩子没武装 → 拿一个不可能解析的 canary 去打钩子，命中计数不增长
 *   ③ 宿主缺包   → 真包解析抛错
 * ② 必须用 canary：直接解析真包时，钩子没武装的话 Node 会先抛 "Cannot find package"，
 * 于是"钩子没被调用"这条信息被异常吞掉，分支永远走不到 —— 一个打不着的分支就是假护栏。
 * @param {string} nm 宿主 node_modules
 * @param {string} specifier 例如 '@deepseek-ai/dsh-tools'
 * @returns {string} 解析结果
 */
export function selfProof(nm, specifier = '@deepseek-ai/dsh-tools') {
  const owned = path.join(nm, ...specifier.split('/'));
  if (!existsSync(owned)) {
    throw new Error(`自证失败：宿主目录里没有 ${specifier}\n  宿主: ${nm}\n  找不到: ${owned}`);
  }

  const before = hits;
  try {
    import.meta.resolve('@deepseek-ai/__load_check_canary__');
  } catch { /* 预期：这个说明符永远解析不到 */ }
  if (hits === before) {
    throw new Error(
      '自证失败：解析钩子一次都没被调用 —— 它没有被武装，或者 registerHooks 没生效。\n'
      + `  宿主: ${nm}\n`
      + '  这正是本工具要消灭的假通过：钩子不在，Node 会回退到查找路径上碰巧存在的旧世代副本。',
    );
  }

  let resolved;
  try {
    resolved = import.meta.resolve(specifier);
  } catch (e) {
    throw new Error(
      `自证失败：${specifier} 解析不到 —— ${String(e?.message ?? e).split('\n')[0]}\n  宿主: ${nm}`,
    );
  }
  return resolved;
}
