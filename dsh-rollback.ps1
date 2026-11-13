<#
.SYNOPSIS
  DSH 配置快照／回滚（纯 PowerShell，不需要 Node）。

.DESCRIPTION
  为什么要有这个：

  dsh-undo-savepoint 是一个 DSH 插件 —— 它靠 Node 进程活着。而它最该救命的场合
  恰好是「Node 起不来 / 插件把启动搞崩 / pnpm 把 node_modules 搅烂」。那种时候
  DSH 根本没启动，插件代码一行都不会执行。所以「一键回滚」不能依赖被回滚的那个
  运行时，只能依赖操作系统自带的东西：PowerShell + Compress-Archive。

  设计约束（都是踩过的坑）：

  1. 只用 cmdlet（Compress-Archive / Expand-Archive / Get-FileHash），不用 .NET
     静态调用 —— 沙箱只读模式下是 ConstrainedLanguage，[System.IO.*] 会直接失败。
  2. 只收「能让 DSH 起不来」的那些文件：profile 清单、patch、settings、ssh 主机表、
     自己写的插件代码。session 日志／memory 库／node_modules 一律不进 —— 它们体积大
     且不是启动失败的原因，把它们塞进快照只会让回滚变慢、让 zip 变成第二个真相源。
  3. 恢复前先自动拍一张 pre-restore，并且**不清空**目标目录：只覆盖快照里有的文件。
     「恢复」永远不该顺手删掉别的文件 —— 删掉的配置找不回来，覆盖掉的还能再覆盖。
  4. 快照里写 manifest.json（每个文件的 sha256）。这样「我恢复的到底是哪一版」是
     可验证的，而不是凭文件名里的时间戳相信它。
  5. -IncludeSecrets 默认关。.credentials.yaml 是明文密钥，快照目录不是保险箱。
     真要连密钥一起备份，显式加这个开关，并且知道自己在做什么。

.EXAMPLE
  # 改配置前拍一张（手动，永不自动清理）
  .\dsh-rollback.ps1 -Action snapshot -Note "before rc.3 cutover"

  # 看有哪些快照、哪一张被标记为 last-good
  .\dsh-rollback.ps1 -Action list

  # 启动成功后标记当前快照为「已知可用」
  .\dsh-rollback.ps1 -Action mark

  # 出事时回到指定快照（自动先拍 pre-restore）
  .\dsh-rollback.ps1 -Action restore -Name 20261114T040000Z-before-rc3.zip

  # 只看「现在和 last-good 差在哪」，不动任何文件
  .\dsh-rollback.ps1 -Action verify

  # 把快照解到别处做演练（不碰真实 ~/.dsh）
  .\dsh-rollback.ps1 -Action restore -Name x.zip -TargetRoot C:\temp\drill
#>
[CmdletBinding()]
param(
  [ValidateSet('snapshot', 'list', 'restore', 'mark', 'verify')]
  [string]$Action = 'list',

  [string]$Name,
  [string]$Note = '',
  [int]$Keep = 10,

  # 默认 ~/.dsh；演练时指向临时目录
  [string]$TargetRoot = (Join-Path $env:USERPROFILE '.dsh'),

  # 快照存放处；默认 ~/dsh-backups
  [string]$BackupRoot = (Join-Path $env:USERPROFILE 'dsh-backups'),

  # 演练：不拍 pre-restore、不写 last-restore.json。
  # 三态：不给（$null）= 目标根不是真实 ~/.dsh 就自动演练；-Drill = 强制演练；
  # -Drill:$false = 强制真实流程（拿来在临时目录里测 pre-restore 那条分支）。
  [Nullable[bool]]$Drill = $null,

  [switch]$IncludeSecrets
)

$ErrorActionPreference = 'Stop'

# 能影响「DSH 能不能启动 / 行为对不对」的文件。相对 TargetRoot。
# 注意：本机当前没有 $HOME\.dsh\settings.yaml（ACP 等阈值走默认值），这条留着 ——
# 一旦哪天 settings.yaml 出现，它必须进快照，否则回滚会悄悄丢掉配置。
$Patterns = @(
  'settings.yaml'
  'ssh\hosts.json'
  'automation\jobs.json'
  'session-bus\wake-policy.json'
  'profiles\*\package.json'
  'profiles\*\cordis.patch.yml'
  'profiles\*\cordis.yml'
  'profiles\*\pnpm-workspace.yaml'
  'plugins\*.mjs'
  'plugins\*.js'
  'plugins\*.json'
)
if ($IncludeSecrets) { $Patterns += '.credentials.yaml' }

# profile 目录里堆着 history 备份（*.bak-*、*.truncated-*、*.stub-*）。
# 把它们一起快照只会让「当前配置」淹没在 20 个历史版本里。
$Junk = @('*.bak', '*.bak-*', '*.bak.*', '*.orig', '*.stub-*', '*.truncated*', '*.imported')

function Get-ScopeFiles {
  param([string]$Root)
  $out = @()
  foreach ($p in $Patterns) {
    $full = Join-Path $Root $p
    $hits = Get-ChildItem -Path $full -File -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
      $skip = $false
      foreach ($j in $Junk) { if ($h.Name -like $j) { $skip = $true; break } }
      if ($skip) { continue }
      # 相对路径统一成 a\b\c（Windows 风格），manifest 里可读、可复现
      $rel = $h.FullName.Substring($Root.Length).TrimStart('\', '/')
      $out += [pscustomobject]@{ Rel = $rel; Full = $h.FullName; Bytes = $h.Length; Sha = (Get-FileHash $h.FullName -Algorithm SHA256).Hash }
    }
  }
  return @($out | Sort-Object Rel -Unique)
}

function New-Snapshot {
  param([string]$SnapNote = $Note)
  if (-not (Test-Path $TargetRoot)) { throw "目标根目录不存在: $TargetRoot" }
  $files = Get-ScopeFiles -Root $TargetRoot
  if ($files.Count -eq 0) { throw "在 $TargetRoot 下没找到任何可快照的文件（-TargetRoot 指错了？）" }

  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $slug = ($SnapNote -replace '[^\w\u4e00-\u9fff]+', '-').Trim('-')
  if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40) }
  $leaf = if ($slug) { "$stamp-$slug" } else { $stamp }
  $zip = Join-Path $BackupRoot "$leaf.zip"

  # 先落到 staging，再整目录压缩 —— 直接压一堆散文件会丢目录结构，
  # 恢复时 profiles\web\package.json 会变成根目录下的 package.json。
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("dshsnap-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  try {
    foreach ($f in $files) {
      $dst = Join-Path $stage $f.Rel
      New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
      Copy-Item $f.Full $dst -Force
    }
    $manifest = [ordered]@{
      schema  = 1
      created = (Get-Date).ToUniversalTime().ToString('o')
      host    = $env:COMPUTERNAME
      root    = $TargetRoot
      note    = $SnapNote
      secrets = [bool]$IncludeSecrets
      files   = @($files | ForEach-Object { [ordered]@{ path = $_.Rel; bytes = $_.Bytes; sha256 = $_.Sha } })
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $stage 'manifest.json') -Encoding UTF8
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  } finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  }

  # 保留策略：只清归档文件，保留目录里的其他东西（人可能放了笔记）
  $all = @(Get-ChildItem $BackupRoot -Filter '*.zip' -File | Sort-Object LastWriteTime -Descending)
  if ($all.Count -gt $Keep) {
    $all | Select-Object -Skip $Keep | ForEach-Object {
      Remove-Item $_.FullName -Force
      Write-Host "  清理旧快照: $($_.Name)"
    }
  }

  [pscustomobject]@{
    action = 'snapshot'
    zip    = $zip
    files  = $files.Count
    bytes  = ($files | Measure-Object Bytes -Sum).Sum
    note   = $SnapNote
  }
}

function Get-Manifest {
  param([string]$Zip)
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dshread-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Expand-Archive -Path $Zip -DestinationPath $tmp -Force
    $mf = Join-Path $tmp 'manifest.json'
    if (Test-Path $mf) { return (Get-Content $mf -Raw | ConvertFrom-Json) }
    return $null
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Show-Snapshots {
  if (-not (Test-Path $BackupRoot)) { Write-Host "还没有任何快照（$BackupRoot 不存在）"; return }
  $lastGood = Join-Path $BackupRoot 'last-good.json'
  $goodName = $null
  if (Test-Path $lastGood) { $goodName = (Get-Content $lastGood -Raw | ConvertFrom-Json).zip }
  $rows = @(Get-ChildItem $BackupRoot -Filter '*.zip' -File | Sort-Object LastWriteTime -Descending)
  if ($rows.Count -eq 0) { Write-Host "快照目录是空的: $BackupRoot"; return }
  foreach ($r in $rows) {
    $mf = $null
    try { $mf = Get-Manifest $r.FullName } catch { }
    $n = if ($mf) { $mf.files.Count } else { '?' }
    $mark = if ($goodName -eq $r.Name) { '  <= last-good' } else { '' }
    $sec = if ($mf -and $mf.secrets) { ' [含密钥]' } else { '' }
    $note = if ($mf -and $mf.note) { "  " + $mf.note } else { '' }
    "{0,-56} {1,3} files  {2,8} KB{3}{4}{5}" -f $r.Name, $n, [int]($r.Length / 1KB), $mark, $sec, $note
  }
  if (-not $goodName) { Write-Host "`n（还没有 last-good 标记：启动成功后跑 -Action mark）" }
}

function Invoke-Restore {
  param([string]$Zip)
  if (-not (Test-Path $Zip)) { throw "快照不存在: $Zip" }
  $mf = Get-Manifest $Zip
  if (-not $mf) { throw "快照里没有 manifest.json —— 不是本脚本产生的？拒绝盲恢复: $Zip" }

  # 演练模式（TargetRoot 指向别处）也照样先拍 pre-restore？不 —— 演练不该污染快照目录。
  $isDrill = if ($null -eq $Drill) { $TargetRoot -ne (Join-Path $env:USERPROFILE '.dsh') } else { [bool]$Drill }
  $pre = $null
  if (-not $isDrill) {
    Write-Host "  先拍 pre-restore …"
    $pre = New-Snapshot -Note 'pre-restore' -ErrorAction Stop
    Write-Host "  pre-restore: $(Split-Path $pre.zip -Leaf)"
  }

  New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dshrest-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $restored = 0; $replaced = 0; $bad = 0
  try {
    Expand-Archive -Path $Zip -DestinationPath $tmp -Force
    foreach ($f in $mf.files) {
      $src = Join-Path $tmp $f.path
      if (-not (Test-Path $src)) { Write-Warning "快照缺文件: $($f.path)"; $bad++; continue }
      $sha = (Get-FileHash $src -Algorithm SHA256).Hash
      if ($sha -ne $f.sha256) { Write-Warning "哈希不符（快照本身损坏）: $($f.path)"; $bad++; continue }
      $dst = Join-Path $TargetRoot $f.path
      New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
      if (Test-Path $dst) { $replaced++ }
      Copy-Item $src $dst -Force
      $restored++
    }
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  if (-not $isDrill) {
    $log = [ordered]@{
      restoredAt = (Get-Date).ToUniversalTime().ToString('o')
      from       = (Split-Path $Zip -Leaf)
      preRestore = if ($pre) { (Split-Path $pre.zip -Leaf) } else { $null }
      files      = $restored
      overwrote  = $replaced
      bad        = $bad
    }
    $log | ConvertTo-Json | Set-Content -Path (Join-Path $BackupRoot 'last-restore.json') -Encoding UTF8
  }

  [pscustomobject]@{
    action    = 'restore'
    from      = (Split-Path $Zip -Leaf)
    files     = $restored
    overwrote = $replaced
    failed    = $bad
    root      = $TargetRoot
    drill     = $isDrill
    preRestore = if ($pre) { (Split-Path $pre.zip -Leaf) } else { $null }
  }
}

function Set-LastGood {
  if (-not (Test-Path $BackupRoot)) { throw "还没有任何快照: $BackupRoot" }
  $latest = Get-ChildItem $BackupRoot -Filter '*.zip' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "快照目录是空的: $BackupRoot" }
  [ordered]@{
    zip   = $latest.Name
    at    = (Get-Date).ToUniversalTime().ToString('o')
    host  = $env:COMPUTERNAME
  } | ConvertTo-Json | Set-Content -Path (Join-Path $BackupRoot 'last-good.json') -Encoding UTF8
  "已标记 last-good: $($latest.Name)"
}

function Test-Drift {
  $lastGood = Join-Path $BackupRoot 'last-good.json'
  if (-not (Test-Path $lastGood)) { throw "没有 last-good 标记，先跑 -Action mark" }
  $good = (Get-Content $lastGood -Raw | ConvertFrom-Json).zip
  $zip = Join-Path $BackupRoot $good
  if (-not (Test-Path $zip)) { throw "last-good 指向的快照不见了: $good" }
  $mf = Get-Manifest $zip
  $now = @{}
  foreach ($f in (Get-ScopeFiles -Root $TargetRoot)) { $now[$f.Rel] = $f.Sha }
  $diffs = @()
  foreach ($f in $mf.files) {
    if (-not $now.ContainsKey($f.path)) { $diffs += "缺失  $($f.path)"; continue }
    if ($now[$f.path] -ne $f.sha256) { $diffs += "已改  $($f.path)"; $now.Remove($f.path) } else { $now.Remove($f.path) }
  }
  foreach ($k in $now.Keys) { $diffs += "新增  $k" }
  [pscustomobject]@{
    action = 'verify'
    lastGood = $good
    drifted = $diffs.Count
    detail  = $diffs
  }
}

switch ($Action) {
  'snapshot' { New-Snapshot | Format-List }
  'list'     { Show-Snapshots }
  'restore'  {
    if (-not $Name) { throw "-Action restore 需要 -Name <zip>" }
    $zip = if (Test-Path $Name) { $Name } else { Join-Path $BackupRoot $Name }
    Invoke-Restore -Zip $zip | Format-List
  }
  'mark'     { Set-LastGood }
  'verify'   {
    $r = Test-Drift
    "last-good: $($r.lastGood)"
    if ($r.drifted -eq 0) { "  与 last-good 完全一致" } else { $r.detail | ForEach-Object { "  $_" } }
  }
}
