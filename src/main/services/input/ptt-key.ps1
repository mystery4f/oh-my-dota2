param(
  [Parameter(Mandatory = $true)][int]$Vk,
  [Parameter(Mandatory = $true)][ValidateSet('down', 'up')][string]$Action
)

$ErrorActionPreference = 'Stop'

# Hold/release the game push-to-talk key with raw SendInput. The voice-out test
# needs the key HELD for seconds, so this is one event per invocation: the main
# process spawns "down" before playback starts and "up" after it ends.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PttKey
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, INPUT[] p, int cb);

    const uint KEYUP = 0x0002;

    public static uint Send(ushort vk, uint flags)
    {
        INPUT[] buffer = new INPUT[1];
        buffer[0].type = 1;
        buffer[0].u.ki = new KEYBDINPUT
        {
            wVk = vk,
            wScan = 0,
            dwFlags = flags,
            time = 0,
            dwExtraInfo = IntPtr.Zero
        };
        return SendInput(1, buffer, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@

$flags = 0
if ($Action -eq 'up') { $flags = 0x0002 }
# Windows PowerShell 5.1 on recent builds (26100+) dropped the [ushort]/[short]
# accelerators; [uint16]/[int16] resolve on every version. The short name dies
# with TypeNotFound right on the Send call. PS1 must stay pure ASCII (AGENTS.md).
$sent = [PttKey]::Send([uint16]$Vk, $flags)
if ($sent -ne 1)
{
    Write-Output ('SENDFAIL sent=' + $sent + ' err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    exit 4
}
Write-Output ('OK action=' + $Action + ' vk=' + $Vk)
