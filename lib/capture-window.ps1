# capture-window.ps1 -- capture a window of a given process to a PNG.
#
# ASCII-ONLY ON PURPOSE: Windows PowerShell 5.1 decodes .ps1 as ANSI unless the file has a
# UTF-8 BOM, so any non-ASCII here would turn into mojibake and break parsing.
#
# Why a helper script instead of pure Node: Node has no built-in screen capture on Windows.
#
# TWO STRATEGIES, tried in order (this matters -- the first attempt captured the wrong thing):
#   1) PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT=2)  -- asks the WINDOW to render itself.
#      Works while occluded / not focused. This is the one we want for a game window.
#   2) CopyFromScreen over the window rect -- captures whatever is on the SCREEN in that area,
#      so it is only correct if the window is actually in front. We first try to bring it to
#      front (restore + AttachThreadInput + SetForegroundWindow, since a plain
#      SetForegroundWindow is refused by Windows when the caller does not own the foreground).
#
# Step 1 can come back all black for some D3D swap chains, so we MEASURE the black ratio and
# fall back automatically instead of silently handing back a black PNG.
#
# The result always names the window that was ACTUALLY captured (pid / process / title).
# That is not decoration: the first version grabbed the wrong program entirely (a screen grab
# over the game's rect returned the browser that happened to be in front) and the only reason
# we know is that a human looked at the PNG. Reporting the identity makes the mistake visible
# in the tool result itself.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-window.ps1 -ProcessName YuanShen -Out C:\x\shot.png
# Prints one JSON line:
#   {"ok":true,"path":..,"width":..,"height":..,"mode":"printwindow","blackRatio":0.02,
#    "front":false,"pid":3284,"process":"YuanShen","title":"Genshin"}
param(
  [Parameter(Mandatory=$true)][string]$ProcessName,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$BringToFront = 1,
  [int]$KeepWindowOnTop = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

try {
  Add-Type -Namespace Dpi -Name Aware -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
  [void][Dpi.Aware]::SetProcessDPIAware()
} catch { }

Add-Type -Namespace Win -Name Api -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetClientRect(System.IntPtr hWnd, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, System.IntPtr pid);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr hWnd, System.IntPtr hdc, uint flags);
'@

function Emit($obj) {
  # PowerShell 5.1 writes redirected stdout in the console codepage (936/GBK here), NOT UTF-8,
  # so a window title like "Genshin" in CJK arrives at Node as mojibake. Escape every non-ASCII
  # character as \uXXXX so the whole line is pure ASCII and decodes identically everywhere.
  $json = ConvertTo-Json $obj -Compress
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  Write-Output $json
}

function Fail($msg) {
  Emit @{ ok = $false; error = $msg }
  exit 1
}

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Fail ("process not running: " + $ProcessName) }
$target = $null
foreach ($p in $procs) { if ($p.MainWindowHandle -ne 0) { $target = $p; break } }
if (-not $target) { Fail ("no main window for process: " + $ProcessName) }

$h = $target.MainWindowHandle
$r = New-Object Win.Api+RECT
if (-not [Win.Api]::GetWindowRect($h, [ref]$r)) { Fail "GetWindowRect failed" }
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
if ($w -le 0 -or $hh -le 0) { Fail ("bad window rect: " + $w + "x" + $hh) }

# ---- strategy 1: PrintWindow (window renders itself; no focus needed) ----
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$pwOk = $false
try { $pwOk = [Win.Api]::PrintWindow($h, $hdc, 2) } catch { $pwOk = $false }
$g.ReleaseHdc($hdc)
$g.Dispose()

function BlackRatio($bitmap) {
  $step = [Math]::Max(1, [int]([Math]::Min($bitmap.Width, $bitmap.Height) / 40))
  $tot = 0; $blk = 0
  for ($y = 0; $y -lt $bitmap.Height; $y += $step) {
    for ($x = 0; $x -lt $bitmap.Width; $x += $step) {
      $c = $bitmap.GetPixel($x, $y)
      $tot++
      if ($c.R -lt 8 -and $c.G -lt 8 -and $c.B -lt 8) { $blk++ }
    }
  }
  if ($tot -eq 0) { return 1.0 }
  return [Math]::Round($blk / $tot, 4)
}

$pwRatio = BlackRatio $bmp
$mode = 'printwindow'
$front = $false
$bmp2 = $null

if (-not $pwOk -or $pwRatio -gt 0.985) {
  # ---- strategy 2: bring to front, then grab the screen area ----
  $mode = 'screen'
  $bmp.Dispose()
  $fgThread = [Win.Api]::GetWindowThreadProcessId([Win.Api]::GetForegroundWindow(), [IntPtr]::Zero)
  $me = [Win.Api]::GetCurrentThreadId()
  if ($BringToFront -eq 1) {
    if ([Win.Api]::IsIconic($h)) { [void][Win.Api]::ShowWindow($h, 9) }   # SW_RESTORE
    [void][Win.Api]::AttachThreadInput($me, $fgThread, $true)
    [void][Win.Api]::SetForegroundWindow($h)
    [void][Win.Api]::AttachThreadInput($me, $fgThread, $false)
    [void][Win.Api]::ShowWindow($h, 5)                                   # SW_SHOW
    if ($KeepWindowOnTop -eq 1) { [void][Win.Api]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 3) }  # HWND_TOPMOST
    Start-Sleep -Milliseconds 700
    $front = ([Win.Api]::GetForegroundWindow() -eq $h)
  }
  # re-read rect: restoring may have moved/resized it
  if ([Win.Api]::GetWindowRect($h, [ref]$r)) {
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  }
  $bmp2 = New-Object System.Drawing.Bitmap($w, $hh)
  $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
  $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
  $g2.Dispose()
  $bmp = $bmp2
  $pwRatio = BlackRatio $bmp
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Emit @{
  ok = $true; path = $Out; width = $w; height = $hh
  mode = $mode; front = $front; blackRatio = $pwRatio
  pid = $target.Id; process = $target.ProcessName; title = $target.MainWindowTitle
}
