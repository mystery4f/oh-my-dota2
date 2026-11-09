param(
  [Parameter(Mandatory = $true)][string]$Vks
)

$ErrorActionPreference = 'Stop'

# Hold detection for the voice-capture hotkey.
#
# Electron's globalShortcut reports key DOWN only; "hold to talk" needs the
# RELEASE. A low level keyboard hook would be event driven, but a hook is the
# kind of thing games and anti-cheat tools notice, while GetAsyncKeyState only
# reads state. This process watches exactly ONE chord at 25 Hz - the cost is
# noise next to the audio pipeline it drives.
#
# Protocol on stdout (one line each, flushed):
#   OK       ready
#   HOLD 1   every key of the chord is physically down
#   HOLD 0   at least one key of the chord was released
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HoldKeys
{
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
'@

$codes = @($Vks -split ',' | ForEach-Object { [int]$_ })
$last = $false
[Console]::Out.WriteLine('OK')
[Console]::Out.Flush()

while ($true)
{
    $all = $true
    foreach ($code in $codes)
    {
        if (([HoldKeys]::GetAsyncKeyState($code) -band 0x8000) -eq 0)
        {
            $all = $false
            break
        }
    }
    if ($all -ne $last)
    {
        $last = $all
        if ($all) { [Console]::Out.WriteLine('HOLD 1') } else { [Console]::Out.WriteLine('HOLD 0') }
        [Console]::Out.Flush()
    }
    Start-Sleep -Milliseconds 40
}
