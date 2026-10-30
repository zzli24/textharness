Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RealMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint DOWN = 0x0002;
  public const uint UP = 0x0004;
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1);
    System.Threading.Thread.Sleep(120);
    mouse_event(DOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    int steps = 12;
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
      System.Threading.Thread.Sleep(30);
    }
    mouse_event(UP, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
$t = Get-Process TextHarness,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'TextHarness' } | Select-Object -First 1
if (-not $t) { "没有窗口"; exit 1 }
$r = New-Object RealMouse+RECT
[RealMouse]::GetWindowRect($t.MainWindowHandle, [ref]$r) | Out-Null
"window rect: $($r.Left),$($r.Top) - $($r.Right),$($r.Bottom)"
$y = $r.Top + 400
[RealMouse]::Drag($r.Left + 600, $y, $r.Left + 900, $y)
Start-Sleep -Milliseconds 400
"real drag done"
