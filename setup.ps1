# dsh-setup 一键部署脚本(Windows PowerShell 5.1+ / pwsh 7+)
# 用法: git clone https://github.com/snow-The/dsh-setup.git; cd dsh-setup; .\setup.ps1
# 流程: 预检(远端同步) → 备份旧 profile → 复制模板 → 应用 web.local 覆盖 → pnpm install → 冒烟测试
# 参数: -SkipInstall 跳过 pnpm install; -SkipSmoke 跳过冒烟测试; -Force 跳过"远端不同步"确认
param(
    [switch]$SkipInstall,
    [switch]$SkipSmoke,
    [switch]$Force
)
$ErrorActionPreference = "Stop"

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

# ---------- 1. 预检: 仓库是否最新 ----------
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
if (Test-Path $profileDir) {
    $bak = "$profileDir.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Move-Item $profileDir $bak
    Write-Host "已备份旧 profile 到: $bak" -ForegroundColor Yellow
}

# ---------- 3. 复制模板 ----------
New-Item -ItemType Directory -Force -Path (Split-Path $profileDir) | Out-Null
Copy-Item -Recurse $templateDir $profileDir
Write-Host "已复制模板到: $profileDir" -ForegroundColor Green

# ---------- 4. 应用站点覆盖 profiles/web.local/ ----------
if (Test-Path $overlayDir) {
    Write-Host "应用站点覆盖: $overlayDir -> $profileDir"
    Copy-Item -Recurse -Force (Join-Path $overlayDir "*") $profileDir
    Write-Host "站点覆盖完成。" -ForegroundColor Green
} else {
    Write-Host "未发现 profiles/web.local/,跳过站点覆盖。" -ForegroundColor DarkGray
}

# ---------- 5. 安装依赖 ----------
if (-not $SkipInstall) {
    Write-Host ""
    Write-Host "安装依赖(pnpm install)..."
    Push-Location $profileDir
    try {
        pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败(exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

# ---------- 6. 冒烟测试: bundles 可加载性 ----------
if (-not $SkipSmoke) {
    Write-Host ""
    Write-Host "==> 冒烟测试: 校验 bundles 入口" -ForegroundColor Cyan
    $pkg = Get-Content -Raw (Join-Path $profileDir "package.json") | ConvertFrom-Json
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
        $bp = Get-Content -Raw $bpJson | ConvertFrom-Json
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

# ---------- 7. 完成提示 ----------
Write-Host ""
Write-Host "=== 部署完成! ===" -ForegroundColor Green
Write-Host "1. 启动:  dsh web"
Write-Host "2. 首次使用请在 GUI 设置中配置你的 API key / 凭据(本仓库不含任何 key)"
Write-Host "3. 需要远程主机时,在 GUI 的 SSH 插件页添加主机"
Write-Host ""
