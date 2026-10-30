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
│   ├── npm-view.mjs             # `npm view` 输出规范化（npm 12 把单结果包成数组）
│   ├── derive-profile.selftest.mjs   # 推导脚本的变异自检
│   ├── check-template.mjs       # 模板一致性检查（setup 的装配验证也会调）
│   ├── check-template.selftest.mjs   # 检查器的变异自检
│   ├── verify-all.mjs           # 一条命令跑完六层验证（win/linux 通用，不依赖 CI）
│   ├── audit-all.mjs            # 一次跑完四条审计轴（依赖/同代/运行时/日志），任一失败即退出 1
│   ├── audit-generation.mjs     # 插件与宿主是否同一代（import / client 注入 / 解析目标 / 声明）
│   ├── audit-plugins.mjs        # 对一个 profile 的依赖做六维审计（来源/版本/内容/世代/入口/挂载）
│   ├── audit-runtime.mjs        # 运行时足迹（spawn/端口/定时器/绝对路径）+ --expect-host 世代一致性
│   ├── audit-logs.mjs           # 插件写进启动通道的日志是否合规（前缀 / 级别 / 值 dump）
│   ├── boot-check.mjs           # 真启动一次 profile，验证装配/服务/无报错
│   ├── plugin-load-check.mjs    # 在指定宿主的真实包上执行插件入口（严格钉住宿主版本）
│   ├── host-map.mjs             # 把 @deepseek-ai/* 严格钉到指定宿主 + 解析自证
│   ├── host-range.mjs           # 判定「插件声明的宿主范围认不认这一代」（rc 号参与比较）
│   ├── preflight-host.mjs       # 部署前问一句：这台机器的宿主认不认这份 profile（旧宿主会静默跳包）
│   ├── carry-over-deps.mjs      # 升级时把操作者自己加的依赖接过来（模板不认识 forge9 这类本地方案）
│   ├── upgrade-host.mjs         # 就地升级全局 dsh 到这份 profile 要的世代（含原生依赖放行、被占用检测）
│   ├── e2e-verify.mjs           # 端到端校验
│   └── fix-ps1-bom.mjs          # 给 .ps1 补 UTF-8 BOM
└── profiles/
    ├── web/
    │   ├── plugins.intent.json  # ← 唯一事实源：要哪些插件、什么版本、按什么顺序挂载
    │   ├── package.json         # 【生成物】依赖 + bundles，勿手改
    │   ├── cordis.patch.yml     # 用户 patch 层（默认空 `[]`，见「外部服务不进 MCP」）
    │   ├── cordis.yml           # profile 根（空列表，勿改）
    │   ├── third-party-gaps.json # 第三方「门禁无从判定」的记录（check-template [8] 校验它与依赖一致）
    │   ├── .npmrc               # 关掉 peer 自动安装（[2d] 校验；见「干净安装为什么会死在 peer 上」）
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

脚本流程：**模板自检 → 远端同步预检 → 备份旧 profile → 复制模板 → 应用 web.local 覆盖 → pnpm install → 冒烟测试（入口文件）→ 装配验证（`dsh --dump-config`）→ 兼容性预检**。

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
| `aegis` | Aegis 方法论（github tag 钉版本，不跟浮动分支） |
| `@tt-a1i/archify-dsh` | 架构图生成 |
| `dsh-undo-savepoint` | 配置改动即快照 + 撤销/重做 + 安全模式（第三方，**不是**我们的 `@snow-the/dsh-snapshot`；分工见下节） |
| `dsh-ark-plan` | Volcano Ark 计划 API 激活 |

### 两个"快照"插件怎么分工（别把它们当重复件）

| | `@snow-the/dsh-snapshot`（自研） | `dsh-undo-savepoint`（第三方 `lire1131`） |
|---|---|---|
| 触发 | 手动 | 配置一改就自动（watch 1.5s 防抖） |
| 粒度 | 整包 `~/.dsh`（排除 node_modules），tar.gz + sha256 + 轮转 | 单个配置文件，按次留档 |
| 能做什么 | `snapshot_backup` / `snapshot_list` / `snapshot_restore` | `undo_restore`（按次回退）/ redo / `undo_safe_mode` / `undo_doctor` / `undo_scan` |
| 救不救得了起不来的 DSH | 救不了（它自己是插件，得能启动才跑） | **救得了**：带离线 CLI 与 GUI |

保留第三方的那个是因为最后一列：2026-10-27 它两次在 DSH 起不来的情况下把整份 `cordis.patch.yml` 还了回来。代价是它的自愈写出有过破坏性（`cleanDanglingInserts` 会把 patch 层写成 1 字节），已记进 `third-party-gaps.json` 并在配置侧绕开。

### 外部服务：skill + CLI，不挂 MCP

第三方 MCP 服务器的 tool schema 是**每一次请求**的常驻开销，跟这一轮用不用得着毫无关系。实测过的代价：REA 那个 207 工具挂载约 **3.1 MB schema / 请求**，即使一轮完全不碰逆向也在付；Microsoft Learn 只有 3 个工具，但同样是每一轮的固定税。

所以外部服务的形状是 **skill + CLI**：skill 文本按需加载、说清什么时候怎么调；调用就是一条普通 shell 命令；不调用就一分不付。Microsoft Learn 是现成例子 —— skill 是 `microsoft-docs`，命令是官方 CLI：

```sh
npx -y @microsoft/learn-cli search "azure functions timeout"
npx -y @microsoft/learn-cli fetch "<url>" --section "Configure" --max-chars 4000
npx -y @microsoft/learn-cli code-search "cosmos db change feed"
```

它连的是同一个官方端点（`https://learn.microsoft.com/api/mcp`），结果和 MCP 一致 —— 差别只是由 CLI 自己发 MCP 调用、再把 markdown 打出来。

只在**工具必须参与交互式 tool-calling 循环**、逐步 shell 明显更差时才挂 MCP。模板检查 `[3a]` 会把挂 MCP 的 patch 层判成失败。

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
| `mcp-mslearn`（patch 插入的 MCP 行） | 外部 MCP 的 schema 常驻每次请求；改用 `microsoft-docs` skill + `@microsoft/learn-cli`。见上节 |

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

### 三个 `dsh` 入口必须同版（`preflight-host` 第 4 条判据）

同一台机器上可以同时存在三个「`dsh`」，而它们**不一定同版**。2026-10-30 实测：

```text
dsh --version                              → 0.2.1-rc.5   （PATH；npx 缓存里的那一份）
~/AppData/Roaming/npm/dsh.cmd --version    → 0.2.1-rc.2   （全局安装，旧的）
正在服务 :3080 的进程                       → 0.2.1-rc.5   （npx 缓存）
```

危险的不是「多装了一个」，而是**重启脚本拉的是第三个**：那一刻用 shim 重启，就等于把宿主
换回 rc.2；而 profile 里 `@linxin666/*` 要求 `>=0.2.1-rc.3` —— 于是又会静默跳过 bundle，
症状和笔记那台机器一模一样，只是这次发生在桌面上。

`preflight-host` 现在会列出三个入口并比对，任一不同版即 `exit 1`：

```bash
node scripts/preflight-host.mjs              # 默认看 :3080
node scripts/preflight-host.mjs --port 3081
```

修法二选一，都不许「知道就好」：
1. 把三者对齐到同一版（通常是 `npm i -g @deepseek-ai/dsh@<正在跑的版本>`）；
2. 让重启照**正在跑的那个入口**拉起 —— `restart-host.mjs` 已经改成这样做：先从进程命令行
   取它自己的 `lib/bin.js`，照原样重启，取不到才退回 shim，并且**在日志里写明用了哪一个**。

> 判据前三条（宿主够新、插件范围接受、rc 参与比较）在当时**全是绿灯**。
> 它们只回答「`dsh` 是几版」，没有回答「是**哪一个** `dsh`」。

### 挂载一个 bundle 插件：两处，不是三处

`dsh` 的 profile 有两种挂法，**只用第一种**：

| 做法 | 位置 | 结论 |
|---|---|---|
| 依赖 + bundle 列表 | `package.json` 的 `dependencies` ＋ `dsh.profile.bundles` | ✅ 正确；插件自带的 `cordis.patch.yml` 会自己声明 id |
| 再在 profile 的 `cordis.patch.yml` 写一行 `- id: <id>` | `profiles/web/cordis.patch.yml` | ❌ **不要** |

第二种不会报错，只会**静默重复声明**：加载器对同一个 id 只保留一个 entry，
后到的覆盖先到的（`doctor_patch` 报 `duplicate-declaration-cross-file`）。
在 `2026-10-30` 的实际注入中，`@snow-the/*` 全部只靠 bundle 列表挂载，
profile 的 patch 层里一行都没有 —— 那不是遗漏，是规则。

```bash
pnpm check          # 模板一致性；挂载规则由它 + doctor_patch 一起把关
pnpm load:check     # 在正确的宿主副本上真的执行一遍插件模块
```

插件本身的 id 冲突用 `doctor_patch`（`dsh-plugin-doctor`）看：它报
`duplicate-declaration-cross-file` 就是这里说的那种静默覆盖。

> 另一个容易忘的事实：`file:` 依赖在 profile 里是**硬链接**，不是复制。
> 所以「重建插件 dist」= 直接写进生产 profile；`sync-profile-dists --check`
> 拿它自己是比对基准，因此永远显示「一致」。要重置插件，就重装依赖，不要只 rebuild。

## 模板一致性检查

任何改动后跑一次：

```bash
pnpm test        # 四个程序全跑：推导自洽 + 模板自洽 + 两个变异自检
pnpm derive      # 改完 plugins.intent.json 后重新生成（= derive-profile.mjs --write）
pnpm check       # 只跑模板一致性检查
pnpm selftest    # 只跑两个变异自检
pnpm boot:check  # 真启动一次已部署的 profile（需要先 .\setup.ps1 部署过）
                 # 默认在临时 DSH_HOME 里起（profile 配置复制一份，写不落到活配置上）；
                 # 想直接在活 home 上跑就 node scripts/boot-check.mjs --live
```

**审计插件版本时务必带 `--runtime`**，否则「最新」只等于「有新版」：

```bash
node scripts/audit-plugins.mjs --profile-dir ~/.dsh/profiles/web --runtime 0.2.1-rc.2
```

给了它，审计会去问新版的宿主范围（`engines.dsh` 优先、退回 peer），rc 号参与比较 ——
输出会区分「落后（真能升）」和「本世代最新（新版要更高一代宿主，别升）」。
不带它，这两种情况分不开，2026-10-27 就因为把 `@linxin666/*` 的 0.4.11 当成可升，
白白怀疑了一轮（0.4.11 要 `>=0.2.1-rc.3`，在 rc.2 上会被门禁整包拒载）。

### 为什么需要 `boot:check` —— 一个实测出来的层次差异

2026-10-19 在部署出来的 profile 上做了对照实验，往某个 bundle 的 patch 里注入一条
引用了**不存在模块**的 `- insert:` 声明：

| 检测层 | 结果 |
|---|---|
| `dsh --dump-config` | exit 0，stderr **0 行**，那条 row 照常出现在输出里 —— **完全看不见** |
| 真实启动 | `✗ ghost (@deepseek-ai/dsh-nonexistent-module): failed to import: ERR_MODULE_NOT_FOUND` |

原因是 `--dump-config` 只**组合** YAML，不解析模块。

所以 `setup.ps1` / `setup.sh` 里的装配验证（dump-config 的 stderr 必须为空）是
**必要但不充分**的：它能抓「配置指向不存在的条目」（`patch: entry "x" not found`），
抓不到「insert 的模块解析不了」「插件 apply 抛错」「服务注册冲突」。
最后这一类只有 `pnpm boot:check` 看得见 —— 它要求进程存活 + 端口监听 +
拿到含 `__DSH_BOOT__` 的页面 + stderr 无真实错误，四项同时成立。

已知良性输出（task-board 单实例锁、MCP 启动横幅）在脚本里有**带理由的分类器**，
不是静默白名单。

### 第三层：`pnpm load:check` —— 在正确的宿主副本上执行插件模块

`boot:check` 证明"宿主带着这堆插件起得来"，但它看不到**插件是否真的按这代宿主的 API 初始化**。
`plugin-load-check.mjs` 直接 `import` 每个插件入口，让顶层代码（`defineTool(...)` 等）在
**指定宿主的真实包**上执行一遍。

这里有个必须防的陷阱，是实测出来的：

```
不加约束时 import 插件入口，解析到的是
  <npx 缓存>/@deepseek-ai/dsh-tools   v0.1.5-rc.3   ← 另一个世代
```

Node 从插件目录向上查找就会命中它。于是"能加载"可能是在**错误的世代**上得出的，
而且看起来完全正常。所以 `host-map.mjs` 装一个**严格**解析钩子：
`@deepseek-ai/*` 只能解析到 `--host` 指定的那份，映射不到直接报错、**绝不回退**。

而且这个护栏**自己会撒谎过**，代价记在这里：上一版从 `process.env.HOST_NM` 读宿主路径，
调用方却是用 `--host` 参数传的 —— 两条通道没接上时钩子静默退化成直通。在 CI 的干净环境里
它响亮地失败（`Cannot find package '@deepseek-ai/dsh-tools'`），但在本机上它静默落到了
`v0.1.5-rc.3` 上并报"全过"。同一个缺陷，一处响一处哑。

所以现在的形态是：宿主路径是 `armHostMap()` 的**必选参数**，没有直通这条退化路径；
并且跑任何插件之前先做**自证** —— `import.meta.resolve` 的结果必须落在 `--host` 目录里，
否则直接退出 2。自证不是锦上添花，它是本地那次假通过唯一的防线。

```bash
# 先给一个宿主 node_modules 的绝对路径（例如一份按目标世代装好的 dsh）
node scripts/plugin-load-check.mjs --profile web --host /path/to/host/node_modules
```

`pnpm test` 依次跑四个**互相独立**的程序：

1. **`derive-profile.mjs`** —— 断言生成物仍与意图一致。它断言的都是结构性质（宿主层不许重复声明、每个 bundle 都要有来源、每个依赖都必须被挂载、bundleOrder 不许重复、npm 版本必须是精确版本、derivedOverridesFrom 必须指向 npm 依赖、意图里不许有拼错的字段）。
2. **`check-template.mjs`** —— 语义检查，每条都有稳定 ID（输出里带 `[1f]`）。权威清单用 `node scripts/check-template.mjs --list-checks` 取，**散文里不写条数** —— 写了就会漂，这是本仓库反复验证过的。覆盖：bundle 来源、退役包、`@snow-the/*` 钉版、overrides 只约束第三方、宿主世代耦合包必须精确钉版本、宿主自有包不许重复声明、allowBuilds 与 git 依赖对齐、hash 形式的过期键、`cordis.patch.yml` 重复声明、`cordis.yml` 必须为空、`.ps1` 的 UTF-8 BOM、`setup.ps1` 不许用裸 `Get-Content`、README 文件树必须列出全部脚本、第三方门禁盲区记录不得陈旧 …… 运行到最后还会自证**登记过的检查本次都真的执行过**（防"规则静默不触发"）。
3. **`derive-profile.selftest.mjs`** —— 变异用例，断言上面每一条结构断言**都真的会落闸**，包括"手改生成物"必须被抓到。
4. **`check-template.selftest.mjs`** —— 变异用例，断言每一条检查**都至少被一个用例覆盖**，并把"登记过但没被执行"这项机制本身也当作一条用例去破坏、断言它会落闸。

两个自检都做**精确归因**：每条变异都声明期望由哪条规则抓到，而不是只看退出码非 0 —— 否则一条变异被别的规则误抓也算通过，那条真正要验的规则就从没被证明过。

写第一个自检时它当场抓出了检查器自身的一个 bug —— allowBuilds 的键解析不允许冒号，而 hash 形式的键恰好含 `https:`，导致那条断言一直形同虚设。写第二个自检时它又抓出了 `[2]` 没有任何用例覆盖、以及自证专用 ID 被误判为"漂移"。**这正是变异自检存在的意义：它会抓出你自己。**

## 跨平台验证（Windows / Linux，在**我们自己的机器**上跑）

验证**不挂在 CI 上**。这个仓库要验的东西包括"真装一份宿主、真起一次服务"，
而 GitHub 的 runner 不是我们的机器，行为控不住，而且每次 push 都会真的跑起来。
所以验证就在我们持有的机器上跑，一份命令两边通用：

```bash
node scripts/verify-all.mjs                       # 静态四层，任何机器都能跑，不联网
```

要走完装配层与加载层，把宿主明确指出来：

```bash
node scripts/verify-all.mjs --dsh <宿主bin/dsh> --host <宿主>/node_modules --profile web
```

`--dsh` / `--host` 是**必给的显式路径**，不接受"自己猜一个" —— 因为不加约束时 Node 会沿
查找路径命中另一个世代的副本，然后给你一个漂亮的假通过（本仓库踩过，见上一节）。
没给的时候这两层会被标成 `SKIP` 并写明缺哪个参数，**跳过不算通过**。

六层的顺序是从便宜到贵、从抽象到真实：

| 层 | 证明什么 | 需要 |
|---|---|---|
| 推导自洽 | 生成物能从意图还原 | — |
| 模板自洽 | 模板自身一致，且每条检查这次真的执行了 | — |
| 两个变异自检 | 每条断言/检查都真的会落闸 | — |
| 真启动一次 | 装配成功、服务可访问、无真错误 | `--dsh` |
| 插件入口初始化 | 每个插件在**钉住的宿主**上能真的 init | `--host` |

已实测的两个平台（2026-10-19）：

- **Windows 11** / Node v26.7.0 / npm 11.19.0：四层静态 + `boot-check` PASS + `plugin-load-check` 17/17
- **Arch Linux** / Node v26.4.0 / npm 12.0.1：四层静态 + `boot-check` PASS（HTTP 200 / 49,515 字节 / `__DSH_BOOT__` / 0 真错误）+ `plugin-load-check` 16/16

不要低估第二台的价值 —— 它**当场抓出了一个只在新环境里出现的缺陷**：npm 12 把
`npm view <pkg> <field> --json` 的单结果包成数组，旧代码对数组判 `Object.hasOwn` 恒为
false，于是每个 npm 依赖都被静默判成"没有构建脚本"，生成物安静地少掉六条 `allowBuilds`。
在 npm 11 的两台机器上永远是绿的。细节见 `scripts/npm-view.mjs` 的头注释。

两次 Linux 验证都是在**有真实负载的机器**上做的（其中一台同机跑着生产实例，另一台跑着
两个 MC 服务）：私有宿主装进独立目录、`DSH_HOME` 指向独立目录、服务用临时空闲端口启动 ——
全程没碰系统里的 `dsh`，也没碰 `~/.dsh`。

## 宿主解析层：`profiles/node_modules`（装得上 ≠ 跑得起来）

插件的 `import '@deepseek-ai/dsh-tools'` 走 Node 的常规向上查找；而 profile 自己的
`node_modules` 里**没有**宿主包 —— 它们是 peer，本 profile 又设了 `autoInstallPeers: false`。
所以必须有一层 `~/.dsh/profiles/node_modules` 指向宿主的 `node_modules`：

```
~/.dsh/profiles/node_modules  →  <dsh 安装位置>/node_modules
```

少了它，正常表现是「装得上、解析不到」：依赖装完了、`dump-config` 也过了，但插件的
`@deepseek-ai/*` 无处可寻。

这件事长期没人写下来，后果是：这台开发机当年靠**手工**建的 junction 让它工作，
而全新机器上装出来的 profile 缺这一层 —— 2026-10-19 用隔离 home 实测复现：
4 个插件报 `@deepseek-ai/dsh-tools 解析不到`；补上这层后立刻变成
**硬伤 0 / 不可判定 0 / 合规 16**。

`setup.ps1` / `setup.sh` 现在会自动建立它（Windows 用 junction，Linux 用 symlink），
**已存在就不覆盖**（它可能是有人刻意做的共享 farm）。

## 世代一致性（这一层是因为一天里连踩五个静默故障才加的）

四条轴一起跑（依赖 / 同代 / 运行时 / 日志），任一失败即退出 1 —— 装的时候就能断言，
不靠谁想起来：

```bash
node scripts/audit-all.mjs --profile-dir ~/.dsh/profiles/web --host <宿主 node_modules>
```

只查同代这一条轴：

```bash
node scripts/audit-generation.mjs --profile-dir ~/.dsh/profiles/web --host <宿主 node_modules>
```

四条判据，分**硬伤**与**软项**：

| 判据 | 种类 | 为什么 |
|---|---|---|
| 代码里 `import` 的 `@deepseek-ai/*` 必须在目标宿主里存在 | **硬** | 不存在就是 `ERR_MODULE_NOT_FOUND`，插件整个不加载 |
| client bundle 把 `@deepseek-ai/*` 客户端包当模块 `require` | **硬** | 官方明令禁止；组件一抛错就静默清空整条 slot 条目（`slot entry crashed`），纯 JS 插件没有类型检查兜着 |
| 插件的 `@deepseek-ai/*` 解析必须落在**这个**宿主里 | **硬** | 查找路径上另一代的副本会让"全绿"毫无意义（0.1.5 服务 0.2.1 的真实事故） |
| `dsh.client.inject` 的每一项必须是宿主里存在的包 | 软 | 加载器对它**静默跳过**（`dsh-client-modules/lib/client.js:789` 的 `if (dependency !== void 0)`），消费者照常加载 —— 丢的是加载顺序意图、声明变成假话，不会阻止挂载。（2026-10-19 对着加载器源码验过：这条曾被写成"硬伤"，是错的） |
| `engines.dsh` 是否声明 | 提示 | 宿主门禁真正读的是它（0.2.1 起优先且排他）。不声明 = 装到哪都被接受 = 门禁形同虚设 |
| `dsh.compatibility.dshReleases` 是否包含这一代 | 软 | 声明落后不等于会坏，但必须有人决定"验过了吗" |

**为什么必须分硬软**：这套机器实测是 3 硬伤 / 13 软项。如果全算失败，17 个插件里 16 个红，人就会学会无视这个工具 —— 那才是真正的失败。

## 依赖审计（六维，比"版本号新不新"更硬）

```bash
node scripts/audit-plugins.mjs --profile-dir ~/.dsh/profiles/web
```

只比版本号是**不够**的，这一点有实例：`@tt-a1i/archify-dsh` 在 npm 上的 latest 是 `1.0.0`，
仓库里 `integrations/deepseek-harness` 的版本号也还是 `1.0.0` —— 但发布之后仓库又合了
`fix(dsh): preserve default skills across installation and upgrade`，npm 包里的
`cordis.patch.yml` 仍是 `includeDefaultRoots: false`，仓库里已经是 `true`。
**版本号冻结、内容落后**，任何只看 version 的检查都发现不了。

所以审计分六维，每维都给证据：

| 维度 | 抓什么 |
|---|---|
| ① 来源可达 | `github:` 仓库/tag 在不在；`file:` 有没有 git 远端（没有 = 新机器装不回来） |
| ② 版本新鲜 | npm dist-tag / git tag 的**semver 最大**（不是 `ls-remote` 的字典序，`v2.9.9` 会排到 `v2.13.0` 后面） |
| ③ 内容新鲜 | npm 包的发布时间 vs 仓库对应目录的最后提交 |
| ④ 世代兼容 | 它声明的 `engines.dsh` / peer dsh（宿主包跳过：它们随宿主走） |
| ⑤ 入口存在 | `main`/`exports` 指向的文件 —— `./src/*` 这类**通配符**会展开后判定，不当缺失 |
| ⑥ 挂载一致 | 装了没挂 / 挂了没装 |

已知的两个坑，脚本里都做了处理，因为它自己就先踩过：通配符入口会被误报"缺失"；
宿主包（`@deepseek-ai/*`）拿 npm latest 去比会给出**降级**建议（实测 `0.2.0-rc.2 → 0.0.1-rc.1`）。

## 升级

```bash
git -C <dsh-setup目录> pull
cd <dsh-setup目录> && .\setup.ps1    # 或 ./setup.sh
```

脚本会先把旧 profile 备份成 `web.bak-<时间戳>`，随时可回退。

**升级时保留什么、覆盖什么**（2026-10-27 起）：

| 文件 | 升级后 |
|---|---|
| `cordis.patch.yml`（你的本机配置） | **保留旧层** —— 模板自带的是空 `[]`，脚本会把 `.bak` 里那份接过来并打印字节数 |
| `package.json` | 用模板的（升级插件版本就是靠这一步；保留旧的等于永远升不上去） |
| `cordis.yml` / `pnpm-workspace.yaml` | 用模板的（前者必须为空列表，后者由 `plugins.intent.json` 推导） |
| `profiles/web.local/` | 最后覆盖，优先级最高 |

模板若在某代**自带** patch 条目，就以模板为准、旧层只留在 `.bak` 里 —— 那种情况说明模板有意发布配置。被保留的旧层是按上一代宿主调的，启动失败就对照 `.bak` 收窄，或把本机专属的部分搬进 `profiles/web.local/`（那才是长期该放的地方）。

两条经验记在这里，因为都真踩过：

- `setup.ps1` **必须带 UTF-8 BOM**。Windows PowerShell 5.1 对无 BOM 文件按 ANSI 码页解码，一个中文字符就能让整个脚本解析失败、一行都不执行（报的还是 `UnexpectedToken`，看不出跟编码有关）。`pnpm check` 的 `[5a]` 就是查这个 —— 编辑 `setup.ps1` 之后**立刻**跑一次检查，别等到部署现场。
- 改完 `setup.ps1` / `setup.sh` 想验证升级行为，别拿真机器试：`DSH_HOME=<临时目录>`（sh）或 `USERPROFILE=<临时目录>`（ps1）就是隔离的，配 `--skip-install --skip-smoke --force` 几秒就能跑完一遍。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 启动后插件一个都没加载 | 宿主版本低于 0.2.0，或某个 peer 范围不满足。看启动时的 stderr，宿主会逐个打印被禁用的插件及原因。 |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | `profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 缺了某个 git 依赖。跑 `npm run check` 会直接指出来。 |
| `ERR_PNPM_NO_MATCHING_VERSION` 指向 `@deepseek-ai/dsh*` | pnpm 在装 peer，而这一代宿主只发 prerelease。见下一节 |
| `pnpm install` 提示忽略 build scripts | pnpm 10 默认禁止依赖的 postinstall。模板已放行 `ssh2` / `node-pty` / `cpu-features` / `cloudflared`；新增带原生编译的依赖时记得同步。 |
| 冒烟测试 `[FAIL]` | 某 bundle 缺可加载入口。先重跑 `pnpm install`；git 依赖需要能访问 GitHub。 |
| 装配验证 `[STDERR]` | 宿主在解析 profile 时报警告。最常见：`patch: entry "xxx" not found` —— `cordis.patch.yml` 里那行缺了 `- insert:` 包裹（裸 `- id:` 只能配置已存在的条目）。**注意 `dsh --dump-config` 的退出码仍是 0**，所以只查退出码永远抓不到这类问题。确认无误可加 `-SkipSmoke` 跳过。 |
| 兼容性预检报某插件会被禁用 | 该插件的 peer 范围不满足当前宿主。按提示升级该插件或升级宿主。 |
| git 依赖 clone 慢/失败 | 需要能访问 GitHub；可配代理。 |

### 干净安装为什么会死在 peer 上（`ERR_PNPM_NO_MATCHING_VERSION`）

现象：全新机器跑 `.\setup.ps1`，安装步骤报

```
ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @deepseek-ai/dsh-llm@>=0.2.1 <0.2.2
```

原因不是模板少了一个包，而是 **pnpm 去装了 peer**。这一代宿主的插件大量声明
`@deepseek-ai/dsh*` 的 peer，其中有稳定版范围（`>=0.2.1`、`>=0.2.1 <0.2.2`），
而 npm 上这些包**只有 prerelease**（`latest=0.0.1-rc.1`、`next=0.2.1-rc.4`）。
semver 的 stable-only 范围排除一切预发布版 → 无解。

这些包本来就由宿主自己带着（profile 的 `profiles/node_modules` 解析层指过去），
所以正确的做法是**不装 peer**：

- `profiles/web/pnpm-workspace.yaml`：`autoInstallPeers: false`（workspace 模式下生效）
- `profiles/web/.npmrc`：`auto-install-peers=false` + `strict-peer-dependencies=false`
  —— 项目级 `.npmrc` 不需要 workspace 模式、且优先级高于用户级配置，这才是
  「用户机器上的 pnpm 全局配置把默认值打开」时的真正保险。`check-template [2d]` 会验证它。

**不要**用 `pnpm.overrides` 给 `@deepseek-ai/dsh-llm` 之类钉版本：那会在 profile 里
再造一份宿主包的副本，正是 `[1d]` 拦着的 0.1.x 时代做法。

验证方式（不改自己机器）：

```bash
T=$(mktemp -d) && mkdir -p "$T/profiles/web"
cp profiles/web/{package.json,pnpm-workspace.yaml,.npmrc,cordis.yml,cordis.patch.yml,third-party-gaps.json} "$T/profiles/web/"
cd "$T/profiles/web" && pnpm install        # 用空 lockfile 覆盖真实解析路径
```
| 脚本提示「本地与远端不一致」 | 模板可能过期：先 `git pull` 再跑；确认无误可加 `-Force`。 |

## 注意

- `node_modules/`、`.dsh-market/` 等由本机生成，不进仓库；
- git 依赖（`github:snow-The/*`、`github:GanyuanRan/Aegis`）安装时需要能访问 GitHub；
- profile 把 `packageManager` 钉在 pnpm 10：pnpm 11 改了 `allowBuilds` 的键格式（要求 `name@<tarball-url-with-commit>`），与模板的裸名清单不兼容。
- `derive-profile.mjs` 会查 npm registry（判断哪些依赖声明了构建脚本、哪些是 caret 子依赖）。没有网络时用 `--offline`：它会跳过这些查询，**只**验证结构与顺序，不保证生成物正确。`npm view` 的输出形状由 `scripts/npm-view.mjs` 规范化 —— npm 12 会把它包成数组，遇到不认识的形状脚本会直接报错，不猜。
