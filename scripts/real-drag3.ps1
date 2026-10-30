Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RM3 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint DOWN = 0x0002, UP = 0x0004;
  public static bool Focus(IntPtr h) {
    ShowWindow(h, 9);
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), 0);
    uint myThread = GetCurrentThreadId();
    AttachThreadInput(myThread, fgThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    AttachThreadInput(myThread, fgThread, false);
    return GetForegroundWindow() == h;
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1);
    System.Threading.Thread.Sleep(150);
    mouse_event(DOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(100);
    for (int i = 1; i <= 14; i++) {
      SetCursorPos(x1 + (x2 - x1) * i / 14, y1 + (y2 - y1) * i / 14);
      System.Threading.Thread.Sleep(35);
    }
    System.Threading.Thread.Sleep(80);
    mouse_event(UP, 0, 0, 0, UIntPtr.Zero);
  }
}
"@

$t = Get-Process TextHarness -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
if (-not $t) { "没有窗口"; exit 1 }
$h = $t.MainWindowHandle
$ok = [RM3]::Focus($h)
"前台成功: $ok"
Start-Sleep -Milliseconds 500

$r = New-Object RM3+RECT
[RM3]::GetWindowRect($h, [ref]$r) | Out-Null
$y = $r.Top + 300
[RM3]::Drag($r.Left + 700, $y, $r.Left + 1000, $y)
"drag1 done (单行内拖拽)"

Start-Sleep -Milliseconds 300
