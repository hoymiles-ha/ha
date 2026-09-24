<#
.SYNOPSIS
    发布一个新版本：bump manifest.json 版本号 -> 提交 -> 打 tag ->（可选）推送。

.DESCRIPTION
    HACS 的更新完全依赖 GitHub Release。只 push commit 而不打 tag / 不发 Release，
    用户侧收不到任何更新。这个脚本把"发版"变成一条命令，保证：

      1. manifest.json 的 version 与 git tag 始终一致
         （HACS 从 manifest 读版本，用 tag 做版本比较）
      2. tag 采用 vX.Y.Z 形式（HACS 需要可解析的版本号）
      3. 发版前做自检（必需文件齐全、JSON 合法、工作区干净、tag 未占用）

    脚本用正则只替换 manifest.json 里的 version 字段，保持文件原有格式不变。

.PARAMETER Version
    新版本号，形如 0.2.0（可带 v 前缀，脚本会自动去掉）。

.PARAMETER Push
    推送 commit 和 tag 到 origin。不指定时只做本地提交与打 tag。

.PARAMETER PreRelease
    在最后的提示里标记为灰度发布（需要在 GitHub 上勾选 pre-release）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.2.0 -Push

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.2.0-rc1 -PreRelease
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [switch]$Push,

    [switch]$PreRelease
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Fail([string]$Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}
function Step([string]$Message) { Write-Host "[ .. ] $Message" -ForegroundColor Cyan }
function Ok([string]$Message) { Write-Host "[ OK ] $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "[WARN] $Message" -ForegroundColor Yellow }

function Read-JsonFile([string]$Path) {
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    return $text | ConvertFrom-Json
}

# ------------------------------------------------------------ 参数与预检 ---
$Version = $Version.TrimStart("v", "V")
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.\-]+)?$') {
    Fail "版本号格式不合法：'$Version'。期望形如 0.2.0（HACS 需要可解析的版本号）。"
}

$tag = "v$Version"
$manifestRel = "custom_components\hoymiles\manifest.json"
$manifestPath = Join-Path $repoRoot $manifestRel
$hacsPath = Join-Path $repoRoot "hacs.json"

Step "预检..."

if (-not (Test-Path (Join-Path $repoRoot ".git"))) {
    Fail "当前目录还不是 git 仓库。先执行：`n    git init -b main`n    git remote add origin <你的仓库地址>"
}

$required = @(
    "LICENSE",
    "README.md",
    "hacs.json",
    $manifestRel,
    "custom_components\hoymiles\brand\icon.png",
    "custom_components\hoymiles\www\hoymiles-tou-editor.js",
    "custom_components\hoymiles\www\hoymiles-energy-sankey.js"
)
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $repoRoot $_)) })
if ($missing.Count -gt 0) { Fail ("缺少 HACS 上架必需文件：" + ($missing -join ", ")) }
Ok "必需文件齐全"

# Brand images have their own spec; releasing a broken icon is a silent UX bug
# (it renders at ~40 px in the HA "pick a brand" dialog, where a bad mark just
# looks like a smudge).
Add-Type -AssemblyName System.Drawing
$brandDir = Join-Path $repoRoot "custom_components\hoymiles\brand"
foreach ($img in @(
        @{ Name = "icon.png"; WantSquare = $true },
        @{ Name = "logo.png"; WantSquare = $false }
    )) {
    $p = Join-Path $brandDir $img.Name
    $bmp = [System.Drawing.Bitmap]::FromFile($p)
    $w = $bmp.Width
    $h = $bmp.Height
    $bmp.Dispose()
    $short = [Math]::Min($w, $h)
    if ($img.WantSquare) {
        if ($w -ne $h -or $w -lt 256) {
            Fail "$($img.Name) 不合规：期望正方形且边长 >= 256，实际 ${w}x${h}。请运行 scripts\make_brand_from_official.ps1"
        }
    }
    else {
        if ($short -lt 128 -or $short -gt 256) {
            Fail "$($img.Name) 不合规：短边需在 128..256，实际 ${w}x${h}。请运行 scripts\make_brand_from_official.ps1"
        }
    }
}
Ok "品牌图规格合规"

foreach ($jsonPath in @($hacsPath, $manifestPath)) {
    try { $null = Read-JsonFile $jsonPath }
    catch { Fail "JSON 非法：$jsonPath -> $($_.Exception.Message)" }
}
Ok "JSON 合法"

$dirty = git status --porcelain
if ($dirty) {
    Write-Host $dirty
    Fail "工作区有未提交的改动。请先提交或 stash，再重新发版。"
}

if (git tag --list $tag) { Fail "tag $tag 已存在" }

# ------------------------------------------------------------- bump version ---
$manifest = Read-JsonFile $manifestPath
$oldVersion = $manifest.version
Step "版本：$oldVersion -> $Version"

$raw = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$pattern = '("version"\s*:\s*")[^"]*(")'
if ($raw -notmatch $pattern) { Fail "在 $manifestRel 中找不到 version 字段" }
$raw = [regex]::Replace($raw, $pattern, "`${1}$Version`${2}", 1)

# 统一 LF + 结尾换行，且不写 BOM
$raw = $raw -replace "`r`n", "`n"
if (-not $raw.EndsWith("`n")) { $raw += "`n" }
[System.IO.File]::WriteAllText($manifestPath, $raw, (New-Object System.Text.UTF8Encoding($false)))

# 复读确认，避免静默写坏
$check = Read-JsonFile $manifestPath
if ($check.version -ne $Version) { Fail "写入后版本号校验失败：$($check.version)" }
Ok "manifest.json 已更新为 $Version"

# ----------------------------------------------------------- commit 与 tag ---
git add $manifestRel
git commit -m "Release $tag"
if ($LASTEXITCODE -ne 0) { Fail "git commit 失败" }
Ok "已提交 Release $tag"

$annotate = "Release $tag"
if ($PreRelease) { $annotate += " (pre-release)" }
git tag -a $tag -m $annotate
if ($LASTEXITCODE -ne 0) { Fail "git tag 失败" }
Ok "已打 tag $tag"

# -------------------------------------------------------------------- push ---
$branch = git rev-parse --abbrev-ref HEAD
if ($Push) {
    Step "推送到 origin..."
    git push origin $branch
    if ($LASTEXITCODE -ne 0) { Fail "git push 失败" }
    git push origin $tag
    if ($LASTEXITCODE -ne 0) { Fail "推送 tag 失败（可稍后重试：git push origin $tag）" }
    Ok "已推送 $branch 与 $tag"
}
else {
    Warn "未指定 -Push，只做了本地提交与打 tag。"
    Write-Host "       推送命令：git push origin $branch; git push origin $tag"
}

# ---------------------------------------------------------------- 后续提醒 ---
Write-Host ""
Write-Host "================================================================" -ForegroundColor Yellow
Write-Host " 还差一步，否则用户收不到更新：在 GitHub 创建 Release" -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Yellow
Write-Host "   Tag: $tag"
if ($PreRelease) {
    Write-Host "   勾选 'Set as a pre-release'（灰度，仅开启 beta 的用户可见）" -ForegroundColor Yellow
}
Write-Host "   写 release notes —— 会显示在 HACS 的更新界面里"
Write-Host ""
Write-Host "   打开：https://github.com/<owner>/<repo>/releases/new?tag=$tag"
Write-Host ""
Write-Host "   之后：Actions 里 HACS + hassfest 应全绿；"
Write-Host "         用户在 HACS 点【更新】-> 完整重启 HA Core"
Write-Host ""
