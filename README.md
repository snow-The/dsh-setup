# dsh-setup — DeepSeek Harness 多机部署模板

作者 **snow-The** 的 DSH web profile 完整配置（插件列表 + patch 层），用于在新机器上快速部署出一致的环境。

> 🔒 **安全声明：本仓库不包含任何 API key、token、凭据或本机私有数据。**
> 模型 key、SSH 密码等一律在新机器上自行配置（见「配置凭据」）。
> 本仓库仅含 `profiles/web/` 的依赖清单、patch 层与 pnpm 配置。

**世代：DSH `0.2.0`+。** 本模板是 0.2.0 时代重写的版本，0.1.x 的配置一律不再支持 —— 详见「世代与兼容性」。

## 包含什么

```
dsh-setup/
├── README.md
├── setup.ps1                    # Windows 一键部署
├── setup.sh                     # Linux/macOS 一键部署
├── package.json                 # 仓库自身的工具清单（不含插件依赖，见下）
├── scripts/
│   ├── derive-profile.mjs       # 从 plugins.intent.json 推导生成物
│   ├── derive-profile.selftest.mjs   # 推导脚本的变异自检
│   ├── check-template.mjs       # 模板一致性检查（CI 与 setup 都会调）
│   ├── check-template.selftest.mjs   # 检查器的变异自检
│   ├── e2e-verify.mjs           # 端到端校验
│   └── fix-ps1-bom.mjs          # 给 .ps1 补 UTF-8 BOM
└── profiles/
    ├── web/
    │   ├── plugins.intent.json  # ← 唯一事实源：要哪些插件、什么版本、按什么顺序挂载
    │   ├── package.json         # 【生成物】依赖 + bundles，勿手改
    │   ├── cordis.patch.yml     # 用户 patch 层（mslearn MCP 等）
    │   ├── cordis.yml           # profile 根（空列表，勿改）
    │   └── pnpm-workspace.yaml  # pnpm 配置（allowBuilds 段是生成物，其余手写）
    └── web.local/               # 站点覆盖层（可选，部署时递归合并到模板之上）
```

**`profiles/web/plugins.intent.json` 是唯一事实源。** 人只维护这一个文件；`package.json` 与 `pnpm-workspace.yaml` 里的 `allowBuilds` 段都由 `scripts/derive-profile.mjs` 从它推导生成，`pnpm test` 的第一项就是断言两者仍然一致 —— 手改生成物必被拒。

为什么要把清单拆成「意图」和「生成物」：此前的 24 条依赖、30 行 allowBuilds、4 条 overrides 全是手工维护的快照，仓库历史就是 20 多条 `fix`/`sync`/`chore`/`bump` —— 每处腐化都被单独记住，没有任何一处能被整体验证。换成推导后，有三类东西不再是"约定"而是"算出来的"：

- **overrides 不再手写**：脚本去查 `@linxin666/dsh-web-all` 当前版本的 `dependencies`，把其中所有带 `^`/`~` 的子包钉到同一版本。所以那 4 条永远不会过期。
- **allowBuilds 不再"多列无害"**：规则是 `github:`/`file:` 依赖 ∪ 声明了构建脚本的 npm 依赖 ∪ 显式声明的传递构建依赖。旧写法把全部 24 个依赖都列上，理由是"多列无害"——那不是理由，是没人算过。算完发现其中 4 个纯 npm 包根本没有构建脚本。
- **装了却没挂载** 会被直接判失败（每个依赖都必须出现在 `bundleOrder` 里）。

根目录的 `package.json` 仍然**故意不声明任何插件依赖** —— 早先它是一份「信息副本」，结果是两份各漂各的：那份副本把 `@snow-the/*` 钉在 0.1.x 精确版本，还一直带着 modsearch、vision-toolkit、memory-plugin 这些后来被弃用的包。重复即漂移，所以重复被删掉了。

## 快速开始

前置：Node.js 18+、[pnpm](https://pnpm.io/)（`pnpm i -g pnpm`）、`npm i -g @deepseek-ai/dsh`。

```powershell
# Windows
git clone https://github.com/snow-The/dsh-setup.git
cd dsh-setup
.\setup.ps1
```

```bash
# Linux / macOS
git clone https://github.com/snow-The/dsh-setup.git
cd dsh-setup
./setup.sh
```

脚本流程：**模板自检 → 远端同步预检 → 备份旧 profile → 复制模板 → 应用 web.local 覆盖 → pnpm install → 冒烟测试 → 兼容性预检**。

可选参数：`-SkipInstall` / `-SkipSmoke` / `-Force`（Windows，加 `--` 前缀形式在 bash 端同义）。

### 手动部署

```bash
git clone https://github.com/snow-The/dsh-setup.git
mkdir -p ~/.dsh/profiles
cp -r dsh-setup/profiles/web ~/.dsh/profiles/web
cd ~/.dsh/profiles/web && pnpm install
dsh web
```

### 站点覆盖层 `profiles/web.local/`（可选）

机器特有配置放在这里，部署脚本会在复制模板后**递归合并**到目标 profile 之上（同名文件覆盖模板）。该目录不存在则自动跳过。

## 配置凭据（每台机器必做）

本仓库**不含任何 key**。首次启动后在 Web GUI 里配置：

- 模型 API key —— GUI 的模型/设置页，或环境变量 / `~/.dsh/settings.yaml` 的凭据段；
- SSH 主机 —— GUI 的 SSH 插件页；
- 其余凭据同理。

## 插件清单

### 官方层

| 包 | 说明 |
|---|---|
| `@deepseek-ai/dsh-base` | 核心层（timer / llm / session / agent…），由 dsh 宿主提供 |
| `@deepseek-ai/dsh-web-app` | Web 应用层（code-runtime / storage…），由 dsh 宿主提供 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **原生多 agent 团队**（取代第三方的 `@nanmicoder/dsh-agent-teams`） |

### 自研插件（`@snow-the/*`，均从 GitHub 安装）

`dsh-acp-memory` · `dsh-browser` · `dsh-busyloop` · `dsh-gitkit` · `dsh-lib-analyzer` · `dsh-notemap` · `dsh-plugin-doctor` · `dsh-plugin-guide` · `dsh-research-lab` · `dsh-search` · `dsh-session-handoff` · `dsh-session-repair` · `dsh-skill-pack` · `dsh-snapshot` · `dsh-eigenflux` · `dsh-w8-sandbox`

> `dsh-eigenflux` 与 `dsh-w8-sandbox` 原先**没有 git remote** —— 你在本机是靠 `file:` 引用跑它们的，所以它们曾是新机器上唯二装不回来的插件。现已建仓：[snow-The/dsh-eigenflux](https://github.com/snow-The/dsh-eigenflux) · [snow-The/dsh-w8-sandbox](https://github.com/snow-The/dsh-w8-sandbox)。

### 第三方

| 包 | 用途 |
|---|---|
| `@linxin666/dsh-web-all` | Web UI 全家桶（SSH / 任务看板 / Git 图谱 / 皮肤中心 / 远程 UI…） |
| `@linxin666/dsh-session-archive` | 会话归档 |
| `@mars-sea/dsh-commandcode-provider` | commandcode 模型通道 |
| `dshmarket` | 插件市场 |
| `aegis` | Aegis 方法论（钉 `#v2.12.0`：该 tag 才适配 0.2.0） |
| `@tt-a1i/archify-dsh` | 架构图生成 |
| `dsh-undo-savepoint` | 配置撤销/回滚快照（已上 npm） |
| `dsh-ark-plan` | Volcano Ark 计划 API 激活 |
| `mcp-mslearn`（patch 插入） | Microsoft Learn 官方文档 MCP（免费，无需 key） |

### 已移除（不要再加回来）

模板的检查器会把它们判成失败，理由一并记在这里：

| 包 | 为什么移除 |
|---|---|
| `@liustack/modsearch` | 作者已声明弃用 |
| `@liustack/modlens` | 作者已声明弃用 |
| `@anionex/dsh-vision-toolkit` | 作者已声明弃用 —— **DSH 0.2.0 已能原生读图** |
| `@nanmicoder/dsh-agent-teams` | 被原生 agent-team profile 取代 |
| `@openviking/dsh-memory-plugin` | peer 是 `>=0.1.0-rc.6 <0.2.0`，在 0.2.0 宿主上**必然 ERESOLVE** |
| `dsh-web` · `@linxin666/dsh-web-ui-all` · `@linxin666/dsh-client-ui-skin-center` | 均被 `@linxin666/dsh-web-all` 收拢 |
| `@snow-the/dsh-ui-shim` | **已退役，见下** |

### `dsh-ui-shim` 为什么退役

它是在「同时装有两套 UI」的时期写的：给 DOM 打上 `data-pane` / `data-dsh-frame` 标记，让插件不必依赖官方会变的 class 名去定位侧栏/对话区/详情区。三条证据说明它的前提已经消失：

1. **零消费者** —— 全部自研插件里没有任何一处读它打的那几个属性；
2. **两个 profile 都没装它**，也都不在依赖清单里；
3. 它当时 `dsh.client.inject` 声明的是 `@deepseek-ai/dsh-client-runtime`，**而那个包在 0.2.0 里根本不存在** —— 也就是说它在 0.2.0 上从未真正跑起来过。

现在只剩 `@linxin666/dsh-web-all` 一套 UI，中间层没有存在理由。源码保留在 `dsh-own-plugins` 里可随时取回，但不再进入任何模板。

## 世代与兼容性

**本模板面向 DSH `0.2.0`+，不兼容 0.1.x。**

这不是口号，而是宿主会强制执行的：每个 `@snow-the/*` 插件在自己的 `package.json` 里声明

```json
"peerDependencies": { "@deepseek-ai/dsh": ">=0.2.0-rc.1" }
```

含义是「本插件属于 0.2.0 世代」。宿主启动预检时用 `semver.satisfies(runtime, range, { includePrerelease: true })` 比对，**不满足就把该插件禁用**，只在 stderr 留一行。所以在 0.1.x 上跑本模板，插件一个都不会加载。

三条与本模板直接相关的经验，都已写进各插件的 `docs/compatibility.md`：

1. **peer 一律纯下界，绝不加上界。** 带上界的范围今天可能靠 `includePrerelease` 侥幸通过，到正式版就会落闸。（`@snow-the/dsh-busyloop` 原先的 `>=0.1.1-rc.2 <0.2.0` 正是如此 —— 它会在 0.2.0 正式版发布当天自毁。）
2. **`dsh.compatibility` 这个清单字段宿主不读**，它只是我们自己的记录。真正生效的门禁只有 `peerDependencies`。
3. **`pnpm peers check` 看不到这个失败模式。**

> 为什么下界是 `>=0.2.0-rc.1` 而不是字面的 `>=0.2.0`：宿主比对带 `includePrerelease`，而 `0.2.0-rc.2` **不满足** `>=0.2.0`。写 `>=0.2.0` 会让每个插件在 0.2.0 正式版发布前就被禁用。两者划的是同一条世代界线，前者今天可用。

### 版本策略：浮动，不钉死

| 依赖形式 | 策略 |
|---|---|
| `@snow-the/*` | `github:snow-The/<pkg>` —— **跟随默认分支 HEAD，浮动** |
| npm 包 | `^x.y.z` 浮动 |
| `aegis` | `#v2.12.0` —— **故意钉 tag**：只有该版本适配 0.2.0 |
| `@deepseek-ai/*` | 跟随宿主 |

> 早先 README 说「`@snow-the/*` 使用精确版本」——**那是错的，代码里从来没钉过版本**（一直是 `github:` 无 ref）。真正钉死的是那份已删除的顶端信息副本。

**不提交 `pnpm-lock.yaml`**：各机器平台/Node 版本不同，首次 `pnpm install` 现场解析。因此每次部署都应重跑 `pnpm install` 以拾取新版本。

## 模板一致性检查

任何改动后跑一次：

```bash
pnpm test        # 四个程序全跑：推导自洽 + 模板自洽 + 两个变异自检
pnpm derive      # 改完 plugins.intent.json 后重新生成（= derive-profile.mjs --write）
pnpm check       # 只跑模板一致性检查
pnpm selftest    # 只跑两个变异自检
```

`pnpm test` 依次跑四个**互相独立**的程序：

1. **`derive-profile.mjs`** —— 断言生成物仍与意图一致。它有 7 条结构断言（宿主层不许重复声明、每个 bundle 都要有来源、每个依赖都必须被挂载、bundleOrder 不许重复、npm 版本必须是精确版本、derivedOverridesFrom 必须指向 npm 依赖、意图里不许有拼错的字段）。
2. **`check-template.mjs`** —— 17 条语义检查，每条都有稳定 ID（输出里带 `[1f]`）。覆盖：bundle 来源、退役包、`@snow-the/*` 钉版、overrides 只约束第三方、宿主世代耦合包必须精确钉版本、宿主自有包不许重复声明、allowBuilds 与 git 依赖对齐、hash 形式的过期键、`cordis.patch.yml` 重复声明、`cordis.yml` 必须为空、`.ps1` 的 UTF-8 BOM、`setup.ps1` 不许用裸 `Get-Content` …… 运行到最后还会自证**登记过的 17 条本次都真的执行过**（防"规则静默不触发"）。
3. **`derive-profile.selftest.mjs`** —— 9 个变异用例，断言上面那 7 条断言**每一条都真的会落闸**，包括"手改生成物"必须被抓到。
4. **`check-template.selftest.mjs`** —— 21 个变异用例，断言 17 条检查**每一条都至少被一个用例覆盖**，并把"登记过但没被执行"这项机制本身也当作一条用例去破坏、断言它会落闸。

两个自检都做**精确归因**：每条变异都声明期望由哪条规则抓到，而不是只看退出码非 0 —— 否则一条变异被别的规则误抓也算通过，那条真正要验的规则就从没被证明过。

写第一个自检时它当场抓出了检查器自身的一个 bug —— allowBuilds 的键解析不允许冒号，而 hash 形式的键恰好含 `https:`，导致那条断言一直形同虚设。写第二个自检时它又抓出了 `[2]` 没有任何用例覆盖、以及自证专用 ID 被误判为"漂移"。**这正是变异自检存在的意义：它会抓出你自己。**

## 升级

```bash
git -C <dsh-setup目录> pull
cd <dsh-setup目录> && .\setup.ps1    # 或 ./setup.sh
```

脚本会先把旧 profile 备份成 `web.bak-<时间戳>`，随时可回退。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 启动后插件一个都没加载 | 宿主版本低于 0.2.0，或某个 peer 范围不满足。看启动时的 stderr，宿主会逐个打印被禁用的插件及原因。 |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | `profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 缺了某个 git 依赖。跑 `npm run check` 会直接指出来。 |
| `pnpm install` 提示忽略 build scripts | pnpm 10 默认禁止依赖的 postinstall。模板已放行 `ssh2` / `node-pty` / `cpu-features` / `cloudflared`；新增带原生编译的依赖时记得同步。 |
| 冒烟测试 `[FAIL]` | 某 bundle 缺可加载入口。先重跑 `pnpm install`；git 依赖需要能访问 GitHub。 |
| 兼容性预检报某插件会被禁用 | 该插件的 peer 范围不满足当前宿主。按提示升级该插件或升级宿主。 |
| git 依赖 clone 慢/失败 | 需要能访问 GitHub；可配代理。 |
| 脚本提示「本地与远端不一致」 | 模板可能过期：先 `git pull` 再跑；确认无误可加 `-Force`。 |

## 注意

- `node_modules/`、`.dsh-market/` 等由本机生成，不进仓库；
- git 依赖（`github:snow-The/*`、`github:GanyuanRan/Aegis`）安装时需要能访问 GitHub；
- profile 把 `packageManager` 钉在 pnpm 10：pnpm 11 改了 `allowBuilds` 的键格式（要求 `name@<tarball-url-with-commit>`），与模板的裸名清单不兼容。
