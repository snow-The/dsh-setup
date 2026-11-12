# 已迁移：profile 的生成与发布 → [snow-The/dsh-profile](https://github.com/snow-The/dsh-profile)

> **2026-11-12 起，本仓库不再是部署源。**
> 本仓库剩下的是宿主侧工作（体检、审计、启动验证）与历史。

## 为什么分家

原来这一个 repo 骑了两匹马：

| profile 编译器 | 宿主侧工作 |
|---|---|
| `plugins.intent.json` → `package.json` + `pnpm-workspace.yaml` | 部署、体检、审计、patch 复原 |
| 确定性的、可在 CI 里断言的 | 依赖本机状态，不适合当发布物 |

前者搬去 dsh-profile（小而稳：一条编译命令 + 8 条自洽检查 + 两组变异自检）；后者留在这里当工具。

**另外**：本仓库的 `profiles/web/plugins.intent.json` 停在 6666 世代（`@linxin666/*`）。
那个世代的包已于 2026-11-12 从 live profile 移除，但这份 intent 还在，并且
`derivedOverridesFrom` 仍指向 `@linxin666/dsh-web-all`。**不要再用它生成 live profile。**

## 怎么迁（新机器、旧机器同一套）

```powershell
# 1. 引擎（版本取 dsh-profile 里 profiles/web/plugins.intent.json 的 runtime 字段）
npx --yes @deepseek-ai/dsh@0.2.2-rc.1 --version

# 2. profile
git clone https://github.com/snow-The/dsh-profile
cd dsh-profile/profiles/web
pnpm install

# 3. 起（profile 名是位置参数）
dsh --profile web
```

要装到 `~/.dsh/profiles/web` 就先用编译器的 `--out` 生成一份，再 `pnpm install`：

```powershell
cd dsh-profile
node scripts/derive-profile.mjs --write --profile web --out "$env:USERPROFILE\.dsh\profiles\web"
cd "$env:USERPROFILE\.dsh\profiles\web"; pnpm install
```

`--out` 会把 `cordis.patch.yml` 一并同步过去（它不是推导物，但少了它整层装配都不在）。

## 升级 = 两件事，别只做一半

| 层 | 谁决定 | 怎么升 |
|---|---|---|
| **引擎** | intent 的 `runtime` 字段 | `npx --yes @deepseek-ai/dsh@<runtime>` |
| **profile** | intent 的 `github` / `npm` 段 | `git pull` → `derive --write --out <profile>` → `pnpm install` |

- **同世代内只换插件** → 只发 profile 就够了。
- **跨世代** → 两件都要做，且先引擎后 profile。

世代不对时，插件自己的 `peerDependencies` 会把它挡下来，报错通常只说某个 bundle 的 peer 不满足，
看起来像「插件坏了」，实际是引擎旧了一代。

> **完整的跨世代操作步骤（备份 → 装引擎 → 生成 profile → 装依赖 → 新端口试起 → 切换 → 验证 → 回滚 →
> 症状对照表）看 [UPGRADE.md](UPGRADE.md)。** 那份是自足的，不预设你读过 dsh-profile 的任何文件。

## 这里的东西还算数吗

| 还算数 | 已退役 |
|---|---|
| `audit-*.mjs`、`commit-integrity.mjs`、`patch-guard.mjs` | `profiles/web/plugins.intent.json`（6666 世代） |
| `boot-check.mjs`、`plugin-load-check.mjs`、`e2e-verify.mjs` | `scripts/derive-profile.mjs`（正本在 dsh-profile） |
| `host-doctor.mjs`、`host-map.mjs`、`host-range.mjs`、`preflight-host.mjs`、`upgrade-host.mjs` | `scripts/check-template*.mjs` |
| `setup.ps1` / `setup.sh`（见下） | `scripts/derive-profile.selftest.mjs` |

## setup.ps1 / setup.sh 现在是「退役闸门」

它们会把**本仓库 6666 世代**的 `profiles/web` 复制到 `~/.dsh/profiles/web`。所以默认拒绝运行：

```
$ .\setup.ps1
本脚本已退役(2026-11-12)。
  profile 的生成与发布已迁移到：https://github.com/snow-The/dsh-profile
  ...
```

确实要考古（复现旧世代、对比历史行为）时显式加 `-Legacy`：

```powershell
.\setup.ps1 -Legacy
./setup.sh --legacy
```

## 怎么验证迁对了

```powershell
cd dsh-profile
node scripts/derive-profile.mjs      # 生成物 == 意图推导结果
node scripts/check-profile.mjs       # 8 条：意图 / 产物 / 挂载 三者自洽
```

两条都绿，且 `dsh --version` 的世代与 `runtime` 一致，就是迁完了。
