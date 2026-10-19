# Read-only desktop availability probe. No keyboard, mouse or window changes.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CompanionDesktopState {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  public static object Read() {
    var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("GetLastInputInfo failed");
    uint now = unchecked((uint)Environment.TickCount);
    double idleSeconds = unchecked(now - info.dwTime) / 1000.0;
    var desktop = OpenInputDesktop(0, false, 1);
    bool interactive = desktop != IntPtr.Zero;
    if (interactive) CloseDesktop(desktop);
    return new { interactive = interactive, idleSeconds = idleSeconds };
  }
}
'@
[CompanionDesktopState]::Read() | ConvertTo-Json -Compress
