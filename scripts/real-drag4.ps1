param([int]$X1, [int]$Y1, [int]$X2, [int]$Y2)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RM4 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public const uint DOWN = 0x0002, UP = 0x0004;
  public static bool Focus(IntPtr h) {
    ShowWindow(h, 9);
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), 0);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    AttachThreadInput(me, fg, false);
    return GetForegroundWindow() == h;
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1);
    System.Threading.Thread.Sleep(200);
    mouse_event(DOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(120);
    for (int i = 1; i <= 16; i++) {
      SetCursorPos(x1 + (x2 - x1) * i / 16, y1 + (y2 - y1) * i / 16);
      System.Threading.Thread.Sleep(30);
    }
    System.Threading.Thread.Sleep(100);
    mouse_event(UP, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
$t = Get-Process TextHarness -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
$ok = [RM4]::Focus($t.MainWindowHandle)
"focus=$ok  drag ($X1,$Y1) -> ($X2,$Y2)"
[RM4]::Drag($X1, $Y1, $X2, $Y2)
