param([int]$PX1, [int]$PY1, [int]$PX2, [int]$PY2)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RM5 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint DOWN = 0x0002, UP = 0x0004;
  public static void Focus(IntPtr h) {
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), 0);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true);
    SetForegroundWindow(h);
    AttachThreadInput(me, fg, false);
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1);
    System.Threading.Thread.Sleep(220);
    mouse_event(DOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(140);
    int steps = 18;
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
      System.Threading.Thread.Sleep(28);
    }
    System.Threading.Thread.Sleep(120);
    mouse_event(UP, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
$t = Get-Process TextHarness,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'TextHarness' } | Select-Object -First 1
if (-not $t) { "没有窗口"; exit 1 }
$h = $t.MainWindowHandle
[RM5]::Focus($h)
Start-Sleep -Milliseconds 400
$r = New-Object RM5+RECT
[RM5]::GetWindowRect($h, [ref]$r) | Out-Null

# 视口原点：横向等于窗口左边，纵向 = 窗口顶 + 标题栏高度（实测 38px）
$x1 = $r.Left + $PX1
$y1 = $r.Top + 38 + $PY1
$x2 = $r.Left + $PX2
$y2 = $r.Top + 38 + $PY2
"rect=$($r.Left),$($r.Top)  拖拽 ($x1,$y1) -> ($x2,$y2)"
[RM5]::Drag($x1, $y1, $x2, $y2)
