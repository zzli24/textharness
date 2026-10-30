param([string]$Theme = 'dark', [string]$Out = 'shot.png')

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ShotHelper {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      RECT r; GetWindowRect(h, out r);
      if (t.ToString() == title && (r.Right - r.Left) > 800) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[ShotHelper]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing

$h = [ShotHelper]::Find('TextHarness')
if ($h -eq [IntPtr]::Zero) { "找不到窗口"; exit 1 }
$rect = New-Object ShotHelper+RECT
[ShotHelper]::GetWindowRect($h, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left; $hh = $rect.Bottom - $rect.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[ShotHelper]::PrintWindow($h, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"saved $Out (${w}x${hh}) theme=$Theme"
