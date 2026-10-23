[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('vt', 'win32')] [string] $Mode,
    [Parameter(Mandatory)] [string] $Output,
    [ValidateRange(1, 100)] [int] $StopAfter = 4
)

$ErrorActionPreference = 'Stop'
$resolvedOutput = [IO.Path]::GetFullPath($Output)
$readyPath = "$resolvedOutput.ready"
$statusPath = "$resolvedOutput.status.json"
$errorPath = "$resolvedOutput.startup-error.txt"
$parent = [IO.Path]::GetDirectoryName($resolvedOutput)
if (-not [IO.Directory]::Exists($parent)) { [void][IO.Directory]::CreateDirectory($parent) }
if ([IO.File]::Exists($readyPath)) { [IO.File]::Delete($readyPath) }
if ([IO.File]::Exists($errorPath)) { [IO.File]::Delete($errorPath) }
function Set-RecorderStage([string] $Stage, [string] $ErrorText = '') {
    $state = [ordered]@{ stage = $Stage; mode = $Mode; pid = $PID; at = [DateTimeOffset]::UtcNow.ToString('O') }
    if ($ErrorText) { $state.error = $ErrorText }
    [IO.File]::WriteAllText($statusPath, ($state | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if ($ErrorText) { [IO.File]::WriteAllText($errorPath, $ErrorText, [Text.UTF8Encoding]::new($false)) }
}

Set-RecorderStage 'before-add-type'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ProbeRecorderNative {
  public const int STD_INPUT_HANDLE = -10;
  public const uint ENABLE_LINE_INPUT = 0x0002;
  public const uint ENABLE_ECHO_INPUT = 0x0004;
  public const uint ENABLE_PROCESSED_INPUT = 0x0001;
  public const uint ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
  public const ushort KEY_EVENT = 0x0001;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct KeyEventRecord {
    public int KeyDown;
    public ushort RepeatCount;
    public ushort VirtualKeyCode;
    public ushort VirtualScanCode;
    [MarshalAs(UnmanagedType.U2)] public char UnicodeChar;
    public uint ControlKeyState;
  }

  [StructLayout(LayoutKind.Explicit, Size = 20)] public struct InputRecord {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KeyEventRecord Key;
  }

  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr handle, uint mode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadFile(IntPtr handle, byte[] buffer, uint count, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadConsoleInputW(IntPtr handle, out InputRecord record, uint length, out uint read);

  public static int KeyEventRecordSize() => Marshal.SizeOf(typeof(KeyEventRecord));
  public static int KeyUnicodeOffset() => Marshal.OffsetOf(typeof(KeyEventRecord), "UnicodeChar").ToInt32();
  public static int KeyControlStateOffset() => Marshal.OffsetOf(typeof(KeyEventRecord), "ControlKeyState").ToInt32();
  public static int InputRecordSize() => Marshal.SizeOf(typeof(InputRecord));
  public static int InputRecordKeyOffset() => Marshal.OffsetOf(typeof(InputRecord), "Key").ToInt32();
}
'@
    Set-RecorderStage 'after-add-type'
} catch {
    Set-RecorderStage 'startup-error:add-type' $_.Exception.ToString()
    throw
}

$abi = @{
    keySize = [ProbeRecorderNative]::KeyEventRecordSize()
    unicodeOffset = [ProbeRecorderNative]::KeyUnicodeOffset()
    controlStateOffset = [ProbeRecorderNative]::KeyControlStateOffset()
    inputSize = [ProbeRecorderNative]::InputRecordSize()
    keyOffset = [ProbeRecorderNative]::InputRecordKeyOffset()
}
if ($abi.keySize -ne 16 -or $abi.unicodeOffset -ne 10 -or $abi.controlStateOffset -ne 12 -or $abi.inputSize -ne 20 -or $abi.keyOffset -ne 4) {
    $reason = "Unexpected Win32 INPUT_RECORD layout: $(($abi | ConvertTo-Json -Compress))"
    Set-RecorderStage 'startup-error:abi' $reason
    throw $reason
}
Set-RecorderStage 'abi-validated'

$inputHandle = [ProbeRecorderNative]::GetStdHandle([ProbeRecorderNative]::STD_INPUT_HANDLE)
[uint32]$consoleMode = 0
Set-RecorderStage 'before-get-console-mode'
if ($inputHandle -eq [IntPtr]::Zero -or -not [ProbeRecorderNative]::GetConsoleMode($inputHandle, [ref]$consoleMode)) {
    $reason = 'ProbeRecorder requires a Windows console or ConPTY input handle.'
    Set-RecorderStage 'startup-error:get-console-mode' $reason
    throw $reason
}
Set-RecorderStage 'console-mode-read'

if ($Mode -eq 'vt') {
    $nextMode = ($consoleMode -band (-bnot ([ProbeRecorderNative]::ENABLE_LINE_INPUT -bor [ProbeRecorderNative]::ENABLE_ECHO_INPUT -bor [ProbeRecorderNative]::ENABLE_PROCESSED_INPUT))) -bor [ProbeRecorderNative]::ENABLE_VIRTUAL_TERMINAL_INPUT
} else {
    $nextMode = $consoleMode -band (-bnot [ProbeRecorderNative]::ENABLE_VIRTUAL_TERMINAL_INPUT)
}
$modeChanged = $false
$encoderChanged = $false
$writer = $null
try {
    Set-RecorderStage 'before-set-console-mode'
    if (-not [ProbeRecorderNative]::SetConsoleMode($inputHandle, [uint32]$nextMode)) { throw "SetConsoleMode failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    $modeChanged = $true
    Set-RecorderStage 'console-mode-set'
    $writer = [IO.StreamWriter]::new($resolvedOutput, $false, [Text.UTF8Encoding]::new($false))
    $writer.AutoFlush = $true
    Set-RecorderStage 'output-open'
    if ($Mode -eq 'win32') { [Console]::Out.Write("`e[?9001h") } else { [Console]::Out.Write("`e[?9001l") }
    [Console]::Out.Flush()
    $encoderChanged = $true
    [Console]::WriteLine("PROBE_RECORDER_READY mode=$Mode")
    [Console]::Out.Flush()
    [IO.File]::WriteAllText($readyPath, "mode=$Mode pid=$PID ready=$(Get-Date -Format o)", [Text.UTF8Encoding]::new($false))
    Set-RecorderStage 'ready'

    for ($index = 0; $index -lt $StopAfter; $index++) {
        Set-RecorderStage "reading-input:$index"
        if ($Mode -eq 'vt') {
            $buffer = [byte[]]::new(1)
            [uint32]$read = 0
            if (-not [ProbeRecorderNative]::ReadFile($inputHandle, $buffer, 1, [ref]$read, [IntPtr]::Zero)) { throw "ReadFile failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
            if ($read -ne 1) { throw 'ReadFile returned no input byte.' }
            $record = [ordered]@{ kind = 'vt-byte'; mode = $Mode; index = $index; hex = ('{0:X2}' -f $buffer[0]); value = [int]$buffer[0]; at = [DateTimeOffset]::UtcNow.ToString('O') }
        } else {
            $inputRecord = [ProbeRecorderNative+InputRecord]::new()
            [uint32]$read = 0
            do {
                if (-not [ProbeRecorderNative]::ReadConsoleInputW($inputHandle, [ref]$inputRecord, 1, [ref]$read)) { throw "ReadConsoleInputW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
                if ($read -ne 1) { throw 'ReadConsoleInputW returned no record.' }
            } while ($inputRecord.EventType -ne [ProbeRecorderNative]::KEY_EVENT)
            $key = $inputRecord.Key
            $record = [ordered]@{ kind = 'key-record'; mode = $Mode; index = $index; keyDown = ($key.KeyDown -ne 0); repeatCount = [int]$key.RepeatCount; vk = [int]$key.VirtualKeyCode; scan = [int]$key.VirtualScanCode; unicode = [string]$key.UnicodeChar; unicodeCode = [int][char]$key.UnicodeChar; controlState = [int]$key.ControlKeyState; at = [DateTimeOffset]::UtcNow.ToString('O') }
        }
        $writer.WriteLine(($record | ConvertTo-Json -Compress))
    }
    Set-RecorderStage 'complete'
} catch {
    Set-RecorderStage 'runtime-error' $_.Exception.ToString()
    throw
} finally {
    if ($writer) { try { $writer.Dispose() } catch { [Console]::Error.WriteLine("Could not close recorder output: $_") } }
    if ($encoderChanged) {
        try { [Console]::Out.Write("`e[?9001l"); [Console]::Out.Flush() } catch { [Console]::Error.WriteLine("Could not reset terminal encoder mode: $_") }
    }
    if ([IO.File]::Exists($readyPath)) { try { [IO.File]::Delete($readyPath) } catch { [Console]::Error.WriteLine("Could not remove recorder readiness sentinel: $_") } }
    if ($modeChanged -and -not [ProbeRecorderNative]::SetConsoleMode($inputHandle, $consoleMode)) {
        [Console]::Error.WriteLine("Could not restore console input mode: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())")
    }
}
