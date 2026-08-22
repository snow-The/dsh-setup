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
└── profiles/
    └── web/             # dsh web profile 模板
        ├── package.json        # 插件依赖 + bundles 清单
        ├── cordis.patch.yml    # 用户 patch 层(mslearn MCP 等)
        ├── cordis.yml          # profile 根(空列表,勿改)
        └── pnpm-workspace.yaml # pnpm 配置
```

## 部署步骤

### 前置要求

- Node.js 18+ 与 [pnpm](https://pnpm.io/)(`npm i -g pnpm`)
- 全局安装 dsh CLI:`npm i -g @deepseek-ai/dsh`

### Windows 一键部署

```powershell
git clone https://github.com/snow-The/dsh-setup.git
cd dsh-setup
.\setup.ps1        # 备份旧 profile → 复制模板 → pnpm install
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
| `@snow-the/dsh-busyloop` | Agent-loop 引擎(宿主 LLM 适配 + 多轮循环 + 工具调度) |
| `@snow-the/dsh-busyloop-tools` | busyloop 桥接:agent 工具 `busyloop_run`(一次性任务走 ark/direct 通道,主模型 token 零消耗)+ `busyloop_health` |
| `@snow-the/dsh-gitkit` | Git 工具集 |
| `@snow-the/dsh-snapshot` | 配置快照备份 |
| `@snow-the/dsh-plugin-doctor` | 插件诊断 |
| `@snow-the/dsh-plugin-guide` | 插件合规扫描 + 能力导航(guide_scan / guide_learn) |
| `@snow-the/dsh-skill-pack` | 技能包 |
| `@openviking/dsh-memory-plugin` | OpenViking 长期记忆 |
| `@tt-a1i/archify-dsh` | 架构图生成 |
| `dsh-undo-savepoint` | 配置撤销/回滚快照 |
| `dsh-ark-plan` | Volcano Ark 计划 API 激活 |
| `dsh-session-handoff` | 会话交接与上下文管理 |
| `@linxin666/dsh-client-ui-skin-center` | 皮肤中心 |
| `@snow-the/dsh-lib-analyzer` | 库吸收分析 |
| `mcp-mslearn`(patch 插入) | Microsoft Learn 官方文档 MCP(免费,无需 key) |

## 升级

```bash
cd ~/.dsh/profiles/web
# 拉取新模板并合并
git -C <dsh-setup目录> pull
# 重新安装依赖以拾取新版本
pnpm install
```

## 注意

- profile 目录中的 `node_modules/`、`.dsh-market/` 等由本机生成,不进入仓库;
- `pnpm-lock.yaml` 未纳入模板:各机器平台/Node 版本可能不同,首次 `pnpm install` 会现场解析;
- git 依赖(`github:snow-The/*`、`github:GanyuanRan/Aegis` 等)安装时需要能访问 GitHub。
