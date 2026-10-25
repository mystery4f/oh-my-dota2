param(
  [Parameter(Mandatory = $true)][string]$TextFile
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

# The in-game chat box is a Panorama widget: it accepts a real Ctrl+V paste,
# which is far faster and quieter than typing the console command character by character.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SaiChat
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

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    const uint KEYUP = 0x0002;
    const ushort VK_SHIFT = 0x10;
    const ushort VK_CONTROL = 0x11;
    const ushort VK_MENU = 0x12;
    const ushort VK_ESCAPE = 0x1B;
    const ushort VK_RETURN = 0x0D;
    const ushort VK_V = 0x56;

    static void Send(ushort vk, uint flags)
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
        SendInput(1, buffer, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Tap(ushort vk)
    {
        Send(vk, 0);
        System.Threading.Thread.Sleep(35);
        Send(vk, KEYUP);
        System.Threading.Thread.Sleep(85);
    }

    public static bool Focus(IntPtr target)
    {
        Tap(VK_MENU);
        BringWindowToTop(target);
        SetForegroundWindow(target);
        System.Threading.Thread.Sleep(320);
        return GetForegroundWindow() == target;
    }

    public static void Escape()
    {
        Tap(VK_ESCAPE);
    }

    public static void Enter()
    {
        Tap(VK_RETURN);
    }

    public static void Paste()
    {
        Send(VK_CONTROL, 0);
        System.Threading.Thread.Sleep(40);
        Send(VK_V, 0);
        System.Threading.Thread.Sleep(55);
        Send(VK_V, KEYUP);
        System.Threading.Thread.Sleep(40);
        Send(VK_CONTROL, KEYUP);
    }
}
'@

function Read-Trimmed([string]$path)
{
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    return ([System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)).Trim()
}

$text = Read-Trimmed $TextFile
if ([string]::IsNullOrEmpty($text))
{
    Write-Output 'EMPTY'
    exit 2
}

$game = Get-Process -Name dota2 -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
if (-not $game)
{
    Write-Output 'NOGAME'
    exit 3
}

if (-not [SaiChat]::Focus($game.MainWindowHandle))
{
    Write-Output 'NOFOCUS'
    exit 4
}

# Esc first: drop any half-typed draft and close menus so Enter opens an empty chat box.
[SaiChat]::Escape()
Start-Sleep -Milliseconds 320

Set-Clipboard -Value $text
Start-Sleep -Milliseconds 150

[SaiChat]::Enter()
Start-Sleep -Milliseconds 420
[SaiChat]::Paste()
Start-Sleep -Milliseconds 220
[SaiChat]::Enter()
Start-Sleep -Milliseconds 220

Write-Output 'OK'