# 跨世代升级 runbook — DSH 引擎 + profile

> 适用：**引擎世代变了**（例：`0.2.1-rc.5` → `0.2.2-rc.1`）。
> 同世代内只换插件不需要本文 —— 发 profile 就够（`git pull` + `pnpm install`）。
> 这份是**自足**的：不预设你读过 dsh-profile 的任何文件，照命令跑就行。

两条铁律先说：

1. **升级是两件事**：引擎（`npx @deepseek-ai/dsh@<版本>`）+ profile（插件清单）。只做一半的报错都长得像「插件坏了」。
2. **先别急着删**：旧的全局 dsh、旧的 profile 目录，留到新的一套跑通再清理。回滚是 30 秒的事，前提是它们还在。

---

## 0. 先判断你在哪一边

```powershell
dsh --version        # 或 npx --yes @deepseek-ai/dsh@<版本> --version
```

目标世代 = dsh-profile 里 `profiles/web/plugins.intent.json` 的 `runtime` 字段。
两边一致 → 你只需要发 profile，本文到此为止。不一致 → 往下走。

想互证现有 profile 要的是哪一代，随便挑一个插件看它的 peer 区间：

```powershell
node -e "const p=require(process.argv[1]); console.log(p.peerDependencies?.['@deepseek-ai/dsh'])" "$env:USERPROFILE\.dsh\profiles\web\node_modules\@snow-the\dsh-search\package.json"
```

看到什么算「跨世代」，分两类，别混着记（2026-11-12 实测）：

| 谁 | peer 写法 | 含义 |
|---|---|---|
| 自研插件（`@snow-the/*`） | `>=0.2.1-rc.5`（只给下限，无上限） | 引擎比下限旧 → 直接被挡 |
| 官方 bundle（`@deepseek-ai/dsh-*`） | `>=0.2.1-rc.2 <0.2.2-0 \|\| >=0.2.2-alpha.2 <0.2.3-0` | **分段**：0.2.1 与 0.2.2 不能混装 |

官方那类分段区间就是「跨世代」的物理原因：同一个 bundle 在两个世代各有一段可用区间，中间是断的。
报错通常只说「某个 bundle 的 peer 不满足」，一个字都不提版本。

## 1. 备份（60 秒，别省）

```powershell
$ts = Get-Date -Format yyyyMMdd-HHmm
Copy-Item "$env:USERPROFILE\.dsh\profiles\web" "$env:USERPROFILE\.dsh\profiles\web.bak-upgrade-$ts" -Recurse
```

```bash
cp -r ~/.dsh/profiles/web ~/.dsh/profiles/web.bak-upgrade-$(date +%Y%m%d-%H%M)
```

`node_modules` 很大时可以只备份配置文件（`package.json` / `pnpm-workspace.yaml` / `cordis.patch.yml` / `pnpm-lock.yaml`），
但要记着：**回滚后需要重新 `pnpm install`**。

`~/.dsh/.credentials.yaml`、`dsh-ssh.json` 这类机器私有状态**不在这套流程里**，不用动、也不该进备份目录。

## 2. 装目标世代引擎（钉死版本）

```powershell
npx --yes @deepseek-ai/dsh@0.2.2-rc.1 --version
```

- **不要用 `latest`**：官方 bundle 的 npm `latest` dist-tag 可能停在 alpha（`dsh-experimental-terminal-bundle` 的 latest 曾是 `0.2.1-alpha.2`，而引擎是 `0.2.2-rc.1`）。
- npx 会缓存到 `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh`，第二次起几乎瞬开。
- **全局那份也要一起升**（如果机器上有 `npm i -g @deepseek-ai/dsh`）：

```powershell
npm i -g @deepseek-ai/dsh@0.2.2-rc.1
```

不升的话，哪天手敲 `dsh web` 就会拿旧引擎配新 profile，卡在同一个 peer 门禁上，而且报错完全不提「版本」两个字。

## 3. 生成新 profile（用编译器，不要手改生成物）

```powershell
git clone https://github.com/snow-The/dsh-profile
cd dsh-profile
node scripts/derive-profile.mjs --write --profile web --out "$env:USERPROFILE\.dsh\profiles\web.new"
```

产物应该是**三件**：

```
package.json
pnpm-workspace.yaml
cordis.patch.yml
```

少了第三件 = patch 层缺失（authorization、权限预设、模型路由、主题全都不在）。症状是「插件好像都没挂上」，
但插件其实装好了 —— 2026-11-12 在笔电上就是这样，编译器的 `--out` 当时只写前两件，后来修了。

## 4. 装依赖（pnpm 世代的坑在这里）

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web.new"
pnpm install
```

两条会**静默**伤人的规则：

| 现象 | 原因 |
|---|---|
| 白名单看起来写了，build script 还是全被挡 | pnpm 10 用 `onlyBuiltDependencies`（字符串数组），pnpm 11 用 `allowBuilds`（map）。写错世代不报错，只是不生效 |
| `ERR_PNPM_PREPARE_PACKAGE … pnpm-install` | 那个 git 依赖带了 `prepare` 脚本。pnpm 对 git 依赖会先在临时目录 `pnpm install`，再跑 `prepare` —— 只有源码的目录里必失败。**修法在包那一侧（去掉 prepare），不是在本机重试** |

另外：Windows 上新版 npm 默认不跑 lifecycle scripts。`node-pty` 这类包**自带预编译二进制**（`prebuilds/win32-x64/`），
所以 `Ignored build scripts: node-pty` 的警告通常无害 —— 判据是终端能不能开，不是警告在不在。

## 5. 先在新端口试起（不碰现场）

```powershell
npx --yes @deepseek-ai/dsh@0.2.2-rc.1 --profile web.new --no-open --port 35999
```

三条判据，**都要**：

1. `35999` 处于 LISTENING
2. stderr 为空（`[dsh-search] provider registered OK` 这类 stdout 不算错）
3. `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:35999/` → **401**（有鉴权在，就说明服务是活的；200 反而可疑）

日志里这行就是可用网址：

```
dsh web: http://127.0.0.1:35999/?token=<每次启动都不同>
```

试完记得把测试进程停掉，别让它占着端口进下一步。

## 6. 切换

```powershell
# 停旧
Get-NetTCPConnection -LocalPort 3080 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 目录换手
cd "$env:USERPROFILE\.dsh\profiles"
Rename-Item web "web.bak-upgrade-<ts>"
Rename-Item web.new web
```

**怎么起常驻进程**（实测，Windows）：

- ❌ `start /b`：ssh / 终端一断，子进程跟着死。远程操作时会以为「起不来」，其实是起过又被带走了。
- ✅ 计划任务一次性拉起，起完就删：

```powershell
schtasks /Create /TN dsh-web /TR "cmd /c npx --yes @deepseek-ai/dsh@0.2.2-rc.1 web > %TEMP%\dsh-web.log 2>&1" /SC ONCE /ST 00:00 /F
schtasks /Run /TN dsh-web
schtasks /Delete /TN dsh-web /F
```

Linux / macOS：

```bash
nohup npx --yes @deepseek-ai/dsh@0.2.2-rc.1 web > ~/.dsh/web.log 2>&1 &
```

## 7. 验证

```powershell
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3080/     # 期望 401
Select-String -Path "$env:TEMP\dsh-web.log" -Pattern 'dsh web: '
```

拿日志里**新的** token 打开浏览器。旧标签页会 401 —— **token 每次启动都变，这不代表坏了**。
再进 GUI 看一眼插件面（面板、工具、皮肤），少哪一组就回头查 patch 层与 `dsh.profile.bundles` 的挂载关系。

## 8. 回滚（一直有退路）

```powershell
# 停掉新进程
Get-NetTCPConnection -LocalPort 3080 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
cd "$env:USERPROFILE\.dsh\profiles"
Rename-Item web "web.new-failed"
Rename-Item web.bak-upgrade-<ts> web
```

然后用**旧引擎**起：`npx --yes @deepseek-ai/dsh@<旧版本> web`。
旧全局安装没卸、旧目录没删 → 回滚就是这么短。

## 9. 症状 → 真正原因

| 症状 | 真正原因 |
|---|---|
| 启动就报某个 bundle 的 peer 不满足 | 引擎旧了一代，profile 已是新世代 |
| `ERR_PNPM_PREPARE_PACKAGE` | 某个 git 依赖带了 `prepare` |
| 装完启动说找不到入口 / `Cannot find module` | 发布的包没把构建产物入版控（`main` 指向被 `.gitignore` 挡掉的 `dist/`） |
| 插件都装了，但鉴权/模型路由/主题全空 | profile 目录少了 `cordis.patch.yml` |
| 浏览器 401 | token 换了，用日志里的新网址 |
| `Ignored build scripts: node-pty …` 但终端能用 | node-pty 有预编译二进制，不需要编译 |
| pnpm 白名单写了不生效 | pnpm 世代 ↔ 键名（`onlyBuiltDependencies` vs `allowBuilds`） |
| ssh 一断 DSH 就没了 | 用了 `start /b`；改用计划任务 / `nohup` |
| `pnpm` 命令报 `The system cannot execute the specified program` | 机器上有多个 pnpm 入口（WinGet Links / npm global）。可靠路径：`node "$env:APPDATA\npm\node_modules\pnpm\bin\pnpm.cjs" install` |

## 10. 升级后的一分钟检查清单

- [ ] `dsh --version` == intent 的 `runtime`
- [ ] profile 目录三件齐：`package.json` / `pnpm-workspace.yaml` / `cordis.patch.yml`
- [ ] `pnpm install` 输出里没有 `ERR_`
- [ ] 新端口试起的三条判据都过
- [ ] 切换后 `curl 3080` = 401，日志里有新 token URL
- [ ] 旧目录还在（`web.bak-upgrade-*`），确认没问题再删

---

## 附：这套流程是从两次实伤里长出来的

- **2026-11-12（笔电）**：`derive --out` 没带 `cordis.patch.yml`；`start /b` 起的进程随 ssh 断线消失；
  全局 dsh 还停在旧世代。三件事叠在一起，症状全是「起不来 / 起来了但空的」。
- **2026-11-12（发布）**：`dsh-search` 带 `prepare`、`dsh-plugin-guide` 的 `dist/` 被 `.gitignore` 挡住 ——
  本机因为有 pnpm store 的「已准备」副本和跑过 build，完全看不出问题；只有**空 store 的全新安装**才会暴露。
  所以第 4 步之后如果条件允许，用空 store 验证一次：`pnpm install --store-dir <临时目录>`。
