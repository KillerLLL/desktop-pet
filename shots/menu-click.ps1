param(
  [Parameter(Mandatory=$true)][int]$ItemY,   # menu item Y offset (window-relative, menu open)
  [string]$OutFile = "",
  [string]$DebugFile = ""
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Pet2 {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
function Get-Rect {
  $h = [Pet2]::FindWindowW("Chrome_WidgetWin_1", "Desktop Pet")
  if ($h -eq [IntPtr]::Zero) { throw "window not found" }
  $r = New-Object Pet2+RECT
  [Pet2]::GetWindowRect($h, [ref]$r) | Out-Null
  return $r
}
function Save-Shot($r, $file) {
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
  $g.Dispose()
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
# 1. right-click on the cat
$r = Get-Rect
[Pet2]::SetCursorPos($r.Left + 120, $r.Top + 260) | Out-Null
Start-Sleep -Milliseconds 150
[Pet2]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
[Pet2]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
# 2. poll until the window expands (menu opened => taller rect)
$opened = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 100
  $r2 = Get-Rect
  if (($r2.Bottom - $r2.Top) -gt 400) { $opened = $true; break }
}
$r2 = Get-Rect
if ($DebugFile -ne "") { Save-Shot $r2 $DebugFile }
Write-Output "menu-opened=$opened rect=($($r2.Left),$($r2.Top),$($r2.Right),$($r2.Bottom))"
# 3. click the menu item (offsets relative to the EXPANDED rect)
if ($opened) {
  [Pet2]::SetCursorPos($r2.Left + 100, $r2.Top + $ItemY) | Out-Null
  Start-Sleep -Milliseconds 150
  [Pet2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [Pet2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 600
  $r3 = Get-Rect
  if ($OutFile -ne "") { Save-Shot $r3 $OutFile }
  Write-Output "clicked item, rect=($($r3.Left),$($r3.Top),$($r3.Right),$($r3.Bottom))"
}
