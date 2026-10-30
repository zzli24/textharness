Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RM2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct POINT { public int X, Y; }
  public const uint DOWN = 0x0002, UP = 0x0004;
  public const uint SW_RESTORE = 9;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001;
}
"@

$t = Get-Process TextHarness,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'TextHarness' } | Select-Object -First 1
if (-not $t) { "没有窗口"; exit 1 }
$h = $t.MainWindowHandle

# 强制提到前台
[RM2]::ShowWindow($h, [RM2]::SW_RESTORE) | Out-Null
[RM2]::SetWindowPos($h, [RM2]::HWND_TOPMOST, 0, 0, 0, 0, [RM2]::SWP_NOMOVE -bor [RM2]::SWP_NOSIZE) | Out-Null
[RM2]::BringWindowToTop($h) | Out-Null
[RM2]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
[RM2]::SetWindowPos($h, [RM2]::HWND_NOTOPMOST, 0, 0, 0, 0, [RM2]::SWP_NOMOVE -bor [RM2]::SWP_NOSIZE) | Out-Null
Start-Sleep -Milliseconds 300

$fg = [RM2]::GetForegroundWindow()
"foreground == window: $($fg -eq $h)  (fg=$fg window=$h)"

$r = New-Object RM2+RECT
[RM2]::GetWindowRect($h, [ref]$r) | Out-Null
$y = $r.Top + 400
$x1 = $r.Left + 600
$x2 = $r.Left + 900

[RM2]::SetCursorPos($x1, $y) | Out-Null
Start-Sleep -Milliseconds 200
$pos = New-Object RM2+POINT
[RM2]::GetCursorPos([ref]$pos) | Out-Null
"光标位置: $($pos.X),$($pos.Y)  期望: $x1,$y"

[RM2]::mouse_event([RM2]::DOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
for ($i = 1; $i -le 12; $i++) {
  $nx = $x1 + ($x2 - $x1) * $i / 12
  [RM2]::SetCursorPos($nx, $y) | Out-Null
  Start-Sleep -Milliseconds 40
}
[RM2]::mouse_event([RM2]::UP, 0, 0, 0, [UIntPtr]::Zero)
"drag done"
