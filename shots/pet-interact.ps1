param(
  [Parameter(Mandatory=$true)][string]$Op,   # rclick | lclick | move | key | capture
  [int]$X = 120,                             # offset within current window rect (X)
  [int]$Y = 260,                             # offset within current window rect (Y)
  [string]$Key = "",
  [string]$OutFile = "",
  [int]$SleepMs = 400
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Pet {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
function Get-Rect {
  $h = [Pet]::FindWindowW("Chrome_WidgetWin_1", "Desktop Pet")
  if ($h -eq [IntPtr]::Zero) { throw "window not found" }
  $r = New-Object Pet+RECT
  [Pet]::GetWindowRect($h, [ref]$r) | Out-Null
  return $r
}
switch ($Op) {
  "move"   { $r = Get-Rect; [Pet]::SetCursorPos($r.Left + $X, $r.Top + $Y) | Out-Null }
  "rclick" {
    $r = Get-Rect
    [Pet]::SetCursorPos($r.Left + $X, $r.Top + $Y) | Out-Null
    Start-Sleep -Milliseconds 120
    [Pet]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)  # RIGHTDOWN
    [Pet]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)  # RIGHTUP
  }
  "lclick" {
    $r = Get-Rect
    [Pet]::SetCursorPos($r.Left + $X, $r.Top + $Y) | Out-Null
    Start-Sleep -Milliseconds 120
    [Pet]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
    [Pet]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
  }
  "key" {
    $vk = switch ($Key) { "ESC" { 0x1B } "ENTER" { 0x0D } default { 0 } }
    if ($vk -eq 0) { throw "unknown key" }
    [Pet]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    [Pet]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  }
  "capture" {
    $r = Get-Rect
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
    $bmp = New-Object System.Drawing.Bitmap($w, $hh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
    $g.Dispose()
    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "saved $OutFile rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) size=${w}x${hh}"
  }
}
if ($SleepMs -gt 0 -and $Op -ne "capture") { Start-Sleep -Milliseconds $SleepMs }
