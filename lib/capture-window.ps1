# capture-window.ps1 -- capture a window of a given process to a PNG.
#
# ASCII-ONLY ON PURPOSE: Windows PowerShell 5.1 decodes .ps1 as ANSI unless the file has a
# UTF-8 BOM, so any non-ASCII here would turn into mojibake and break parsing.
#
# Why a helper script instead of pure Node: Node has no built-in screen capture on Windows.
#
# ---- WHICH WINDOW GETS CAPTURED (this was wrong twice; read before changing) ----
#
# A process does NOT have one window. Measured on this machine:
#   BeyondEditor.exe (5608) -> 900x800 (log window)  and  160x28 (title-bar scrap)
#   Process.MainWindowHandle pointed at the 160x28 one, so the "editor screenshot" came back
#   as a sliver of a menu bar that still reported ok:true. So we enumerate EVERY visible
#   top-level window of the target process and take the LARGEST by area, and we refuse to
#   capture anything below MIN_W x MIN_H -- a capture that small is never what anyone wanted,
#   and writing it to the shots folder just creates junk to clean up later.
#   Optional -Title <substring> overrides the choice when several windows are plausible.
#
# ---- TWO CAPTURE STRATEGIES, tried in order ----
#   1) PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT=2) -- asks the WINDOW to render itself.
#      Works while occluded / not focused. This is the one we want for a game window.
#   2) CopyFromScreen over the window rect -- captures whatever is on the SCREEN in that area,
#      so it is only correct if the window is actually in front. We first try to bring it to
#      front (restore + AttachThreadInput + SetForegroundWindow, since a plain
#      SetForegroundWindow is refused by Windows when the caller does not own the foreground).
#
# Step 1 can come back all black (or all one colour) for some D3D/WPF surfaces, so we MEASURE
# blackRatio AND uniformRatio and fall back automatically instead of silently handing back a
# blank PNG. Both numbers go out in the result so the caller can judge rather than trust.
#
# The result always names the window that was ACTUALLY captured (pid / process / title), plus
# every candidate it chose between. That is not decoration: the first version grabbed the wrong
# program entirely and the only reason we know is that a human looked at the PNG.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-window.ps1 -ProcessName YuanShen -Out C:\x\shot.png
# Prints one JSON line:
#   {"ok":true,"path":..,"width":..,"height":..,"mode":"printwindow","blackRatio":0.02,
#    "uniformRatio":0.11,"front":false,"pid":3284,"process":"YuanShen","title":"Genshin",
#    "candidates":[{"pid":3284,"title":"Genshin","w":1456,"h":939,"area":1367184,"minimized":false}]}
param(
  [Parameter(Mandatory=$true)][string]$ProcessName,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Title = "",
  [string]$ThumbOut = "",
  [int]$ThumbWidth = 320,
  [int]$BringToFront = 1,
  [int]$KeepWindowOnTop = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# A window smaller than this is never a real capture target (title-bar scraps, tool windows).
$MIN_W = 200
$MIN_H = 150

try {
  Add-Type -Namespace Dpi -Name Aware -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
  [void][Dpi.Aware]::SetProcessDPIAware()
} catch { }

Add-Type -Namespace Win -Name Api -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowTextLength(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint id);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, System.IntPtr id);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr hWnd, System.IntPtr hdc, uint flags);
'@

function Emit($obj) {
  # PowerShell 5.1 writes redirected stdout in the console codepage (936/GBK here), NOT UTF-8,
  # so a window title carries CJK bytes that Node would decode as mojibake. Escape every
  # non-ASCII character as \uXXXX so the whole line is pure ASCII and decodes identically.
  $json = ConvertTo-Json $obj -Compress -Depth 6
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  Write-Output $json
}

function Fail($msg, $extra) {
  $o = @{ ok = $false; error = $msg }
  if ($extra) { $o.candidates = $extra }
  Emit $o
  exit 1
}

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Fail ("process not running: " + $ProcessName) }
$want = @($procs | ForEach-Object { [int]$_.Id })

# ---- enumerate every visible top-level window of those processes ----
$found = New-Object System.Collections.ArrayList
$cb = [Win.Api+EnumProc]{
  param($h, $p)
  $owner = 0
  [void][Win.Api]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($want -notcontains [int]$owner) { return $true }
  if (-not [Win.Api]::IsWindowVisible($h)) { return $true }
  $len = [Win.Api]::GetWindowTextLength($h)
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][Win.Api]::GetWindowText($h, $sb, $sb.Capacity)
  $t = $sb.ToString()
  if ($Title -and ($t -notlike ("*" + $Title + "*"))) { return $true }
  $r = New-Object Win.Api+RECT
  if (-not [Win.Api]::GetWindowRect($h, [ref]$r)) { return $true }
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  if ($w -le 0 -or $hh -le 0) { return $true }
  [void]$found.Add([pscustomobject]@{
    hwnd = $h; pid = [int]$owner; title = $t; w = $w; h = $hh
    area = ($w * $hh); minimized = [Win.Api]::IsIconic($h)
  })
  return $true
}
[void][Win.Api]::EnumWindows($cb, [System.IntPtr]::Zero)

if ($found.Count -eq 0) {
  $extra = ""
  if ($Title) { $extra = " matching title '" + $Title + "'" }
  Fail ("no visible window for process: " + $ProcessName + $extra)
}

# Largest first; prefer a non-minimized window at equal size.
$ordered = @($found | Sort-Object -Property @{Expression={ $_.area }; Descending=$true}, @{Expression={ [int]$_.minimized }; Descending=$false})
$best = $ordered[0]
$cand = @($ordered | ForEach-Object { @{ pid = $_.pid; title = $_.title; w = $_.w; h = $_.h; area = $_.area; minimized = $_.minimized } })

if ($best.w -lt $MIN_W -or $best.h -lt $MIN_H) {
  # Refuse instead of writing a 160x28 sliver into the shots folder.
  # (Keep this on ONE line: PowerShell 5.1 chokes on the leading-'+' continuation here.)
  $why = "the largest window of " + $ProcessName + " is only " + $best.w + "x" + $best.h + " (minimum " + $MIN_W + "x" + $MIN_H + "). The real window is probably minimized or was closed -- open it (or pass -Title to pick another) and retry."
  Fail $why $cand
}

$h = $best.hwnd
$w = $best.w
$hh = $best.h

# ---- strategy 1: PrintWindow (window renders itself; no focus needed) ----
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$pwOk = $false
try { $pwOk = [Win.Api]::PrintWindow($h, $hdc, 2) } catch { $pwOk = $false }
$g.ReleaseHdc($hdc)
$g.Dispose()

# Sample the bitmap once and return both ratios:
#   blackRatio   -- all-black capture (PrintWindow on some D3D surfaces)
#   uniformRatio -- all-one-colour capture (a WHITE/blank surface passes a black-only test!)
function Sample($bitmap) {
  $step = [Math]::Max(1, [int]([Math]::Min($bitmap.Width, $bitmap.Height) / 40))
  $tot = 0; $blk = 0; $uni = 0
  $r0 = -1; $g0 = -1; $b0 = -1
  for ($y = 0; $y -lt $bitmap.Height; $y += $step) {
    for ($x = 0; $x -lt $bitmap.Width; $x += $step) {
      $c = $bitmap.GetPixel($x, $y)
      $tot++
      if ($c.R -lt 8 -and $c.G -lt 8 -and $c.B -lt 8) { $blk++ }
      if ($r0 -lt 0) { $r0 = $c.R; $g0 = $c.G; $b0 = $c.B; $uni++ }
      elseif ([Math]::Abs($c.R - $r0) -le 8 -and [Math]::Abs($c.G - $g0) -le 8 -and [Math]::Abs($c.B - $b0) -le 8) { $uni++ }
    }
  }
  if ($tot -eq 0) { return @{ black = 1.0; uni = 1.0 } }
  return @{ black = [Math]::Round($blk / $tot, 4); uni = [Math]::Round($uni / $tot, 4) }
}

$s = Sample $bmp
$blackRatio = $s.black
$uniformRatio = $s.uni
$mode = 'printwindow'
$front = $false

if (-not $pwOk -or $blackRatio -gt 0.985 -or $uniformRatio -gt 0.985) {
  # ---- strategy 2: bring to front, then grab the screen area ----
  $mode = 'screen'
  $bmp.Dispose()
  $fgThread = [Win.Api]::GetWindowThreadProcessId([Win.Api]::GetForegroundWindow(), [System.IntPtr]::Zero)
  $me = [Win.Api]::GetCurrentThreadId()
  if ($BringToFront -eq 1) {
    if ([Win.Api]::IsIconic($h)) { [void][Win.Api]::ShowWindow($h, 9) }   # SW_RESTORE
    [void][Win.Api]::AttachThreadInput($me, $fgThread, $true)
    [void][Win.Api]::SetForegroundWindow($h)
    [void][Win.Api]::AttachThreadInput($me, $fgThread, $false)
    [void][Win.Api]::ShowWindow($h, 5)                                   # SW_SHOW
    if ($KeepWindowOnTop -eq 1) { [void][Win.Api]::SetWindowPos($h, [System.IntPtr](-1), 0, 0, 0, 0, 3) }  # HWND_TOPMOST
    Start-Sleep -Milliseconds 700
    $front = ([Win.Api]::GetForegroundWindow() -eq $h)
  }
  # re-read rect: restoring may have moved/resized it
  $r2 = New-Object Win.Api+RECT
  if ([Win.Api]::GetWindowRect($h, [ref]$r2)) {
    $w = $r2.Right - $r2.Left; $hh = $r2.Bottom - $r2.Top
  }
  $bmp2 = New-Object System.Drawing.Bitmap($w, $hh)
  $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
  $g2.CopyFromScreen($r2.Left, $r2.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
  $g2.Dispose()
  $bmp = $bmp2
  $s = Sample $bmp
  $blackRatio = $s.black
  $uniformRatio = $s.uni
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

# ---- optional preview, produced from the SAME bitmap ----
# Doing it here costs nothing extra: the alternative is a second PowerShell spawn
# (~1s of process startup) just to downscale one image.
$thumbW = 0; $thumbH = 0
if ($ThumbOut) {
  try {
    if ($ThumbWidth -lt 16) { $ThumbWidth = 16 }
    if ($ThumbWidth -gt 2000) { $ThumbWidth = 2000 }
    if ($bmp.Width -le $ThumbWidth) { $thumbW = $bmp.Width; $thumbH = $bmp.Height; $thumb = $bmp }
    else {
      $thumbW = $ThumbWidth
      $thumbH = [Math]::Max(1, [int][Math]::Round($bmp.Height * ($ThumbWidth / [double]$bmp.Width)))
      $thumb = New-Object System.Drawing.Bitmap($thumbW, $thumbH)
      $tg = [System.Drawing.Graphics]::FromImage($thumb)
      try {
        $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $tg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $tg.DrawImage($bmp, 0, 0, $thumbW, $thumbH)
      } finally { $tg.Dispose() }
    }
    $tdir = Split-Path -Parent $ThumbOut
    if ($tdir -and -not (Test-Path -LiteralPath $tdir)) { [void](New-Item -ItemType Directory -Force -Path $tdir) }
    $tpart = $ThumbOut + '.part'
    $thumb.Save($tpart, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($thumb -ne $bmp) { $thumb.Dispose() }
    if (Test-Path -LiteralPath $ThumbOut) { Remove-Item -LiteralPath $ThumbOut -Force }
    Move-Item -LiteralPath $tpart -Destination $ThumbOut -Force
  } catch {
    # A missing preview must never lose the full-size capture that is already on disk.
    $thumbW = 0; $thumbH = 0
    $ThumbOut = ""
  }
}
$bmp.Dispose()

Emit @{
  ok = $true; path = $Out; width = $w; height = $hh
  mode = $mode; front = $front
  blackRatio = $blackRatio; uniformRatio = $uniformRatio
  thumbPath = $ThumbOut; thumbWidth = $thumbW; thumbHeight = $thumbH
  pid = $best.pid; process = $ProcessName; title = $best.title
  candidates = $cand
}
