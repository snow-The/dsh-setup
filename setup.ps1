# dsh-setup 一键部署脚本(Windows)
# 用法: git clone https://github.com/snow-The/dsh-setup.git; cd dsh-setup; .\setup.ps1
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== dsh-setup: 部署 web profile ===" -ForegroundColor Cyan

# 1. 定位 dsh home 与目标 profile 目录
$dshHome = Join-Path $env:USERPROFILE ".dsh"
$profileDir = Join-Path $dshHome "profiles\web"
$templateDir = Join-Path $PSScriptRoot "profiles\web"

if (-not (Test-Path $templateDir)) {
    Write-Host "找不到模板目录: $templateDir" -ForegroundColor Red
    exit 1
}

# 2. 备份已有 profile(如有)
if (Test-Path $profileDir) {
    $bak = "$profileDir.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Move-Item $profileDir $bak
    Write-Host "已备份旧 profile 到: $bak" -ForegroundColor Yellow
}

# 3. 复制模板
New-Item -ItemType Directory -Force -Path (Split-Path $profileDir) | Out-Null
Copy-Item -Recurse $templateDir $profileDir
Write-Host "已复制模板到: $profileDir" -ForegroundColor Green

# 4. 安装依赖
Write-Host ""
Write-Host "安装依赖(pnpm install)..."
Push-Location $profileDir
try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败(exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# 5. 完成提示
Write-Host ""
Write-Host "=== 部署完成! ===" -ForegroundColor Green
Write-Host "1. 启动:  dsh web"
Write-Host "2. 首次使用请在 GUI 设置中配置你的 API key / 凭据(本仓库不含任何 key)"
Write-Host "3. 需要远程主机时,在 GUI 的 SSH 插件页添加主机"
Write-Host ""
