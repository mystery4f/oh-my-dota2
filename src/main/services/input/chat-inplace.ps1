param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SaiInput {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static int PidOf(IntPtr hWnd) { uint pid = 0; GetWindowThreadProcessId(hWnd, out pid); return (int)pid; }
  const uint KEYUP = 0x0002;
  static void Send(ushort vk, uint flags) {
    INPUT[] a = new INPUT[1];
    a[0].type = 1;
    a[0].u.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Tap(ushort vk, int holdMs, int gapMs) {
    Send(vk, 0); System.Threading.Thread.Sleep(holdMs);
    Send(vk, KEYUP); System.Threading.Thread.Sleep(gapMs);
  }
  public static void Combo(ushort mod, ushort key, int holdMs, int gapMs) {
    Send(mod, 0); System.Threading.Thread.Sleep(holdMs);
    Send(key, 0); System.Threading.Thread.Sleep(holdMs);
    Send(key, KEYUP); System.Threading.Thread.Sleep(holdMs);
    Send(mod, KEYUP); System.Threading.Thread.Sleep(gapMs);
  }
  public static IntPtr Fg() { return GetForegroundWindow(); }
}
public class SaiClip {
  [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseClipboard();
  [DllImport("user32.dll", SetLastError = true)] static extern bool EmptyClipboard();
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetClipboardData(uint uFormat);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr hMem);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr hMem);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr hMem);
  const uint CF_UNICODETEXT = 13;
  const uint GMEM_MOVEABLE = 0x0002;
  static bool Open(int tries) {
    for (int i = 0; i < tries; i++) {
      if (OpenClipboard(IntPtr.Zero)) return true;
      System.Threading.Thread.Sleep(15);
    }
    return false;
  }
  public static bool SetText(string text) {
    if (!Open(20)) return false;
    try {
      if (!EmptyClipboard()) return false;
      byte[] data = System.Text.Encoding.Unicode.GetBytes(text + "\0");
      IntPtr h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)data.Length);
      if (h == IntPtr.Zero) return false;
      IntPtr p = GlobalLock(h);
      if (p == IntPtr.Zero) { GlobalFree(h); return false; }
      Marshal.Copy(data, 0, p, data.Length);
      GlobalUnlock(h);
      if (SetClipboardData(CF_UNICODETEXT, h) == IntPtr.Zero) { GlobalFree(h); return false; }
      return true;
    } finally { CloseClipboard(); }
  }
  public static string GetText() {
    if (!Open(20)) return null;
    try {
      IntPtr h = GetClipboardData(CF_UNICODETEXT);
      if (h == IntPtr.Zero) return string.Empty;
      IntPtr p = GlobalLock(h);
      if (p == IntPtr.Zero) return string.Empty;
      string s = Marshal.PtrToStringUni(p) ?? string.Empty;
      GlobalUnlock(h);
      return s;
    } finally { CloseClipboard(); }
  }
}
'@
$SENTINEL = '__oh_my_dota2_probe__'
# Panorama renders at ~16 ms per frame, so holding HOLD_MS and spacing GAP_MS is enough.
# Tune only these two: grab retries slower once when the first combo is dropped (retried flag).
$HOLD_MS = 20
$GAP_MS = 25
function Write-Resp($payload) {
  $json = $payload | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
function Get-GameWindow {
  $proc = Get-Process -Name dota2 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) { return [IntPtr]::Zero }
  return $proc.MainWindowHandle
}
Write-Resp @{ event = 'ready' }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $op = [string]$req.op
  $id = $req.id
  if ($op -eq 'ping') { Write-Resp @{ id = $id; ok = $true }; continue }
  # Foreground probe for the capture loop: tells whether dota2 runs and owns the
  # foreground window, so the app can skip grabbing a browser instead of OCR-ing it.
  if ($op -eq 'focus') {
    $tFg = [Environment]::TickCount
    $games = @(Get-Process -Name dota2 -ErrorAction SilentlyContinue)
    $handle = [IntPtr]::Zero
    $withWindow = $games | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($withWindow) { $handle = $withWindow.MainWindowHandle }
    $fgHandle = [SaiInput]::Fg()
    $fgPid = 0
    if ($fgHandle -ne [IntPtr]::Zero) { $fgPid = [SaiInput]::PidOf($fgHandle) }
    # Decide by process id, not by window handle: a Source 2 game does not always
    # expose the focused window as MainWindowHandle, so comparing handles lied.
    $focused = $false
    foreach ($g in $games) { if ($g.Id -eq $fgPid) { $focused = $true } }
    Write-Resp @{ id = $id; ok = $true; gameRunning = ($games.Count -gt 0); focused = $focused; fg = $fgHandle.ToInt64(); fgPid = $fgPid; win = $handle.ToInt64(); lookupMs = [Environment]::TickCount - $tFg }
    continue
  }

  $tLookup = [Environment]::TickCount
  $win = Get-GameWindow
  $lookupMs = [Environment]::TickCount - $tLookup
  if ($win -eq [IntPtr]::Zero) { Write-Resp @{ id = $id; ok = $false; code = 'NOGAME'; lookupMs = $lookupMs }; continue }

  if ([SaiInput]::Fg() -ne $win) {
    Write-Resp @{ id = $id; ok = $false; code = 'NOFOCUS'; lookupMs = $lookupMs; fg = [SaiInput]::Fg().ToInt64(); win = $win.ToInt64() }
    continue
  }

  if ($op -eq 'grab') {
    $tClip = [Environment]::TickCount
    $wrote = [SaiClip]::SetText($SENTINEL)
    $clipSetMs = [Environment]::TickCount - $tClip
    if (-not $wrote) { Write-Resp @{ id = $id; ok = $false; code = 'CLIPBUSY'; lookupMs = $lookupMs; clipSetMs = $clipSetMs }; continue }
    Start-Sleep -Milliseconds 20
    $tKeys = [Environment]::TickCount
    [SaiInput]::Combo(0x11, 0x41, $HOLD_MS, $GAP_MS)
    [SaiInput]::Combo(0x11, 0x43, $HOLD_MS, $GAP_MS)
    $keysMs = [Environment]::TickCount - $tKeys
    Start-Sleep -Milliseconds 20
    $text = [SaiClip]::GetText()
    $retried = $false
    if ($null -eq $text -or [string]::IsNullOrWhiteSpace($text) -or $text -eq $SENTINEL) {
      # First combo can be dropped after an alt-tab or a frame drop: retry slower once instead of
      # reporting an empty chat box just because nothing got selected.
      $retried = $true
      $tRetry = [Environment]::TickCount
      [SaiInput]::Combo(0x11, 0x41, 45, 70)
      [SaiInput]::Combo(0x11, 0x43, 45, 90)
      $keysMs = $keysMs + ([Environment]::TickCount - $tRetry)
      Start-Sleep -Milliseconds 60
      $text = [SaiClip]::GetText()
    }
    if ($null -eq $text) { Write-Resp @{ id = $id; ok = $false; code = 'CLIPBUSY'; lookupMs = $lookupMs; clipSetMs = $clipSetMs; keysMs = $keysMs; retried = $retried }; continue }
    if ([string]::IsNullOrWhiteSpace($text) -or $text -eq $SENTINEL) { Write-Resp @{ id = $id; ok = $false; code = 'NOCONTENT'; lookupMs = $lookupMs; clipSetMs = $clipSetMs; keysMs = $keysMs; retried = $retried }; continue }
    Write-Resp @{ id = $id; ok = $true; text = $text; lookupMs = $lookupMs; clipSetMs = $clipSetMs; keysMs = $keysMs; retried = $retried }
    # Clearing the chat box runs after the response: the next request only arrives once
    # translation finishes, which is plenty of time.
    [SaiInput]::Combo(0x11, 0x41, 30, 50)
    [SaiInput]::Tap(0x2E, 30, 50)
    continue
  }

  if ($op -eq 'send') {
    $content = [string]$req.text
    if ([string]::IsNullOrEmpty($content)) { Write-Resp @{ id = $id; ok = $false; code = 'EMPTY' }; continue }
    $tClip = [Environment]::TickCount
    $wrote = [SaiClip]::SetText($content)
    $clipSetMs = [Environment]::TickCount - $tClip
    if (-not $wrote) { Write-Resp @{ id = $id; ok = $false; code = 'CLIPBUSY'; lookupMs = $lookupMs; clipSetMs = $clipSetMs }; continue }
    Start-Sleep -Milliseconds 20
    $tKeys = [Environment]::TickCount
    [SaiInput]::Combo(0x11, 0x41, $HOLD_MS, $GAP_MS)
    [SaiInput]::Combo(0x11, 0x56, $HOLD_MS, $GAP_MS)
    # Pasting lands asynchronously, so give the text a moment before pressing Enter.
    Start-Sleep -Milliseconds 40
    [SaiInput]::Tap(0x0D, 20, 0)
    $keysMs = [Environment]::TickCount - $tKeys
    Write-Resp @{ id = $id; ok = $true; lookupMs = $lookupMs; clipSetMs = $clipSetMs; keysMs = $keysMs; retried = $false }
    Start-Sleep -Milliseconds 100
    continue
  }

  Write-Resp @{ id = $id; ok = $false; code = 'BADOP' }
}
