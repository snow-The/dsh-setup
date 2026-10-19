// esm-host-map.mjs — 用 module.register() 安装解析钩子（通过 node --import 加载）
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./esm-host-hooks.mjs', pathToFileURL(import.meta.filename));
