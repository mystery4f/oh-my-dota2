param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$KeyFile
)

$ErrorActionPreference = 'Stop'

# Raw SendInput keystrokes. SendKeys and clipboard paste are ignored by the
# Source 2 console, so every character is typed as a real virtual key press.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SaiConsole
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

    [DllImport("user32.dll")]
    public static extern IntPtr GetKeyboardLayout(uint idThread);

    [DllImport("user32.dll")]
    public static extern short VkKeyScanEx(char ch, IntPtr layout);

    const uint KEYUP = 0x0002;
    const ushort VK_SHIFT = 0x10;
    const ushort VK_MENU = 0x12;
    const ushort VK_ESCAPE = 0x1B;
    const ushort VK_RETURN = 0x0D;

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
        System.Threading.Thread.Sleep(30);
        Send(vk, KEYUP);
        System.Threading.Thread.Sleep(80);
    }

    static void TapWithShift(ushort vk, bool shift)
    {
        if (shift)
        {
            Send(VK_SHIFT, 0);
            System.Threading.Thread.Sleep(12);
        }
        Send(vk, 0);
        System.Threading.Thread.Sleep(22);
        Send(vk, KEYUP);
        if (shift)
        {
            System.Threading.Thread.Sleep(12);
            Send(VK_SHIFT, KEYUP);
        }
        System.Threading.Thread.Sleep(22);
    }

    public static bool TapChar(char ch)
    {
        IntPtr layout = GetKeyboardLayout(0);
        short mapped = VkKeyScanEx(ch, layout);
        int vk = mapped & 0xFF;
        if (vk == 0xFF || vk == 0)
        {
            return false;
        }
        TapWithShift((ushort)vk, ((mapped >> 8) & 1) != 0);
        return true;
    }

    public static bool Focus(IntPtr target)
    {
        Tap(VK_MENU);
        BringWindowToTop(target);
        SetForegroundWindow(target);
        System.Threading.Thread.Sleep(320);
        return GetForegroundWindow() == target;
    }

    public static int TypeText(string text)
    {
        IntPtr layout = GetKeyboardLayout(0);
        int unmapped = 0;
        foreach (char ch in text)
        {
            short mapped = VkKeyScanEx(ch, layout);
            int vk = mapped & 0xFF;
            if (vk == 0xFF || vk == 0)
            {
                unmapped++;
                continue;
            }
            TapWithShift((ushort)vk, ((mapped >> 8) & 1) != 0);
        }
        return unmapped;
    }

    public static void Escape()
    {
        Tap(VK_ESCAPE);
    }

    public static void Enter()
    {
        Tap(VK_RETURN);
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

$consoleKey = Read-Trimmed $KeyFile
if ([string]::IsNullOrEmpty($consoleKey)) { $consoleKey = '\' }
$consoleKey = $consoleKey.Substring(0, 1)

$game = Get-Process -Name dota2 -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
if (-not $game)
{
    Write-Output 'NOGAME'
    exit 3
}

if (-not [SaiConsole]::Focus($game.MainWindowHandle))
{
    Write-Output 'NOFOCUS'
    exit 4
}

# Esc twice clears the in-game chat box and any open menu before we press the console key.
[SaiConsole]::Escape()
Start-Sleep -Milliseconds 320
[SaiConsole]::Escape()
Start-Sleep -Milliseconds 320

if (-not [SaiConsole]::TapChar($consoleKey))
{
    Write-Output 'BADKEY'
    exit 5
}
Start-Sleep -Milliseconds 900

$unmapped = [SaiConsole]::TypeText($text)
Start-Sleep -Milliseconds 180
[SaiConsole]::Enter()
Start-Sleep -Milliseconds 320
$closed = [SaiConsole]::TapChar($consoleKey)

Write-Output ('OK unmapped=' + $unmapped)