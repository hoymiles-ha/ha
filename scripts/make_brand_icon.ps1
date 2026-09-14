<#
.SYNOPSIS
    生成 HACS / Home Assistant 品牌图标 (brand/icon.png)。

.DESCRIPTION
    输出 256x256 的 PNG，放在 custom_components/hoymiles/brand/icon.png。
    这是 HACS `brands` 校验的必需项：要么仓库里有本地图标，要么已合入
    home-assistant/brands 仓库（本地图标可免去一次上游 PR）。

    需要 System.Drawing（Windows PowerShell 5.1 自带）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make_brand_icon.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputDir,
    [int]$Size = 256
)

$ErrorActionPreference = "Stop"

if (-not $OutputDir) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $OutputDir = Join-Path $repoRoot "custom_components\hoymiles\brand"
}

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

$outFile = Join-Path $OutputDir "icon.png"

# 以 512 为设计基准，最后按 $Size 缩放，保证几何比例与圆角一致。
$design = 512.0
$scale = $Size / $design

function New-RoundedRectPath {
    param([System.Drawing.RectangleF]$Rect, [float]$Radius)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $p.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
    $p.AddArc($Rect.Right - $d, $Rect.Y, $d, $d, 270, 90)
    $p.AddArc($Rect.Right - $d, $Rect.Bottom - $d, $d, $d, 0, 90)
    $p.AddArc($Rect.X, $Rect.Bottom - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

$bmp = New-Object System.Drawing.Bitmap($Size, $Size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

try {
    # --- 圆角方形底 + 品牌绿渐变 ---
    $pad = 8.0 * $scale
    $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($Size - 2 * $pad), ($Size - 2 * $pad))
    $radius = 88.0 * $scale
    $path = New-RoundedRectPath -Rect $rect -Radius $radius

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 18, 183, 106),   # #12B76A
        [System.Drawing.Color]::FromArgb(255, 5, 106, 62),     # #056A3E
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
    )
    $g.FillPath($brush, $path)

    # --- 中央白色闪电（储能 / 能量流意象）---
    $boltDesign = @(
        @(292, 52), @(176, 276), @(252, 276), @(216, 460),
        @(336, 228), @(260, 228), @(292, 52)
    )
    $pts = New-Object 'System.Drawing.PointF[]' ($boltDesign.Count - 1)
    for ($i = 1; $i -lt $boltDesign.Count; $i++) {
        $pts[$i - 1] = New-Object System.Drawing.PointF(
            ([float]($boltDesign[$i][0] * $scale)),
            ([float]($boltDesign[$i][1] * $scale))
        )
    }

    $boltBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPolygon($boltBrush, $pts)
}
finally {
    $g.Dispose()
}

$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$len = (Get-Item $outFile).Length
Write-Host ("[OK] {0} ({1} bytes, {2}x{2})" -f $outFile, $len, $Size)
if ($len -lt 200) {
    throw "生成的 PNG 似乎无效（过小）"
}
