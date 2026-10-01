# Real OS input and window probes for scripts/qa-real-input.mjs (Windows only).
param([string]$Action, [int]$X = 0, [int]$Y = 0, [int]$X2 = 0, [int]$Y2 = 0, [int]$MainPid = 0, [int]$Ms = 3000)
# Real OS input (SendInput via mouse_event/keybd_event, which passes through
# low-level hooks like hardware input) and window-state probes for QA.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class Q {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [StructLayout(LayoutKind.Sequential)] public struct NOTIFYICONIDENTIFIER { public uint cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem; }
  [DllImport("shell32.dll")] public static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER id, out RECT r);
  public static List<string> TrayRects(uint pid) {
    var o = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (!c.ToString().Contains("NotifyIcon") && !c.ToString().Contains("StatusTray")) return true;
      for (uint id = 0; id < 16; id++) {
        var nid = new NOTIFYICONIDENTIFIER(); nid.cbSize = (uint)Marshal.SizeOf(nid); nid.hWnd = h; nid.uID = id;
        RECT r; if (Shell_NotifyIconGetRect(ref nid, out r) == 0) o.Add(String.Format("{0}|{1}|{2},{3},{4},{5}", c, id, r.L, r.T, r.R, r.B));
      }
      return true;
    }, IntPtr.Zero);
    return o;
  }
  public static void Move(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    mouse_event(0x0001 | 0x8000 | 0x4000, (int)((x - vx) * 65535.0 / (vw - 1)), (int)((y - vy) * 65535.0 / (vh - 1)), 0, UIntPtr.Zero);
  }
  public static void Btn(uint down, uint up) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  public static List<string> Windows(uint pid) {
    var o = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if ((pid == 0 || p == pid) && IsWindowVisible(h)) {
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        RECT r; GetWindowRect(h, out r);
        if (pid != 0 || true) o.Add(String.Format("{0}|{1}|{2}|0x{3:X}|{4},{5},{6},{7}|{8}", h, c, t, GetWindowLong(h, -20), r.L, r.T, r.R, r.B, p));
      }
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
"@
function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 4 }
switch ($Action) {
  'move'   { [Q]::Move($X, $Y); Out-Json @{ ok = $true } }
  'click'  { [Q]::Move($X, $Y); Start-Sleep -Milliseconds 250; [Q]::Btn(0x0002, 0x0004); Out-Json @{ ok = $true } }
  'rclick' { [Q]::Move($X, $Y); Start-Sleep -Milliseconds 250; [Q]::Btn(0x0008, 0x0010); Out-Json @{ ok = $true } }
  'drag'   {
    [Q]::Move($X, $Y); Start-Sleep -Milliseconds 300
    [Q]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80
    for ($i = 1; $i -le 30; $i++) { [Q]::Move([int]($X + ($X2 - $X) * $i / 30), [int]($Y + ($Y2 - $Y) * $i / 30)); Start-Sleep -Milliseconds 20 }
    Start-Sleep -Milliseconds 150
    [Q]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Out-Json @{ ok = $true }
  }
  'escape' { [Q]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [Q]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero); Out-Json @{ ok = $true } }
  'windows' { Out-Json @([Q]::Windows([uint32]$MainPid)) }
  'menus'  { Out-Json @([Q]::Windows(0) | Where-Object { $_ -match '\|#32768\|' }) }
  'tray'   { Out-Json @([Q]::TrayRects([uint32]$MainPid)) }
  'pos'    { $p = New-Object Q+POINT; [Q]::GetCursorPos([ref]$p) | Out-Null; Out-Json @{ x = $p.X; y = $p.Y } }
  'sweep'  {
    # hover circles over (X,Y) for Ms while pinging the main process's windows
    $wins = @(); [Q]::EnumWindows({ param($h, $l) $p = 0; [Q]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null; if ($p -eq $MainPid -and [Q]::IsWindowVisible($h)) { $script:wins += $h }; $true }, [IntPtr]::Zero) | Out-Null
    $lat = @(); $sw = [Diagnostics.Stopwatch]::StartNew(); $i = 0
    while ($sw.ElapsedMilliseconds -lt $Ms) {
      $a = $i * 0.35; [Q]::Move([int]($X + 30 * [Math]::Cos($a)), [int]($Y + 30 * [Math]::Sin($a)))
      if ($i % 4 -eq 0 -and $wins.Count) { $t = [Diagnostics.Stopwatch]::StartNew(); $r = [IntPtr]::Zero; [Q]::SendMessageTimeout($wins[0], 0, [IntPtr]::Zero, [IntPtr]::Zero, 2, 3000, [ref]$r) | Out-Null; $lat += $t.Elapsed.TotalMilliseconds }
      Start-Sleep -Milliseconds 15; $i++
    }
    $s = $lat | Sort-Object
    Out-Json @{ moves = $i; pings = $s.Count; medianMs = [Math]::Round($s[[int]($s.Count / 2)], 2); maxMs = [Math]::Round(($s | Select-Object -Last 1), 2) }
  }
}
