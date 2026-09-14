<#
.SYNOPSIS
    Build Home Assistant / HACS brand assets (icon.png + logo.png) from a logo image.

.DESCRIPTION
    Home Assistant custom integrations need a brand icon so that HACS' `brands`
    validation passes and the integration shows a proper icon in the UI.
    Provide either:
      * a clean logo with a transparent background, or
      * a screenshot / flat image with a uniform solid background.

    In the latter case this script keys the background colour out (sampled from
    the image corners), un-mixes the colour from the background so the edges do
    not get a grey halo, then writes:

      icon.png  - square (IconSize x IconSize), transparent, the logo mark
                  (detected as the most saturated green area) or, when no such
                  mark exists, the whole wordmark fitted and centred
      logo.png  - the full wordmark, transparent, cropped to its bounding box

.PARAMETER InputImage
    Path to the source logo image (png / jpg / bmp).

.PARAMETER OutputDir
    Destination directory. Defaults to custom_components/hoymiles/brand.

.PARAMETER IconSize
    Side length of icon.png. Default 256.

.PARAMETER BgTolerance
    Colour distance from the sampled background treated as fully transparent.
    Default 42.

.PARAMETER EdgeFeather
    Colour distance at which a pixel becomes fully opaque. Values between
    BgTolerance and EdgeFeather are feathered. Default 95.

.PARAMETER NoMarkDetection
    Always use the full wordmark for icon.png instead of trying to isolate the
    logo mark.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make_brand_from_image.ps1 `
        -InputImage "$env:TEMP\hoymiles-logo.png"

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make_brand_from_image.ps1 `
        -InputImage .\logo-source.png -BgTolerance 30 -IconSize 512
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputImage,

    [string]$OutputDir,

    [int]$IconSize = 256,

    [int]$BgTolerance = 42,

    [int]$EdgeFeather = 95,

    [switch]$NoMarkDetection
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $InputImage)) {
    # Try interpreting a relative path against the repository root.
    $alt = Join-Path (Split-Path -Parent $PSScriptRoot) $InputImage
    if (Test-Path -LiteralPath $alt) { $InputImage = $alt }
    else { Fail "Input image not found: $InputImage" }
}

if (-not $OutputDir) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $OutputDir = Join-Path $repoRoot "custom_components\hoymiles\brand"
}

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $InputImage).Path)
$w = $src.Width
$h = $src.Height
Write-Host "[ .. ] Source: $InputImage ($w x $h, $($src.PixelFormat))"

# ---------------------------------------------------------------- sample bg ---
# Average a small patch at each corner to estimate the flat background colour.
$patch = [Math]::Max(3, [Math]::Min(8, [int]([Math]::Min($w, $h) / 12)))
$bgR = 0.0; $bgG = 0.0; $bgB = 0.0; $n = 0
$corners = @(
    @(0, 0),
    @(($w - $patch), 0),
    @(0, ($h - $patch)),
    @(($w - $patch), ($h - $patch))
)
foreach ($c in $corners) {
    for ($y = $c[1]; $y -lt ($c[1] + $patch); $y++) {
        for ($x = $c[0]; $x -lt ($c[0] + $patch); $x++) {
            $p = $src.GetPixel($x, $y)
            $bgR += $p.R; $bgG += $p.G; $bgB += $p.B; $n++
        }
    }
}
$bgR = [int]($bgR / $n); $bgG = [int]($bgG / $n); $bgB = [int]($bgB / $n)
Write-Host "[ .. ] Background colour sampled: R=$bgR G=$bgG B=$bgB"

# ------------------------------------------------------------------- key out ---
$out = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$maxX = -1; $maxY = -1; $minX = $w; $minY = $h
$markMinX = $w; $markMinY = $h; $markMaxX = -1; $markMaxY = -1

$t1 = [double]$BgTolerance
$t2 = [double]$EdgeFeather
if ($t2 -le $t1) { $t2 = $t1 + 1 }

for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
        $p = $src.GetPixel($x, $y)
        $dr = $p.R - $bgR; $dg = $p.G - $bgG; $db = $p.B - $bgB
        $d = [Math]::Sqrt(($dr * $dr) + ($dg * $dg) + ($db * $db))

        if ($d -le $t1) {
            $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
            continue
        }

        $a = if ($d -ge $t2) { 1.0 } else { ($d - $t1) / ($t2 - $t1) }

        # Un-mix the background so antialiased edges keep the logo colour
        # instead of a grey fringe: observed = a*colour + (1-a)*bg
        $cr = ($p.R - ((1 - $a) * $bgR)) / $a
        $cg = ($p.G - ((1 - $a) * $bgG)) / $a
        $cb = ($p.B - ((1 - $a) * $bgB)) / $a
        $cr = [Math]::Max(0, [Math]::Min(255, [int][Math]::Round($cr)))
        $cg = [Math]::Max(0, [Math]::Min(255, [int][Math]::Round($cg)))
        $cb = [Math]::Max(0, [Math]::Min(255, [int][Math]::Round($cb)))
        $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int][Math]::Round($a * 255), $cr, $cg, $cb))

        if ($a -gt 0.03) {
            if ($x -lt $minX) { $minX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -gt $maxY) { $maxY = $y }

            # Logo mark heuristic: strongly green pixels (the ring around the H).
            if ($p.G -gt ($p.R + 40) -and $p.G -gt ($p.B + 40)) {
                if ($x -lt $markMinX) { $markMinX = $x }
                if ($y -lt $markMinY) { $markMinY = $y }
                if ($x -gt $markMaxX) { $markMaxX = $x }
                if ($y -gt $markMaxY) { $markMaxY = $y }
            }
        }
    }
}

if ($maxX -lt 0) { Fail "Nothing left after removing the background. Try a smaller -BgTolerance." }
Write-Host "[ .. ] Logo bounding box: ($minX,$minY) - ($maxX,$maxY)"
$hasMark = ($markMaxX -ge 0) -and (-not $NoMarkDetection)
if ($hasMark) {
    Write-Host "[ .. ] Logo mark (green area) box: ($markMinX,$markMinY) - ($markMaxX,$markMaxY)"
}
else {
    Write-Host "[ .. ] No logo mark detected, using the full wordmark for the icon"
}

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

function Save-Crop {
    param(
        [System.Drawing.Bitmap]$Source,
        [int]$X, [int]$Y, [int]$W, [int]$H,
        [string]$Path
    )
    $rect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
    $crop = $Source.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $crop.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $crop.Dispose()
    Write-Host ("[ OK ] {0} ({1} x {2})" -f $Path, $W, $H)
}

# ---------------------------------------------------------------- logo.png ---
$logoPath = Join-Path $OutputDir "logo.png"
Save-Crop -Source $out -X $minX -Y $minY -W ($maxX - $minX + 1) -H ($maxY - $minY + 1) -Path $logoPath

# ---------------------------------------------------------------- icon.png ---
# Source region for the icon: the logo mark when available, else the wordmark.
if ($hasMark) {
    $sx = $markMinX; $sy = $markMinY
    $sw = $markMaxX - $markMinX + 1
    $sh = $markMaxY - $markMinY + 1
    # Make the crop square around the mark so the ring is not distorted.
    $side = [Math]::Max($sw, $sh)
    $cx = $sx + [int]($sw / 2); $cy = $sy + [int]($sh / 2)
    $sx = $cx - [int]($side / 2); $sy = $cy - [int]($side / 2)
    if ($sx -lt 0) { $sx = 0 }
    if ($sy -lt 0) { $sy = 0 }
    if (($sx + $side) -gt $w) { $side = $w - $sx }
    if (($sy + $side) -gt $h) { $side = $h - $sy }
    $sw = $side; $sh = $side
}
else {
    $sx = $minX; $sy = $minY
    $sw = $maxX - $minX + 1
    $sh = $maxY - $minY + 1
}

$srcRect = New-Object System.Drawing.Rectangle($sx, $sy, $sw, $sh)
$region = $out.Clone($srcRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

$icon = New-Object System.Drawing.Bitmap($IconSize, $IconSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($icon)
$g.Clear([System.Drawing.Color]::Transparent)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

# Keep a small margin so the artwork does not touch the edge.
$pad = [int]($IconSize * 0.06)
$avail = $IconSize - (2 * $pad)
$scale = [Math]::Min($avail / $sw, $avail / $sh)
$dw = [int][Math]::Round($sw * $scale)
$dh = [int][Math]::Round($sh * $scale)
$dx = [int](($IconSize - $dw) / 2)
$dy = [int](($IconSize - $dh) / 2)

$g.DrawImage($region, (New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)))
$g.Dispose()
$region.Dispose()

$iconPath = Join-Path $OutputDir "icon.png"
$icon.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()
Write-Host ("[ OK ] {0} ({1} x {1})" -f $iconPath, $IconSize)

$out.Dispose()
$src.Dispose()

Write-Host ""
Write-Host "Brand assets written to $OutputDir" -ForegroundColor Green
Write-Host "Next: commit them, then bump the version and publish a release."
