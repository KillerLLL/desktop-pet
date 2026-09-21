param(
  [string]$OutFile = "$(Split-Path -Parent $MyInvocation.MyCommand.Path)\pet.png",
  [int]$Pad = 0
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [Win32Cap]::FindWindowW("Chrome_WidgetWin_1", "Desktop Pet")
if ($h -eq [IntPtr]::Zero) { throw "window not found" }
$r = New-Object Win32Cap+RECT
[Win32Cap]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left + 2 * $Pad
$hh = $r.Bottom - $r.Top + 2 * $Pad
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left - $Pad, $r.Top - $Pad, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
$g.Dispose()
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $OutFile rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom))"
