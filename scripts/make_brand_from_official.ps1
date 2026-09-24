<#
.SYNOPSIS
    Build the Home Assistant / HACS brand assets from the official Hoymiles logo.

.DESCRIPTION
    Produces the two files HACS and HA expect in
    custom_components/hoymiles/brand/:

      icon.png  256x256, square, transparent - the circular mark on its own
      logo.png  horizontal lockup (mark left + wordmark right), transparent

    The official logo is a single vertical artwork:
    a solid brand-blue disc with a white "H", and the "Hoymiles" wordmark
    underneath. The two parts are separated by scanning for blank horizontal
    bands, then each part is re-composed at the target size.

    Why not just crop the wordmark? Because cropping a wide wordmark into a
    square produces an icon whose letters overflow the mark and turn to mush
    when Home Assistant renders it at ~40 px in the "Pick a brand or
    integration" dialog. The circular mark has to be extracted on its own.

    Brand blue is RGB(3, 3, 216) = #0303D8.

.PARAMETER InputImage
    Path to the official logo artwork (PNG with a transparent background).
    Defaults to brand-source.png next to this script.

.PARAMETER OutputDir
    Destination directory. Defaults to custom_components/hoymiles/brand.

.PARAMETER IconSize
    Side length of icon.png. Default 256 (what Home Assistant expects).

.PARAMETER IconPadding
    Fraction of IconSize kept clear around the mark. Default 0.05.

.PARAMETER LogoHeight
    Height of logo.png. Default 256; the shortest side must be 128..256 to
    satisfy the HACS brand image spec.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make_brand_from_official.ps1 `
        -InputImage .\brand-source.png
#>
[CmdletBinding()]
param(
    [string]$InputImage,

    [string]$OutputDir,

    [int]$IconSize = 256,

    [double]$IconPadding = 0.05,

    [int]$LogoHeight = 256
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $OutputDir) {
    $OutputDir = Join-Path $repoRoot "custom_components\hoymiles\brand"
}
if (-not $InputImage) {
    # The design source lives next to this script so it is never shipped to
    # users through HACS, but stays in the repo for reproducibility.
    $InputImage = Join-Path $PSScriptRoot "brand-source.png"
}
if (-not (Test-Path -LiteralPath $InputImage)) {
    Fail "Input image not found: $InputImage`nPass -InputImage <path> pointing at the official logo artwork."
}
if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

Add-Type -AssemblyName System.Drawing

Write-Host "[ .. ] Reading $InputImage"

# Normalise to 32bppArgb so LockBits / compositing always behave.
$raw = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $InputImage).Path)
$w = [int]$raw.Width
$h = [int]$raw.Height
$src = New-Object System.Drawing.Bitmap -ArgumentList @($w, $h)
$g0 = [System.Drawing.Graphics]::FromImage($src)
$g0.DrawImage($raw, 0, 0, $w, $h)
$g0.Dispose()
$raw.Dispose()
Write-Host "[ .. ] Source $w x $h"

# ----------------------------------------------------------------- read pixels
$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$data = $src.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$src.UnlockBits($data)

# Sampling stride: the artwork is huge, per-pixel GetPixel would be far too slow.
$step = 4
$alphaFloor = 128

# ------------------------------------------------------- find the content bands
$rowHas = New-Object bool[] $h
$minX = $w; $maxX = -1; $minY = $h; $maxY = -1
for ($y = 0; $y -lt $h; $y += $step) {
    $rowBase = $y * $stride
    $found = $false
    for ($x = 0; $x -lt $w; $x += $step) {
        if ($bytes[$rowBase + $x * 4 + 3] -le $alphaFloor) { continue }
        $found = $true
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
    }
    $rowHas[$y] = $found
}
if ($maxX -lt 0) { Fail "The input image is fully transparent." }
Write-Host "[ .. ] Content bbox x=$minX..$maxX  y=$minY..$maxY"

# Walk in the same stride as the sampling loop above.
$bands = @()
$inBand = $false
$bandStart = 0
for ($y = 0; $y -lt $h; $y += $step) {
    if ($rowHas[$y] -and -not $inBand) {
        $inBand = $true
        $bandStart = $y
    }
    elseif (-not $rowHas[$y] -and $inBand) {
        $inBand = $false
        $bands += , @($bandStart, [Math]::Min($h - 1, $y - 1 + ($step - 1)))
    }
}
if ($inBand) { $bands += , @($bandStart, ($h - 1)) }

# Ignore slivers: only keep bands tall enough to be real artwork.
$minBandHeight = $step * 2
$real = @($bands | Where-Object { ($_[1] - $_[0] + 1) -gt $minBandHeight })

if ($real.Count -lt 2) {
    Fail ("Expected two content bands (mark on top, wordmark below) but found {0}." -f $real.Count) `
        "Is this the vertical logo artwork with the wordmark underneath the disc?"
}

# The first band is the disc, the last is the wordmark.
$circleBand = $real[0]
$wordBand = $real[$real.Count - 1]
Write-Host ("[ .. ] Disc band     y {0}..{1}  (height {2})" -f $circleBand[0], $circleBand[1], ($circleBand[1] - $circleBand[0] + 1))
Write-Host ("[ .. ] Wordmark band y {0}..{1}  (height {2})" -f $wordBand[0], $wordBand[1], ($wordBand[1] - $wordBand[0] + 1))

function Get-TightRect {
    param([int]$Y0, [int]$Y1, [string]$Label)
    $lx = $w; $hx = -1
    for ($y = $Y0; $y -le $Y1; $y += $step) {
        $rowBase = $y * $stride
        for ($x = 0; $x -lt $w; $x += $step) {
            if ($bytes[$rowBase + $x * 4 + 3] -le $alphaFloor) { continue }
            if ($x -lt $lx) { $lx = $x }
            if ($x -gt $hx) { $hx = $x }
        }
    }
    if ($hx -lt 0) { Fail "Could not find any opaque pixels in the $Label band." }
    # Grow to the sampling grid so we never clip the very last column/row.
    $lx = [Math]::Max(0, $lx - $step)
    $hx = [Math]::Min($w - 1, $hx + $step)
    return New-Object System.Drawing.Rectangle($lx, $Y0, ($hx - $lx + 1), ($Y1 - $Y0 + 1))
}

$markRect = Get-TightRect -Y0 $circleBand[0] -Y1 $circleBand[1] -Label "disc"
$wordRect = Get-TightRect -Y0 $wordBand[0] -Y1 $wordBand[1] -Label "wordmark"
Write-Host ("[ .. ] Disc     {0}" -f $markRect)
Write-Host ("[ .. ] Wordmark {0}  ratio {1:N2}:1" -f $wordRect, ($wordRect.Width / [double]$wordRect.Height))

function New-RenderTarget {
    param([int]$Width, [int]$Height)
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList @($Width, $Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    return @($bmp, $g)
}

# ------------------------------------------------------------------- icon.png
$side = [int]([Math]::Round($IconSize * (1.0 - 2.0 * $IconPadding)))
$offset = [int](($IconSize - $side) / 2)
$pair = New-RenderTarget -Width $IconSize -Height $IconSize
$iconBmp = $pair[0]; $gi = $pair[1]
$gi.DrawImage($src, (New-Object System.Drawing.Rectangle($offset, $offset, $side, $side)), $markRect, [System.Drawing.GraphicsUnit]::Pixel)
$gi.Dispose()
$iconPath = Join-Path $OutputDir "icon.png"
$iconBmp.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
$iconBmp.Dispose()
Write-Host ("[ OK ] icon.png {0}x{0} (mark drawn {1}x{1})" -f $IconSize, $side)

# ------------------------------------------------------------------- logo.png
# Horizontal lockup: the disc at full height, the wordmark optically scaled to
# its cap height and vertically centred.
$markH = [int]($LogoHeight * 0.78)
$markW = [int]($markH * ($markRect.Width / [double]$markRect.Height))
$wordH = [int]($markH * 0.42)
$wordW = [int]($wordH * ($wordRect.Width / [double]$wordRect.Height))
$gap = [int]($markH * 0.30)
$logoW = $markW + $gap + $wordW

$pair = New-RenderTarget -Width $logoW -Height $LogoHeight
$logoBmp = $pair[0]; $gl = $pair[1]
$gl.DrawImage($src, (New-Object System.Drawing.Rectangle(0, [int](($LogoHeight - $markH) / 2), $markW, $markH)), $markRect, [System.Drawing.GraphicsUnit]::Pixel)
$gl.DrawImage($src, (New-Object System.Drawing.Rectangle(($markW + $gap), [int](($LogoHeight - $wordH) / 2), $wordW, $wordH)), $wordRect, [System.Drawing.GraphicsUnit]::Pixel)
$gl.Dispose()
$logoPath = Join-Path $OutputDir "logo.png"
$logoBmp.Save($logoPath, [System.Drawing.Imaging.ImageFormat]::Png)
$logoBmp.Dispose()
Write-Host ("[ OK ] logo.png {0}x{1}" -f $logoW, $LogoHeight)

$src.Dispose()

# ------------------------------------------------------------------ self-check
Write-Host ""
Write-Host "Spec check (HACS brand images):"
foreach ($f in @($iconPath, $logoPath)) {
    $b = [System.Drawing.Bitmap]::FromFile($f)
    $short = [Math]::Min($b.Width, $b.Height)
    $isIcon = ($f -eq $iconPath)
    $ok = if ($isIcon) { ($b.Width -eq $b.Height) -and ($b.Width -ge 256) }
    else { ($short -ge 128) -and ($short -le 256) }
    $verdict = if ($ok) { "OK" } else { "FAIL" }
    Write-Host ("  {0,-9} {1,4}x{2,-4} shortest {3,3}   {4}" -f (Split-Path -Leaf $f), $b.Width, $b.Height, $short, $verdict)
    $b.Dispose()
    if (-not $ok) { Fail "Brand image does not meet the HACS spec." }
}
Write-Host ""
Write-Host "[ OK ] Brand assets written to $OutputDir" -ForegroundColor Green
