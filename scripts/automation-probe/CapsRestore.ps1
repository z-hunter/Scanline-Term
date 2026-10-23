param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$artifactPath = Join-Path $root 'output\automation-probe\caps-restore.json'
New-Item -ItemType Directory -Force -Path (Split-Path $artifactPath) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path (Join-Path $PSScriptRoot 'HookProbeNative.cs')
$bindingErrors = [HookProbeNative]::CheckBindings()
if ($bindingErrors.Count) { throw ($bindingErrors -join '; ') }

$title = 'Scanline Term Caps Restore Probe'
$state = [ordered]@{
    status = 'fail'; action = 'none'; initialCaps = $null; finalCaps = $null; sendInput = $null
    target = $null; uiThread = $null; error = $null; cleanup = 'pending'
}
$window = [System.Windows.Forms.Form]::new()
$window.Text = $title
$window.Width = 460
$window.Height = 150
$window.KeyPreview = $true
$window.TopMost = $true
$window.Controls.Add([System.Windows.Forms.Label]::new())
$window.Controls[0].Dock = [System.Windows.Forms.DockStyle]::Fill
$window.Controls[0].TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$window.Controls[0].Text = 'Disposable CapsLock restore probe. No terminal or release app input.'
$events = [System.Collections.Generic.List[object]]::new()
$uiState = @{ caps = $null; threadId = $null; keyDowns = 0; keyUps = 0; lastKey = '' }

$window.add_KeyDown({
    $uiState.keyDowns++
    $uiState.lastKey = $_.KeyCode.ToString()
    $uiState.caps = ([HookProbeNative]::GetKeyState(0x14) -band 1)
    $events.Add(@{ type = 'down'; key = $uiState.lastKey; caps = $uiState.caps; threadId = [HookProbeNative]::GetCurrentThreadId() })
})
$window.add_KeyUp({
    $uiState.keyUps++
    $uiState.lastKey = $_.KeyCode.ToString()
    $uiState.caps = ([HookProbeNative]::GetKeyState(0x14) -band 1)
    $events.Add(@{ type = 'up'; key = $uiState.lastKey; caps = $uiState.caps; threadId = [HookProbeNative]::GetCurrentThreadId() })
})
$window.add_Shown({
    try {
        # Refuse to inject while any owned Scanline Term dev process/hook is alive.
        $devProcesses = @(Get-Process -Name scanline_term -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
        if ($devProcesses.Count) { throw 'Owned Scanline Term dev process is still running; refusing cleanup input until its hook is gone' }

        $hwnd = $window.Handle
        $windowPid = [uint32]0
        $windowThread = [HookProbeNative]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
        $actualTitle = [Text.StringBuilder]::new(256)
        [void][HookProbeNative]::GetWindowText($hwnd, $actualTitle, $actualTitle.Capacity)
        $uiState.threadId = [HookProbeNative]::GetCurrentThreadId()
        if ($windowPid -ne $PID -or $actualTitle.ToString() -cne $title -or $windowThread -ne $uiState.threadId) { throw 'Disposable helper HWND/PID/UI-thread identity check failed' }

        $focus = [HookProbeNative]::FocusOwnedWindow($hwnd)
        if (-not $focus.Success -or [HookProbeNative]::GetForegroundWindow() -ne $hwnd) { throw "Could not focus exact disposable helper window: $($focus | ConvertTo-Json -Compress)" }
        $state.target = @{ hwnd = ('0x{0:X}' -f $hwnd.ToInt64()); pid = $windowPid; title = $actualTitle.ToString(); threadId = $windowThread; exactForeground = $true }
        Start-Sleep -Milliseconds 100
        $before = ([HookProbeNative]::GetKeyState(0x14) -band 1)
        $uiState.caps = $before
        $state.initialCaps = $before
        $state.uiThread = @{ threadId = $uiState.threadId; initialKeyState = $before }

        if ($before -eq 1) {
            # Recheck exact helper HWND/PID immediately before one normal, unhooked CapsLock pair.
            $foreground = [HookProbeNative]::GetForegroundWindow()
            $foregroundPid = [uint32]0
            [void][HookProbeNative]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
            if ($foreground -ne $hwnd -or $foregroundPid -ne $PID) { throw 'Refusing cleanup input: exact helper is no longer foreground' }
            $inputs = [HookProbeNative+Input[]]::new(2)
            $inputs[0] = [HookProbeNative]::MakeVirtualKeyInput(0x14, $false, [UIntPtr]::Zero)
            $inputs[1] = [HookProbeNative]::MakeVirtualKeyInput(0x14, $true, [UIntPtr]::Zero)
            if (-not [HookProbeNative]::MatchesVirtualKey($inputs[0], 0x14, $false, [UIntPtr]::Zero) -or -not [HookProbeNative]::MatchesVirtualKey($inputs[1], 0x14, $true, [UIntPtr]::Zero)) { throw 'Caps cleanup INPUT round-trip failed' }
            if ([HookProbeNative]::GetForegroundWindow() -ne $hwnd) { throw 'Helper lost foreground before SendInput; no input sent' }
            $sent = [HookProbeNative]::SendInput(2, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][HookProbeNative+Input]))
            $state.action = 'one unhooked CapsLock down/up pair to own WinForms helper'
            $state.sendInput = @{ returned = $sent; requested = 2; marker = '0x0'; rawDownFlags = [HookProbeNative]::ReadKeyboard($inputs[0]).Flags; rawUpFlags = [HookProbeNative]::ReadKeyboard($inputs[1]).Flags }
            if ($sent -ne 2) { throw "SendInput inserted $sent of 2 cleanup events" }
        }
        # Pump this same UI thread until it observes the queued key events and the final lock state.
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            [System.Windows.Forms.Application]::DoEvents()
            $uiState.caps = ([HookProbeNative]::GetKeyState(0x14) -band 1)
            if ($state.initialCaps -eq 0 -or ($uiState.caps -eq 0 -and $uiState.keyDowns -gt 0 -and $uiState.keyUps -gt 0)) { break }
            Start-Sleep -Milliseconds 20
        } while ([DateTime]::UtcNow -lt $deadline)
        $state.finalCaps = $uiState.caps
        $state.uiThread.keyDowns = $uiState.keyDowns
        $state.uiThread.keyUps = $uiState.keyUps
        $state.uiThread.lastKey = $uiState.lastKey
        $state.events = @($events)
        if ($state.finalCaps -eq 0 -and ($state.initialCaps -eq 0 -or ($uiState.keyDowns -gt 0 -and $uiState.keyUps -gt 0))) {
            $state.status = 'pass'
        } else {
            $state.error = "Helper UI thread did not confirm CapsLock OFF with a complete pair (caps=$($state.finalCaps), downs=$($uiState.keyDowns), ups=$($uiState.keyUps))"
        }
        $window.Close()
    } catch {
        $state.error = $_.Exception.Message
        $window.Close()
    }
})
try {
    [System.Windows.Forms.Application]::Run($window)
} catch {
    if (-not $state.error) { $state.error = $_.Exception.Message }
} finally {
    $state.cleanup = 'disposable WinForms helper closed'
    $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $artifactPath -Encoding utf8
}
Get-Content -LiteralPath $artifactPath -Raw
if ($state.status -ne 'pass') { throw "Caps restore helper failed (artifact: $artifactPath)" }
