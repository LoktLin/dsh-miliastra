# thumbnail.ps1 -- downscale a PNG into a small preview PNG.
#
# ASCII-ONLY ON PURPOSE: Windows PowerShell 5.1 decodes .ps1 as ANSI unless the file has a
# UTF-8 BOM, so any non-ASCII here would turn into mojibake and break parsing.
#
# Why PowerShell again: Node has no image library, and this package is deliberately
# dependency-free. System.Drawing is already loaded for the capture helper, so a resize
# costs nothing extra.
#
# The panel shows a dozen shots at once; the raw captures are ~2.5 MB each, so serving them
# directly would push ~30 MB into the page every time the list refreshes. Previews are cached
# next to nothing -- see lib/shot.mjs, which keeps them in <shots>\_thumbs\.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File thumbnail.ps1 -In big.png -Out small.png -Width 320
# Prints one JSON line: {"ok":true,"path":..,"width":320,"height":206}
param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Width = 320
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Emit($obj) {
  # Stdout is written in the console codepage (936/GBK here), not UTF-8 -- escape non-ASCII
  # as \uXXXX so the line decodes identically in any consumer.
  $json = ConvertTo-Json $obj -Compress
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  Write-Output $json
}

try {
  if (-not (Test-Path -LiteralPath $In)) { Emit @{ ok = $false; error = 'input not found' }; exit 1 }
  if ($Width -lt 16) { $Width = 16 }
  if ($Width -gt 2000) { $Width = 2000 }

  $src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $In).Path)
  try {
    if ($src.Width -le $Width) {
      # already small enough -- copy as-is rather than upscaling
      $w = $src.Width; $h = $src.Height
    } else {
      $w = $Width
      $h = [Math]::Max(1, [int][Math]::Round($src.Height * ($Width / [double]$src.Width)))
    }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.DrawImage($src, 0, 0, $w, $h)
    } finally { $g.Dispose() }

    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
    # Save to a temp name then move, so a crash never leaves a half-written preview
    $tmp = $Out + '.part'
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
    Move-Item -LiteralPath $tmp -Destination $Out -Force
  } finally { $src.Dispose() }

  Emit @{ ok = $true; path = $Out; width = $w; height = $h }
} catch {
  Emit @{ ok = $false; error = ($_.Exception.Message) }
  exit 1
}
