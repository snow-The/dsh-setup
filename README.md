# dsh-setup — DeepSeek Harness 多机部署模板

作者 **snow-The** 的 DSH web profile 完整配置(插件列表 + patch 层),用于在新机器上快速部署出与本站一致的环境。

> 🔒 **安全声明:本仓库不包含任何 API key、token、凭据或本机私有数据。**
> 模型 key、SSH 密码、凭据等一律在新机器上自行配置(见下文"配置凭据")。
> 本仓库仅含:`profiles/web/` 的依赖清单、patch 层与 pnpm 配置。

## 包含什么

```
dsh-setup/
├── README.md
├── setup.ps1            # Windows 一键部署脚本
├── setup.sh             # Linux/macOS 一键部署脚本
└── profiles/
    ├── web/             # dsh web profile 模板
    │   ├── package.json        # 插件依赖 + bundles 清单
    │   ├── cordis.patch.yml    # 用户 patch 层(mslearn MCP 等)
    │   ├── cordis.yml          # profile 根(空列表,勿改)
    │   └── pnpm-workspace.yaml # pnpm 配置(allowBuilds 白名单)
    └── web.local/       # 站点覆盖层(可选,部署时合并到模板之上)
```

## 部署步骤

### 前置要求

- Node.js 18+ 与 [pnpm](https://pnpm.io/)(`npm i -g pnpm`)
- 全局安装 dsh CLI:`npm i -g @deepseek-ai/dsh`

### Windows 一键部署

```powershell
git clone https://github.com/snow-The/dsh-setup.git
cd dsh-setup
.\setup.ps1        # 预检 → 备份 → 复制模板 → web.local 覆盖 → pnpm install → 冒烟测试

### Linux / macOS 一键部署

```bash
git clone https://github.com/snow-The/dsh-setup.git
cd dsh-setup
./setup.sh         # 与 setup.ps1 同一流程
```

可选参数:`--skip-install` 跳过安装、`--skip-smoke` 跳过冒烟测试、`--force` 跳过"远端不同步"确认。
```

### 手动部署(任意系统)

```bash
git clone https://github.com/snow-The/dsh-setup.git
# 1. 把 profile 放到 dsh 目录(Windows: ~/.dsh = C:\Users\<你>\.dsh)
mkdir -p ~/.dsh/profiles
cp -r dsh-setup/profiles/web ~/.dsh/profiles/web
# 2. 安装依赖
cd ~/.dsh/profiles/web && pnpm install
# 3. 启动
dsh web
```

### 站点覆盖层 profiles/web.local/(可选)

机器特有配置(settings 片段、私有插件等)放在仓库的 `profiles/web.local/`,部署脚本会在复制模板后将其**递归合并**到目标 profile 之上(同名文件覆盖模板)。该目录不存在的机器自动跳过此步。

### 配置凭据(每台机器必做)

本仓库**不含任何 key**。首次启动后:

- 在 Web GUI 的模型/设置页填入你的 API key(或按官方文档配置环境变量 / `~/.dsh/settings.yaml` 的凭据段);
- 需要远程主机时,在 GUI 的 SSH 插件页自行添加主机(密码不会进入本仓库);
- 其余凭据同理,均在 GUI 中配置。

## 插件清单

| 包 | 用途 |
|---|---|
| `@deepseek-ai/dsh-base` | 官方核心层(timer/llm/session/agent…) |
| `@deepseek-ai/dsh-web-app` | 官方 Web 应用层(code-runtime/storage…) |
| `dshmarket` | DSH 插件市场 |
| `@nanmicoder/dsh-agent-teams` | 多智能体团队协作 |
| `@anionex/dsh-vision-toolkit` | 视觉工具集(截图/OCR/元素定位) |
| `aegis` | Aegis 方法论 |
| `@linxin666/dsh-web-ui-all` | Web UI 插件全家桶(SSH/任务看板/桌面启动器等) |
| `@liustack/modsearch` | 网页/X 搜索桥 |
| `@snow-the/dsh-busyloop` | Agent-loop 引擎 + 自调用工具 `busyloop_run`(一次性任务走 ark/direct 通道,主模型 token 零消耗;0.1.7+ 已将 `@deepseek-ai/dsh-tools` peer 化,避免与宿主双实例导致工具调度器崩溃——安装务必同时加 dependencies + bundles,`pnpm install` 完成后再重启) |
| `@snow-the/dsh-gitkit` | Git 工具集 |
| `@snow-the/dsh-snapshot` | 配置快照备份 |
| `@snow-the/dsh-plugin-doctor` | 插件诊断 |
| `@snow-the/dsh-plugin-guide` | 插件合规扫描 + 能力导航(guide_scan / guide_learn) |
| `@snow-the/dsh-skill-pack` | 技能包 |
| `@openviking/dsh-memory-plugin` | OpenViking 长期记忆 |
| `@tt-a1i/archify-dsh` | 架构图生成 |
| `dsh-undo-savepoint` | 配置撤销/回滚快照 |
| `dsh-ark-plan` | Volcano Ark 计划 API 激活 |
| `@snow-the/dsh-session-handoff` | 会话交接与上下文管理(GH Packages) |
| `@linxin666/dsh-client-ui-skin-center` | 皮肤中心 |
| `@snow-the/dsh-lib-analyzer` | 库吸收分析 |
| `mcp-mslearn`(patch 插入) | Microsoft Learn 官方文档 MCP(免费,无需 key) |

## 升级

```bash
# 拉取新模板
git -C <dsh-setup目录> pull
# 重新部署:自动备份旧 profile → 复制 → 覆盖 → install → 冒烟测试
cd <dsh-setup目录> && .\setup.ps1   # Windows
cd <dsh-setup目录> && ./setup.sh    # Linux/macOS
```

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 冒烟测试出现 `[FAIL]` | bundle 未安装或缺少可加载入口。先重跑 `pnpm install`;git 依赖(`github:*`)需要能访问 GitHub;私有包需配置 npm token。 |
| `pnpm install` 提示忽略 build scripts | pnpm 10 默认禁止依赖的 postinstall 脚本,`profiles/web/pnpm-workspace.yaml` 已用 `allowBuilds` 白名单放行 `ssh2` / `node-pty` / `cpu-features` / `cloudflared`;以后新增带原生编译的依赖,记得同步加白名单。 |
| 安装报 `@deepseek-ai/dsh-agent` 无稳定版本 | 该 peer 依赖在 npmjs 只有 rc 版,模板已用 `pnpm.overrides` 固定为 `0.1.1-rc.2`,请勿删除。 |
| 部署后插件版本和预期不符 | `@snow-the/*` 系列已锁**精确版本**(无 `^`),升级需手动改版本号后重跑 setup(见"版本选择")。 |
| 脚本提示"本地与远端不一致" | 模板可能过期:先 `git pull`,再重跑部署脚本。 |
| git 依赖 clone 慢/失败 | 需要能访问 GitHub;可配置代理或改用 npm 镜像内的同版本。 |

## 版本选择

- **`@snow-the/*` 使用精确版本**:0.1.x 迭代频繁,`^0.1.x` 会在下次 `pnpm install` 时漂移到不兼容版本,故模板一律去掉 `^`;升级 = 在 `profiles/web/package.json` 中显式改版本号 → 重跑 setup(脚本会备份旧 profile,可随时回退)。
- **不提交 `pnpm-lock.yaml`**:各机器平台/Node 版本不同,首次 install 现场解析;因此每次部署都应重跑 `pnpm install` 以拾取新版本。
- 顶层 `package.json` 为信息副本,与 `profiles/web/package.json` 保持同步,改版本时两处一起改。

## 注意

- profile 目录中的 `node_modules/`、`.dsh-market/` 等由本机生成,不进入仓库;
- `pnpm-lock.yaml` 未纳入模板:各机器平台/Node 版本可能不同,首次 `pnpm install` 会现场解析;
- git 依赖(`github:snow-The/*`、`github:GanyuanRan/Aegis` 等)安装时需要能访问 GitHub。
