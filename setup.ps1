# dsh-setup 一键部署脚本(Windows PowerShell 5.1+ / pwsh 7+)
# 用法: git clone https://github.com/snow-The/dsh-setup.git; cd dsh-setup; .\setup.ps1
# 流程: 模板自检 → 预检(远端同步) → 备份旧 profile → 复制模板 → 应用 web.local 覆盖 → 安装依赖(含宿主兼容性判定) → 冒烟测试
# 参数: -SkipInstall 跳过安装; -SkipSmoke 跳过冒烟测试; -Force 跳过"远端不同步"/"模板自检失败"的确认
param(
    [switch]$SkipInstall,
    [switch]$SkipSmoke,
    [switch]$Force
)
$ErrorActionPreference = "Stop"

# 按 UTF-8 读取并解析 JSON —— 不要用裸 Get-Content。
#
# 理由: Windows PowerShell 5.1 的 Get-Content 对一个【没有 BOM】的文件按系统 ANSI 码页解码。
# 第三方包的 package.json 大多是 UTF-8 无 BOM,只要里面有一个中文字符串(例如 dshmarket 的
# 描述写着"可视化插件市场"),PS 5.1 就会读成乱码,而乱码里出现的引号会打断 JSON,
# 于是 ConvertFrom-Json 直接抛 ArgumentException —— 冒烟测试整个崩掉。
#
# 注意: pwsh 7 默认就是 UTF-8,所以这个坑在开发机上永远看不到,只有新机器会踩。
# 这与 setup.ps1 自身需要 UTF-8 BOM 是同一个根因的两面。
function Read-Json([string]$Path) {
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    return $text | ConvertFrom-Json
}

Write-Host ""
Write-Host "=== dsh-setup: 部署 web profile ===" -ForegroundColor Cyan

# ---------- 0. 定位目录 ----------
$repoDir = $PSScriptRoot
$dshHome = Join-Path $env:USERPROFILE ".dsh"
$profileDir = Join-Path $dshHome "profiles\web"
$templateDir = Join-Path $repoDir "profiles\web"
$overlayDir = Join-Path $repoDir "profiles\web.local"

if (-not (Test-Path $templateDir)) {
    Write-Host "找不到模板目录: $templateDir" -ForegroundColor Red
    exit 1
}

# ---------- 1. 模板自检: 清单/白名单/patch 是否自洽 ----------
# 放在最前面: 模板腐化比安装失败更隐蔽 —— 装出一个"少了一半插件"的 profile 不会报错。
Write-Host ""
Write-Host "==> 模板自检" -ForegroundColor Cyan
$checker = Join-Path $repoDir "scripts\check-template.mjs"
if (Test-Path $checker) {
    node $checker
    if ($LASTEXITCODE -ne 0) {
        Write-Host "模板自检失败,见上方 ✗ 列表。修好再部署。" -ForegroundColor Red
        if (-not $Force) { exit 1 }
        Write-Host "(-Force: 继续)" -ForegroundColor Yellow
    }
} else {
    Write-Host "未找到 scripts\check-template.mjs,跳过模板自检。" -ForegroundColor DarkGray
}

# ---------- 1.5 预检: 宿主世代认不认这份 profile ----------
# 2026-10-28 实伤: profile 已经装到要 >=0.2.1-rc.2 的一代, 而全局 dsh 还停在 0.2.0-rc.2。
# 宿主不报错, 只在启动时**静默跳过整包**:
#   dsh: skipping profile bundle "@linxin666/dsh-web-all": peerDependencies {...}
# 表现是「GUI 坏了一半」(Web UI 全家桶、会话归档全没), 而部署脚本全程绿灯。
# 所以部署前先问一句「这一代认不认」, 不认就停下并给出确切命令。
Write-Host ""
Write-Host "==> 预检: 宿主世代" -ForegroundColor Cyan
$preflight = Join-Path $repoDir "scripts\preflight-host.mjs"
if (Test-Path $preflight) {
    $pfArgs = @()
    if (Test-Path $profileDir) { $pfArgs += @('--profile-dir', $profileDir) }
    node $preflight @pfArgs
    if ($LASTEXITCODE -ne 0) {
        # 光拦下来不算修好: 建议不做的事等于没做。就地升级宿主, 再验一次。
        Write-Host ""
        Write-Host "宿主与这份 profile 不同代, 尝试就地升级宿主..." -ForegroundColor Yellow
        $upgrader = Join-Path $repoDir "scripts\upgrade-host.mjs"
        if (Test-Path $upgrader) {
            node $upgrader
            $upRc = $LASTEXITCODE
            if ($upRc -eq 0) {
                node $preflight @pfArgs
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "升级后预检仍不通过, 见上方列表。" -ForegroundColor Red
                    if (-not $Force) { exit 1 }
                }
            } elseif ($upRc -eq 3) {
                Write-Host "宿主正开着 —— npm 替换全局树会 EBUSY。请先关掉 DSH, 再重跑本脚本。" -ForegroundColor Red
                if (-not $Force) { exit 1 }
            } else {
                Write-Host "宿主升级失败, 见上方 npm 输出。处理完重跑本脚本。" -ForegroundColor Red
                if (-not $Force) { exit 1 }
            }
        } else {
            Write-Host "未找到 scripts\upgrade-host.mjs, 无法自动升级。" -ForegroundColor Red
            if (-not $Force) { exit 1 }
        }
        Write-Host "(-Force: 继续部署; 启动时那些 bundle 仍会被门禁跳过)" -ForegroundColor Yellow
    }
} else {
    Write-Host "未找到 scripts\preflight-host.mjs,跳过宿主世代预检。" -ForegroundColor DarkGray
}

# ---------- 2. 预检: 仓库是否最新 ----------
Write-Host ""
Write-Host "==> 预检: 仓库同步状态" -ForegroundColor Cyan
$dirty = git -C $repoDir status --porcelain
if ($dirty) {
    Write-Host "注意: 工作区有未提交改动(共 $($dirty.Count) 项),将基于当前本地文件部署。" -ForegroundColor Yellow
}
git -C $repoDir fetch --quiet origin 2>$null
$localHead = git -C $repoDir rev-parse HEAD
$remoteHead = git -C $repoDir rev-parse "@{u}" 2>$null
if ($LASTEXITCODE -eq 0 -and $remoteHead -ne $localHead) {
    Write-Host ""
    Write-Host "!! 本地 HEAD ($($localHead.Substring(0,7))) 与远端 ($($remoteHead.Substring(0,7))) 不一致,模板可能过期。" -ForegroundColor Red
    Write-Host "!! 建议先执行 git pull 再部署。" -ForegroundColor Red
    if (-not $Force) {
        $ans = Read-Host "仍要继续部署吗? [y/N]"
        if ($ans -notmatch "^[yY]") { Write-Host "已取消。" -ForegroundColor Yellow; exit 1 }
    }
}

# ---------- 2. 备份已有 profile(如有) ----------
$bak = $null
if (Test-Path $profileDir) {
    $bak = "$profileDir.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Move-Item $profileDir $bak
    Write-Host "已备份旧 profile 到: $bak" -ForegroundColor Yellow
}

# ---------- 3. 复制模板 ----------
New-Item -ItemType Directory -Force -Path (Split-Path $profileDir) | Out-Null
Copy-Item -Recurse $templateDir $profileDir
Write-Host "已复制模板到: $profileDir" -ForegroundColor Green

# ---------- 3.5 保留既有部署的 patch 层 ----------
# 升级已有部署时，第 2 步把整个旧 profile 挪进 .bak，第 3 步复制的是模板 —— 模板的 patch
# 层是空 `[]`，于是新 profile 一个本机配置都没有（模型路由、权限预设、搜索后端、皮肤…）：
# 起得来，但等于一台没调过的机器。而"直接改部署目录里的 cordis.patch.yml"是操作者最自然
# 的做法，本项目文档此前也一直这么写。
# 所以：模板的 patch 层是"干净"的（去掉注释后只剩 []）时，把旧层接过来；模板自带条目说明
# 这一代模板有意发布配置，那时以模板为准，旧层只留在 .bak 里。
if ($bak -and (Test-Path (Join-Path $bak "cordis.patch.yml"))) {
    $newPatchPath = Join-Path $profileDir "cordis.patch.yml"
    $pristine = $true
    if (Test-Path $newPatchPath) {
        # 不能裸用 Get-Content：PS 5.1 按 ANSI 码页解码，无 BOM 的 UTF-8 会乱码。
        $txt = [System.IO.File]::ReadAllText($newPatchPath, [System.Text.Encoding]::UTF8)
        $stripped = (($txt -split "`r?`n") -replace '#.*$', '') -join ''
        $stripped = $stripped -replace '\s', ''
        if ($stripped -ne '[]') { $pristine = $false }
    }
    if ($pristine) {
        Copy-Item (Join-Path $bak "cordis.patch.yml") $newPatchPath -Force
        $keptBytes = (Get-Item $newPatchPath).Length
        Write-Host "已保留旧 patch 层: $keptBytes 字节（来自 .bak）" -ForegroundColor Yellow
        Write-Host "  · 它是按上一代宿主调的。启动失败就对照 .bak 收窄，或把本机专属配置搬进 profiles/web.local/。" -ForegroundColor Yellow
    } else {
        Write-Host "模板自带 patch 条目，按模板走；旧层保留在 .bak" -ForegroundColor DarkGray
    }
}

# ---------- 4. 应用站点覆盖 profiles/web.local/ ----------
if (Test-Path $overlayDir) {
    Write-Host "应用站点覆盖: $overlayDir -> $profileDir"
    Copy-Item -Recurse -Force (Join-Path $overlayDir "*") $profileDir
    Write-Host "站点覆盖完成。" -ForegroundColor Green
} else {
    Write-Host "未发现 profiles/web.local/,跳过站点覆盖。" -ForegroundColor DarkGray
}

# ---------- 4.5 保留操作者自己加的依赖(升级不丢插件) ----------
# 实现在 scripts\carry-over-deps.mjs, 与 setup.sh 共用一份 —— PowerShell 里手写 JSON
# 合并太脆(PSObject 的键名含斜杠、类型丢失), 不值得。
if ($bak -and (Test-Path (Join-Path $bak "package.json")) -and (Test-Path (Join-Path $profileDir "package.json"))) {
    $carry = Join-Path $repoDir "scripts\carry-over-deps.mjs"
    if (Test-Path $carry) {
        $carryOut = node $carry $bak $profileDir 2>&1
        $kept = 0
        foreach ($line in @($carryOut)) {
            $text = "$line"
            if ($text -match '^carried: (.+)$') {
                Write-Host "  已保留(模板里没有): $($matches[1])" -ForegroundColor Yellow
                $kept++
            } elseif ($text -notmatch '^carried: none$') {
                Write-Host "  $text" -ForegroundColor DarkYellow
            }
        }
        if ($kept -eq 0) { Write-Host "操作者没有额外依赖需要保留。" -ForegroundColor DarkGray }
        else { Write-Host "  · 装不上会在第 6 步冒烟测试里暴露。" -ForegroundColor Yellow }
    }
}

# ---------- 4.6 确保 .npmrc 在 ----------
# 只在 pnpm-workspace.yaml 里写 autoInstallPeers:false 不够 —— 那条要 pnpm 以
# workspace 模式读到该文件才生效; 用户级配置或从别的 cwd 发起安装都会绕过它。
# 项目级 .npmrc 不需要 workspace 模式, 且优先级高于用户级配置。
$npmrcPath = Join-Path $profileDir ".npmrc"
if (-not (Test-Path $npmrcPath)) {
    $npmrcBody = "auto-install-peers=false`nstrict-peer-dependencies=false`n"
    [System.IO.File]::WriteAllText($npmrcPath, $npmrcBody, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已补 .npmrc(关掉 peer 自动安装)。" -ForegroundColor Yellow
}

# ---------- 5. 安装依赖 ----------
# 优先走 `dsh plugin --profile web <pnpm 参数>`: 它是 pnpm 的透传包装, 但会额外跑宿主自己的
# 兼容性判定, 并把"哪个插件因 peer 范围不满足会被禁用"连同补救命令一起打出来。
# 裸 pnpm install 不会做这件事 —— 而那正是插件静默不加载的来源。
if (-not $SkipInstall) {
    Write-Host ""
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($dshCmd) {
        Write-Host "安装依赖(dsh plugin --profile web install,含宿主兼容性判定)..."
        Push-Location $profileDir
        try {
            dsh plugin --profile web install
            if ($LASTEXITCODE -ne 0) {
                throw "dsh plugin install 失败(exit $LASTEXITCODE)。常见原因: git 依赖的 allowBuilds 缺条目(见上方 pnpm 提示),或需能访问 GitHub。"
            }
        } finally {
            Pop-Location
        }
    } else {
        Write-Host "未找到 dsh CLI,退回裸 pnpm install(不会做兼容性判定)。" -ForegroundColor Yellow
        Write-Host "建议: npm i -g @deepseek-ai/dsh 后重跑本脚本。" -ForegroundColor Yellow
        Push-Location $profileDir
        try {
            pnpm install
            if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败(exit $LASTEXITCODE)" }
        } finally {
            Pop-Location
        }
    }
}

# ---------- 6. 冒烟测试: bundles 可加载性 ----------
if (-not $SkipSmoke) {
    Write-Host ""
    Write-Host "==> 冒烟测试: 校验 bundles 入口" -ForegroundColor Cyan
    $pkg = Read-Json (Join-Path $profileDir "package.json")
    if (-not $pkg.dsh -or -not $pkg.dsh.profile -or -not $pkg.dsh.profile.bundles) {
        Write-Host "package.json 缺少 dsh.profile.bundles,冒烟测试无法执行。" -ForegroundColor Red
        exit 1
    }
    $failures = @()
    foreach ($b in @($pkg.dsh.profile.bundles)) {
        if ($b -like "@deepseek-ai/*") { continue }   # 官方层由 dsh 宿主提供,不在 node_modules
        $pkgDir = Join-Path $profileDir "node_modules\$b"
        $bpJson = Join-Path $pkgDir "package.json"
        if (-not (Test-Path $bpJson)) {
            $failures += "$b (未安装)"
            continue
        }
        $bp = Read-Json $bpJson
        $main = if ($bp.main) { $bp.main } else { "index.js" }
        $entry = Join-Path $pkgDir $main
        $fallback = Join-Path $pkgDir "dist\index.js"
        if (-not (Test-Path $entry) -and -not (Test-Path $fallback)) {
            $failures += "$b (缺少入口: $main)"
        }
    }
    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "冒烟测试失败,以下 bundle 缺少可加载入口:" -ForegroundColor Red
        foreach ($f in $failures) { Write-Host "  [FAIL] $f" -ForegroundColor Red }
        Write-Host "处理: 重跑 .\setup.ps1 或在 profile 目录执行 pnpm install;git 依赖需能访问 GitHub。" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "冒烟测试通过: 所有 bundle 入口就位。" -ForegroundColor Green
}

# ---------- 7. 装配验证: 让宿主真的解析一遍 profile ----------
# 第 6 步只证明"入口文件在磁盘上"。它抓不到: patch 行引用了没装的插件、重复声明、
# 或者宿主在组合配置时发出的任何警告。
#
# 这不是理论问题: 2026-10-12 加的一行 MCP 配置写成了 `- id:` 而不是 `- insert:` 包裹,
# 于是它【整整一周都没有挂载过】, 而磁盘检查完全看不出来 —— 直到对 dump-config 的
# stderr 做了一次断言才抓到。
#
# 判据: `dsh --profile web --dump-config` 的退出码为 0, 且 **stderr 必须完全为空**。
# 已知的良性输出是启动阶段的 MCP 横幅, 它不出现在 dump-config 里;
# 如果某个插件在解析阶段往 stderr 打东西, 那本身就该被看见。
if (-not $SkipSmoke) {
    Write-Host ""
    Write-Host "==> 装配验证: dsh --profile web --dump-config (要求 stderr 为空)" -ForegroundColor Cyan
    $dshSolver = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $dshSolver) {
        Write-Host "未找到 dsh CLI,跳过装配验证(-SkipSmoke 以外的部分已完成)。" -ForegroundColor Yellow
        Write-Host "建议: npm i -g @deepseek-ai/dsh 后重跑本脚本。" -ForegroundColor Yellow
    } else {
        $errLines = New-Object System.Collections.ArrayList
        $dumpLines = & dsh --profile web --dump-config 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                [void]$errLines.Add($_.ToString())
                return
            }
            $_
        }
        $dumpCode = $LASTEXITCODE
        $idCount = @($dumpLines | Where-Object { $_ -match '^\s*-\s*id:' }).Count

        if ($dumpCode -ne 0) {
            Write-Host "装配验证失败: dsh --dump-config 退出码 $dumpCode" -ForegroundColor Red
            exit 1
        }
        if ($errLines.Count -gt 0) {
            Write-Host ""
            Write-Host "装配验证失败: 宿主在解析 profile 时报了 $($errLines.Count) 条 stderr 输出:" -ForegroundColor Red
            foreach ($l in ($errLines | Select-Object -First 20)) { Write-Host "  [STDERR] $l" -ForegroundColor Red }
            Write-Host ""
            Write-Host "常见原因:" -ForegroundColor Yellow
            Write-Host "  · cordis.patch.yml 里有一行的 id 没有任何声明 —— 要【新建】条目必须用 - insert: 包裹," -ForegroundColor Yellow
            Write-Host "    裸的 '- id: x' 只能配置已存在的条目(2026-10 就是这样让一行 MCP 一周没生效)。" -ForegroundColor Yellow
            Write-Host "  · patch 引用的插件没有装进 profile。" -ForegroundColor Yellow
            Write-Host "上面的 stderr 会指出具体是哪一条。" -ForegroundColor Yellow
            exit 1
        }
        if ($idCount -eq 0) {
            Write-Host "装配验证失败: dump-config 成功但解析出 0 个 loader 条目 —— 这不是正常状态。" -ForegroundColor Red
            exit 1
        }
        Write-Host "装配验证通过: 宿主解析出 $idCount 个 loader 条目, stderr 为空。" -ForegroundColor Green
    }
}

# ---------- 8. 宿主解析层 + 四条审计轴 ----------
# 先补一层 $dshHome\profiles\node_modules 指向宿主的 node_modules。
#
# 为什么需要它: 插件的 `import '@deepseek-ai/dsh-tools'` 走 Node 的常规向上查找,
# 而 profile 自己的 node_modules 里【没有】宿主包 —— 它们是 peer, 而本 profile 设了
# autoInstallPeers:false。缺这一层时, 干净机器上的表现是「装得上、解析不到」。
# 2026-10-19 在隔离 home 里实测: 4 个插件 `@deepseek-ai/dsh-tools 解析不到`,
# 补上这层后立刻变成 硬伤 0 / 不可判定 0 / 合规 16。
#
# 已有这一层就【不碰】: 它可能是有人刻意做的共享 farm。
#
# 之后才跑四条审计轴, 因为:
#   · 插件和宿主不是同一代 —— 0.1.5 的包配 0.2.1 的宿主, 因为 API 面结构性兼容,
#     全绿, 而且可以绿很久(2026-10-19 实测: 全绿了一整代)。
#   · 依赖装不回来 (版本被撤、github 源没了)。
#   · 日志前缀不一致 —— 出事时 grep 一个名字搜不全, 不知道是谁在说话。
# 四条轴都只在**真问题**上退出 1, 不对建议性提醒失败, 所以可以直接当门禁。
if (-not $SkipSmoke) {
    Write-Host ""

    # 宿主 node_modules: 先从 `dsh` 可执行文件往上爬。每一层试三种布局:
    #   <d>/@deepseek-ai/dsh-tools                (共享 node_modules)
    #   <d>/node_modules/@deepseek-ai/dsh-tools   (普通安装)
    #   <d>/@deepseek-ai/dsh/node_modules/...     (npm -g 的嵌套布局)
    # 这一条能覆盖 npm -g / 私有 prefix / pnpm / npx, 比猜固定位置可靠。
    function Find-HostNodeModules([string]$Start) {
        $d = $Start
        for ($i = 0; $i -lt 6 -and $d; $i++) {
            if (Test-Path (Join-Path $d "@deepseek-ai\dsh-tools\package.json")) { return $d }
            $inner = Join-Path $d "node_modules"
            if (Test-Path (Join-Path $inner "@deepseek-ai\dsh-tools\package.json")) { return $inner }
            $nested = Join-Path $d "@deepseek-ai\dsh\node_modules"
            if (Test-Path (Join-Path $nested "@deepseek-ai\dsh-tools\package.json")) { return $nested }
            $parent = Split-Path $d -Parent
            if (-not $parent -or $parent -eq $d) { break }
            $d = $parent
        }
        return $null
    }

    $dshForAudit = Get-Command dsh -ErrorAction SilentlyContinue
    $hostNm = $null
    if ($dshForAudit) { $hostNm = Find-HostNodeModules (Split-Path $dshForAudit.Source -Parent) }
    if (-not $hostNm) {
        $hostCands = @()
        if ($env:APPDATA) { $hostCands += (Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh\node_modules") }
        if ($env:ProgramFiles) { $hostCands += (Join-Path $env:ProgramFiles "nodejs\node_modules\@deepseek-ai\dsh\node_modules") }
        foreach ($c in $hostCands) {
            if (Test-Path (Join-Path $c "@deepseek-ai\dsh-tools\package.json")) { $hostNm = $c; break }
        }
    }

    $resolveLayer = Join-Path $dshHome "profiles\node_modules"
    if (-not $hostNm) {
        Write-Host "找不到全局宿主的 node_modules —— 宿主解析层无法建立,'同代'那条轴会被跳过。" -ForegroundColor DarkGray
    } elseif (Test-Path $resolveLayer) {
        Write-Host "宿主解析层已存在,不覆盖: $resolveLayer" -ForegroundColor DarkGray
    } else {
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path $resolveLayer) | Out-Null
            New-Item -ItemType Junction -Path $resolveLayer -Target $hostNm | Out-Null
            if (Test-Path (Join-Path $resolveLayer "@deepseek-ai\dsh-tools\package.json")) {
                Write-Host "已建立宿主解析层: $resolveLayer -> $hostNm" -ForegroundColor Green
            } else {
                Write-Host "宿主解析层已建立但解析仍失败: $resolveLayer" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "宿主解析层建立失败: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "  这不阻止部署, 但插件的 @deepseek-ai/* 会解析不到。手建: New-Item -ItemType Junction -Path '$resolveLayer' -Target '$hostNm'" -ForegroundColor Yellow
        }
    }

    Write-Host ""
    Write-Host "==> 审计: 依赖 / 同代 / 运行时 / 日志" -ForegroundColor Cyan
    $auditArgs = @((Join-Path $repoDir "scripts\audit-all.mjs"), "--profile-dir", $profileDir)
    if ($hostNm) { $auditArgs += @("--host", $hostNm) }

    & node @auditArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "审计失败: 上面失败的轴就是原因, 各轴输出里带 file:line。" -ForegroundColor Red
        exit 1
    }
}

# ---------- 9. 完成提示 ----------
Write-Host ""
Write-Host "=== 部署完成! ===" -ForegroundColor Green
Write-Host "1. 启动:  dsh web"
Write-Host "2. 首次使用请在 GUI 设置中配置你的 API key / 凭据(本仓库不含任何 key)"
Write-Host "3. 需要远程主机时,在 GUI 的 SSH 插件页添加主机"
Write-Host "4. 装配验证: pnpm boot:check  —— 真启动一次,确认装配/服务/无报错"
Write-Host "   (第 7 步的 dump-config 只组合 YAML,看不到模块解析失败;这一步才看得到)"
Write-Host ""
