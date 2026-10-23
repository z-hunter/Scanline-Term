[CmdletBinding(DefaultParameterSetName = 'SelfTest')]
param(
    [Parameter(ParameterSetName = 'SelfTest', Mandatory)] [switch] $SelfTest,
    [Parameter(ParameterSetName = 'Smoke', Mandatory)] [switch] $TransportSmoke,
    [Parameter(ParameterSetName = 'ProbeStress', Mandatory)] [switch] $ProbeStress,
    [Parameter(ParameterSetName = 'CallbackSmoke', Mandatory)] [switch] $CallbackSmoke,
    [Parameter(ParameterSetName = 'CapsOnlySmoke', Mandatory)] [switch] $CapsOnlySmoke,
    [Parameter(ParameterSetName = 'HookSequenceSmoke', Mandatory)] [switch] $HookSequenceSmoke,
    [Parameter(ParameterSetName = 'TerminalRecorderSmoke', Mandatory)] [switch] $TerminalRecorderSmoke,
    [Parameter(ParameterSetName = 'McpTerminalSmoke', Mandatory)] [switch] $McpTerminalSmoke,
    [Parameter(ParameterSetName = 'NvimLayoutSmoke', Mandatory)] [switch] $NvimLayoutSmoke,
    [Parameter(ParameterSetName = 'Smoke')]
    [Parameter(ParameterSetName = 'ProbeStress')]
    [Parameter(ParameterSetName = 'CallbackSmoke')]
    [Parameter(ParameterSetName = 'CapsOnlySmoke')]
    [Parameter(ParameterSetName = 'HookSequenceSmoke')]
    [Parameter(ParameterSetName = 'TerminalRecorderSmoke')]
    [Parameter(ParameterSetName = 'McpTerminalSmoke')]
    [Parameter(ParameterSetName = 'NvimLayoutSmoke')] [ValidateRange(1, 300)] [int] $TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nativePath = Join-Path $PSScriptRoot 'HookProbeNative.cs'
$debugExe = Join-Path $root 'src-tauri\target\debug\scanline_term.exe'
$windowTitle = 'Scanline Term  [dev]'
$artifactDir = Join-Path $root 'output\automation-probe'
$cdpPort = 9223
$script:pinnedWebviewHwnd = [IntPtr]::Zero

function Get-ForegroundInfo {
    $hwnd = [HookProbeNative]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { throw 'No foreground window' }
    $pidValue = [uint32]0
    $threadId = [HookProbeNative]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
    $title = [Text.StringBuilder]::new(512)
    [void][HookProbeNative]::GetWindowText($hwnd, $title, $title.Capacity)
    $gui = [HookProbeNative+GuiThreadInfo]::new()
    $gui.Size = [uint32][Runtime.InteropServices.Marshal]::SizeOf($gui)
    if (-not [HookProbeNative]::GetGUIThreadInfo($threadId, [ref]$gui)) { throw 'GetGUIThreadInfo failed' }
    $focusPid = [uint32]0
    $focusThread = [HookProbeNative]::GetWindowThreadProcessId($gui.Focus, [ref]$focusPid)
    $class = [Text.StringBuilder]::new(256)
    if ($gui.Focus -ne [IntPtr]::Zero) { [void][HookProbeNative]::GetClassName($gui.Focus, $class, $class.Capacity) }
    $focusRoot = if ($gui.Focus -eq [IntPtr]::Zero) { [IntPtr]::Zero } else { [HookProbeNative]::GetAncestor($gui.Focus, 2) }
    [pscustomobject]@{ Hwnd = $hwnd; Pid = $pidValue; ThreadId = $threadId; Title = $title.ToString(); Focus = $gui.Focus; FocusPid = $focusPid; FocusThreadId = $focusThread; FocusClass = $class.ToString(); FocusRoot = $focusRoot }
}

function Get-HwndClassName([IntPtr] $Hwnd) {
    if ($Hwnd -eq [IntPtr]::Zero) { return '' }
    $class = [Text.StringBuilder]::new(256)
    [void][HookProbeNative]::GetClassName($Hwnd, $class, $class.Capacity)
    return $class.ToString()
}

function Convert-HklToUInt64([IntPtr] $Hkl) {
    if ([IntPtr]::Size -eq 8) { return [BitConverter]::ToUInt64([BitConverter]::GetBytes($Hkl.ToInt64()), 0) }
    return [uint64][uint32]$Hkl.ToInt32()
}

function Assert-DevTarget([int] $ExpectedPid) {
    $target = Get-ForegroundInfo
    if ($target.Title -cne $windowTitle -or $target.Pid -ne $ExpectedPid) { throw "Refusing input: foreground is '$($target.Title)' PID $($target.Pid), expected '$windowTitle' PID $ExpectedPid" }
    $process = Get-Process -Id $ExpectedPid -ErrorAction Stop
    if (-not [string]::Equals($process.Path, $debugExe, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing input: foreground image '$($process.Path)' is not the debug executable '$debugExe'" }
    $hwndInside = $target.Focus -eq $target.Hwnd -or [HookProbeNative]::IsChild($target.Hwnd, $target.Focus) -or $target.FocusRoot -eq $target.Hwnd
    $pinnedHostInside = $script:pinnedWebviewHwnd -eq [IntPtr]::Zero -or $target.Focus -eq $script:pinnedWebviewHwnd -or [HookProbeNative]::IsChild($script:pinnedWebviewHwnd, $target.Focus)
    $processes = Get-CimInstance Win32_Process
    $byId = @{}; foreach ($item in $processes) { $byId[[int]$item.ProcessId] = $item }
    $parentPid = [int]$target.FocusPid
    $focusProcessInside = $parentPid -eq $ExpectedPid
    for ($depth = 0; $depth -lt 16 -and -not $focusProcessInside -and $byId.ContainsKey($parentPid); $depth++) {
        $parentPid = [int]$byId[$parentPid].ParentProcessId
        $focusProcessInside = $parentPid -eq $ExpectedPid
    }
    if ($target.Focus -eq [IntPtr]::Zero -or $target.FocusClass -notlike 'Chrome_WidgetWin_*' -or -not $hwndInside -or -not $focusProcessInside -or -not $pinnedHostInside) { throw "Refusing input: focus is outside exact foreground dev HWND/PID or pinned main WebView host (focus class '$($target.FocusClass)', PID $($target.FocusPid), root 0x$('{0:X}' -f $target.FocusRoot.ToInt64()), hwndChild=$hwndInside, processChild=$focusProcessInside, pinnedHost=$pinnedHostInside)" }
    $target | Add-Member -NotePropertyName FocusIsChild -NotePropertyValue $hwndInside
    $target | Add-Member -NotePropertyName FocusProcessDescendant -NotePropertyValue $focusProcessInside
    $target | Add-Member -NotePropertyName FocusPinnedHost -NotePropertyValue $pinnedHostInside
    return $target
}

function Invoke-Cdp([string] $Action, [string] $Argument = $null) {
    $env:STERM_PROBE_CDP_PORT = [string]$cdpPort
    if ($null -eq $Argument) { $output = & node (Join-Path $PSScriptRoot 'cdp.mjs') $Action 2>&1 }
    else { $output = & node (Join-Path $PSScriptRoot 'cdp.mjs') $Action $Argument 2>&1 }
    if ($LASTEXITCODE -ne 0) { throw "CDP action '$Action' failed: $output" }
    return ($output -join "`n") | ConvertFrom-Json
}

function Start-McpClient {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command node.exe -ErrorAction Stop).Source
    $start.ArgumentList.Add((Join-Path $PSScriptRoot 'mcp-client.mjs'))
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Could not start the debug MCP stdio bridge' }
    $process.BeginErrorReadLine()
    $script:mcpClient = $process
    $script:mcpClientPid = $process.Id
    return [pscustomobject]@{ pid = $process.Id; image = $start.FileName; sidecar = Join-Path $root 'src-tauri\target\debug\scanline-term-mcp.exe'; pipe = 'scanline-term-mcp-dev' }
}

function Invoke-Mcp([string] $Name, [hashtable] $Arguments) {
    if (-not $script:mcpClient -or $script:mcpClient.HasExited) { throw 'Debug MCP bridge is not alive' }
    $request = @{ name = $Name; arguments = $Arguments } | ConvertTo-Json -Compress -Depth 12
    $script:mcpClient.StandardInput.WriteLine($request)
    $replyTask = $script:mcpClient.StandardOutput.ReadLineAsync()
    if (-not $replyTask.Wait(15000)) { throw "MCP $Name timed out waiting for one JSON response" }
    $reply = $replyTask.Result | ConvertFrom-Json
    if (-not $reply.ok) { throw "MCP $Name failed: $($reply.error)" }
    return $reply.result
}

function Wait-McpAvailable([int] $Seconds = 12) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $lastError = $null
    do {
        try { return Invoke-Mcp 'list_terminals' @{} }
        catch { $lastError = $_.Exception.Message; Start-Sleep -Milliseconds 300 }
    } while ([DateTime]::UtcNow -lt $deadline)
    try { $script:mcpStartupDiagnostics = (Invoke-Cdp 'startupDiagnostics').result } catch { $script:mcpStartupDiagnostics = @{ collectError = $_.Exception.Message } }
    throw "Debug MCP named pipe never became ready within ${Seconds}s: $lastError"
}

function Get-McpHandle($Result) {
    foreach ($candidate in @($Result.handle, $Result.terminal.handle, $Result.id)) {
        if ($candidate -is [string] -and $candidate.Length -gt 0) { return $candidate }
    }
    throw "MCP create_terminal returned no handle: $($Result | ConvertTo-Json -Compress -Depth 8)"
}

function Observe-McpReady([string] $Handle, [string] $ReadyText, [int] $Seconds = 15) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $last = $null
    do {
        $last = Invoke-Mcp 'observe_terminal' @{ handle = $Handle; timeoutMs = 800; quietMs = 100; includeScrollback = $true }
        $json = $last | ConvertTo-Json -Compress -Depth 15
        if ($json.Contains($ReadyText, [StringComparison]::Ordinal)) { return $last }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for terminal readiness '$ReadyText': $($last | ConvertTo-Json -Compress -Depth 8)"
}

function New-KeyInput($Spec, [UIntPtr] $Marker) {
    if ($Spec.Kind -eq 'Unicode') { return [HookProbeNative]::MakeUnicodeInput([char]$Spec.TextChar, [bool]$Spec.Up, $Marker) }
    if ($Spec.Kind -eq 'Scan') { return [HookProbeNative]::MakeScanCodeInput([uint16]$Spec.ScanCode, [bool]$Spec.Up, $Marker) }
    return [HookProbeNative]::MakeVirtualKeyInput([uint16]$Spec.VirtualKey, [bool]$Spec.Up, $Marker)
}

function Send-ProbeText([int] $ExpectedPid, [string] $Text, [UIntPtr] $Marker, [Collections.Generic.List[object]] $Log) {
    $keys = [Collections.Generic.List[object]]::new()
    $letterScans = @{ a=0x1E; b=0x30; c=0x2E; d=0x20; e=0x12; f=0x21; g=0x22; h=0x23; i=0x17; j=0x24; k=0x25; l=0x26; m=0x32; n=0x31; o=0x18; p=0x19; q=0x10; r=0x13; s=0x1F; t=0x14; u=0x16; v=0x2F; w=0x11; x=0x2D; y=0x15; z=0x2C }
    $digitScans = @{ '1'=0x02; '2'=0x03; '3'=0x04; '4'=0x05; '5'=0x06; '6'=0x07; '7'=0x08; '8'=0x09; '9'=0x0A; '0'=0x0B }
    foreach ($character in $Text.ToLowerInvariant().ToCharArray()) {
        if ($letterScans.ContainsKey([string]$character)) { $scan = [uint16]$letterScans[[string]$character] }
        elseif ($digitScans.ContainsKey([string]$character)) { $scan = [uint16]$digitScans[[string]$character] }
        else { $scan = switch ([string]$character) { ' ' { 0x39; break } '.' { 0x34; break } '-' { 0x0C; break } '\' { 0x2B; break } ':' { 0x27; break } default { throw "Probe command contains unsupported US-keyboard character '$character'" } } }
        $needsShift = $character -eq ':'
        if ($needsShift) { $keys.Add(@{ Kind = 'Scan'; ScanCode = [uint16]0x2A; Up = $false }) }
        $keys.Add(@{ Kind = 'Scan'; ScanCode = $scan; Up = $false })
        $keys.Add(@{ Kind = 'Scan'; ScanCode = $scan; Up = $true })
        if ($needsShift) { $keys.Add(@{ Kind = 'Scan'; ScanCode = [uint16]0x2A; Up = $true }) }
    }
    Send-KeyBatch $ExpectedPid @($keys.ToArray()) $Marker $Log
    Send-KeyBatch $ExpectedPid @(@{ VirtualKey = [uint16]0x0D; Up = $false }, @{ VirtualKey = [uint16]0x0D; Up = $true }) $Marker $Log
}

function Get-RecorderProcesses([string] $FixturePath, [string] $Mode, [int] $RootPid) {
    $needle = [IO.Path]::GetFullPath($FixturePath)
    $processes = @(Get-CimInstance Win32_Process)
    $byId = @{}; foreach ($item in $processes) { $byId[[int]$item.ProcessId] = $item }
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($item in $processes) {
        if ($item.Name -notmatch '^(pwsh|powershell)\.exe$' -or -not $item.CommandLine -or -not $item.CommandLine.Contains($needle, [StringComparison]::OrdinalIgnoreCase) -or $item.CommandLine -notmatch "-Mode\s+$Mode(?:\s|$)") { continue }
        $parentPid = [int]$item.ParentProcessId
        $descendant = $false
        for ($depth = 0; $depth -lt 16 -and $byId.ContainsKey($parentPid); $depth++) {
            if ($parentPid -eq $RootPid) { $descendant = $true; break }
            $parentPid = [int]$byId[$parentPid].ParentProcessId
        }
        if ($descendant) { $matches.Add($item) }
    }
    return @($matches)
}

function Send-KeyBatch([int] $ExpectedPid, [object[]] $Keys, [UIntPtr] $Marker, [Collections.Generic.List[object]] $Log) {
    $hasCapsVk = @($Keys | Where-Object { $_.VirtualKey -eq 0x14 }).Count -gt 0
    $hasCapsScan = @($Keys | Where-Object { $_.Kind -eq 'Scan' -and $_.ScanCode -eq 0x3A }).Count -gt 0
    if (($hasCapsVk -or $hasCapsScan) -and -not ($ProbeStress -or $CapsOnlySmoke -or $HookSequenceSmoke)) { throw 'Fail-closed: CapsLock injection is not authorized in this probe mode' }
    if (($TerminalRecorderSmoke -or $McpTerminalSmoke -or $NvimLayoutSmoke) -and @($Keys | Where-Object { $_.VirtualKey -eq 0x14 -or ($_.Kind -eq 'Scan' -and $_.ScanCode -eq 0x3A) }).Count) { throw 'Fail-closed: terminal/MCP modes cannot send CapsLock input' }
    if (($TerminalRecorderSmoke -or $McpTerminalSmoke) -and @($Keys | Where-Object { $_.VirtualKey -eq 0xFC }).Count -and $Marker -ne $probeTokenMarker) { throw 'Fail-closed: recorder VK_NONAME input requires the native probe token marker' }
    # Guard the exact top-level HWND and focused WebView descendant immediately before SendInput.
    $target = Assert-DevTarget $ExpectedPid
    $script:currentBatch = $Keys
    $script:currentBatchMarker = $Marker
    $domState = Invoke-Cdp 'state'
    if (-not $domState.result.terminalFocused) { throw 'Refusing input: the active DOM element is not the live terminal canvas' }
    if (($TerminalRecorderSmoke -or $McpTerminalSmoke -or $NvimLayoutSmoke) -and $domState.result.transportProbeListener) { throw 'Refusing terminal input: generic capture listener is still installed and would block product key handling' }
    $target = Assert-DevTarget $ExpectedPid
    $inputs = [HookProbeNative+Input[]]::new($Keys.Count)
    $rawInputs = [Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $Keys.Count; $i++) {
        $inputs[$i] = New-KeyInput $Keys[$i] $Marker
        $raw = [HookProbeNative]::ReadKeyboard($inputs[$i])
        $keyKind = [string]$Keys[$i].Kind
        $expectedFlags = if ($keyKind -eq 'Scan') { [HookProbeNative]::ScanCode -bor $(if ($Keys[$i].Up) { [HookProbeNative]::KeyUp } else { 0 }) } elseif ($keyKind -eq 'Unicode') { [HookProbeNative]::Unicode -bor $(if ($Keys[$i].Up) { [HookProbeNative]::KeyUp } else { 0 }) } else { if ($Keys[$i].Up) { [HookProbeNative]::KeyUp } else { 0 } }
        $expectedVk = if ($keyKind -in @('Scan', 'Unicode')) { 0 } else { [uint16]$Keys[$i].VirtualKey }
        $expectedScan = if ($keyKind -eq 'Scan') { [uint16]$Keys[$i].ScanCode } elseif ($keyKind -eq 'Unicode') { [uint16][char]$Keys[$i].TextChar } else { 0 }
        if ($inputs[$i].Type -ne [HookProbeNative]::InputKeyboard -or $raw.VirtualKey -ne $expectedVk -or $raw.ScanCode -ne $expectedScan -or $raw.Flags -ne $expectedFlags -or $raw.ExtraInfo -ne $Marker) {
            throw "Refusing SendInput: constructed INPUT[$i] failed raw round-trip (type=$($inputs[$i].Type), vk=$($raw.VirtualKey), scan=$($raw.ScanCode), flags=$($raw.Flags), extra=0x$('{0:X}' -f $raw.ExtraInfo.ToUInt64()))"
        }
        $rawInputs.Add([pscustomobject]@{ type = $inputs[$i].Type; virtualKey = $raw.VirtualKey; scanCode = $raw.ScanCode; flags = $raw.Flags; extraInfo = ('0x{0:X}' -f $raw.ExtraInfo.ToUInt64()) })
    }
    $sent = [HookProbeNative]::SendInput([uint32]$inputs.Length, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][HookProbeNative+Input]))
    $Log.Add([pscustomobject]@{ at = [DateTime]::UtcNow.ToString('o'); eventCount = $inputs.Length; sentCount = $sent; rawInputs = @($rawInputs); hwnd = ('0x{0:X}' -f $target.Hwnd.ToInt64()); webviewHostHwnd = if ($script:pinnedWebviewHwnd -eq [IntPtr]::Zero) { $null } else { '0x{0:X}' -f $script:pinnedWebviewHwnd.ToInt64() }; focusHwnd = ('0x{0:X}' -f $target.Focus.ToInt64()); focusRoot = ('0x{0:X}' -f $target.FocusRoot.ToInt64()); focusPid = $target.FocusPid; focusThreadId = $target.FocusThreadId; focusClass = $target.FocusClass; focusIsChild = $target.FocusIsChild; focusProcessDescendant = $target.FocusProcessDescendant; focusPinnedHost = $target.FocusPinnedHost; pid = $target.Pid })
    if ($sent -ne $inputs.Length) { throw "SendInput inserted $sent of $($inputs.Length) keyboard events; cleanup will attempt to release any key whose down edge was inserted" }
}

function Wait-Capture([int] $ExpectedCount) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $snapshot = Invoke-Cdp 'events'
        if (-not $snapshot.result.installed) { throw 'CDP capture listener disappeared during input observation' }
        if ($snapshot.result.events.Count -ge $ExpectedCount) { return $snapshot.result.events }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    return $snapshot.result.events
}

function Wait-ProbeEvent([string] $EventName) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $snapshot = Invoke-Cdp 'probeEvents'
        $matching = @($snapshot.result.events | Where-Object event -eq $EventName)
        if ($matching.Count) { return $matching[-1].payload }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for Tauri event '$EventName': $($snapshot | ConvertTo-Json -Compress -Depth 7)"
}

function Get-LastProbeTrace {
    $null = Invoke-Cdp 'probeClear'
    $requested = Invoke-Cdp 'probeTrace'
    if (-not $requested.result.requested) { throw "Native trace request failed: $($requested.result | ConvertTo-Json -Compress -Depth 4)" }
    return Wait-ProbeEvent 'automation-probe-trace'
}

Add-Type -Path $nativePath
$failures = [HookProbeNative]::CheckBindings()
if ($failures.Count) { throw ($failures -join '; ') }
if ($SelfTest) {
    [ordered]@{
        status = 'pass'
        architecture = if ([IntPtr]::Size -eq 8) { 'x64' } else { 'x86' }
        currentThreadId = [HookProbeNative]::GetCurrentThreadId()
        keyboardInputSize = [Runtime.InteropServices.Marshal]::SizeOf([type][HookProbeNative+KeyboardInput])
        inputSize = [Runtime.InteropServices.Marshal]::SizeOf([type][HookProbeNative+Input])
        guiThreadInfoSize = [Runtime.InteropServices.Marshal]::SizeOf([type][HookProbeNative+GuiThreadInfo])
        messageSize = [Runtime.InteropServices.Marshal]::SizeOf([type][HookProbeNative+WinMessage])
        inputUnionOffset = [Runtime.InteropServices.Marshal]::OffsetOf([type][HookProbeNative+Input], 'Union').ToInt32()
        virtualKeyFlags = @{ down = 0; up = [HookProbeNative]::KeyUp }
        inputRoundTrip = [HookProbeNative]::MatchesVirtualKey([HookProbeNative]::MakeVirtualKeyInput(0xFC, $true, [UIntPtr]::new([UInt64]0x535445524D434150)), 0xFC, $true, [UIntPtr]::new([UInt64]0x535445524D434150))
        scanCodeFlags = @{ down = [HookProbeNative]::ScanCode; up = ([HookProbeNative]::ScanCode -bor [HookProbeNative]::KeyUp) }
        sideEffects = 'none: no window, pipe, CDP connection, or input is used'
    } | ConvertTo-Json -Depth 4
    exit 0
}

if (-not $TransportSmoke -and -not $ProbeStress -and -not $CallbackSmoke -and -not $CapsOnlySmoke -and -not $HookSequenceSmoke -and -not $TerminalRecorderSmoke -and -not $McpTerminalSmoke -and -not $NvimLayoutSmoke) { throw 'Choose -SelfTest, -TransportSmoke, -CallbackSmoke, -CapsOnlySmoke, -HookSequenceSmoke, -TerminalRecorderSmoke, -McpTerminalSmoke, -NvimLayoutSmoke, or -ProbeStress' }
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$modeName = if ($ProbeStress) { 'hook-order' } elseif ($CallbackSmoke) { 'hook-callback' } elseif ($CapsOnlySmoke) { 'hook-caps-only' } elseif ($HookSequenceSmoke) { 'hook-sequence' } elseif ($McpTerminalSmoke) { 'mcp-pty-recorders' } elseif ($NvimLayoutSmoke) { 'nvim-layout' } elseif ($TerminalRecorderSmoke) { 'terminal-recorders' } else { 'transport' }
$artifactPath = Join-Path $artifactDir "$runId-$modeName.json"
$log = [Collections.Generic.List[object]]::new()
$marker = [UIntPtr]::new([UInt64]0x535445524D434150)
$probeTokenMarker = [UIntPtr]::new([UInt64]0x535445524D4E4F4E)
$oldBrowserArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldCdpPort = $env:STERM_PROBE_CDP_PORT
$oldProbeEnv = $env:SCANLINE_TERM_AUTOMATION_PROBE
$oldNormalHkl = $env:SCANLINE_TERM_AUTOMATION_PROBE_NORMAL_HKL
$oldInsertHkl = $env:SCANLINE_TERM_AUTOMATION_PROBE_INSERT_HKL
$launcher = $null
$ownedAppPid = 0
$events = @()
$cdpDiagnostic = $null
$syntheticEvents = @()
$controlAEvents = @()
$tokenEvents = @()
$f24Events = @()
$controlAState = $null
$tokenFailure = $null
$failure = $null
$releaseAttempt = $null
$currentBatch = @()
$probeStatus = $null
$probeTraceBefore = $null
$probeTraceAfter = $null
$probeFrontendBefore = $null
$probeFrontendAfter = $null
$probeDomEvents = @()
$hookSteps = [Collections.Generic.List[object]]::new()
$recorderLaunches = [Collections.Generic.List[object]]::new()
$capsLockBefore = $null
$capsLockAfter = $null
$capsRestore = $null
$probeContext = $null
$focusReport = $null
$focusAttempts = [Collections.Generic.List[object]]::new()
$terminalRuns = [Collections.Generic.List[object]]::new()
$script:mcpStartupDiagnostics = $null
$script:mcpClient = $null
$script:mcpClientPid = 0
$mcpHandles = [Collections.Generic.List[string]]::new()
$mcpBootstrap = $null
$devStorageRaw = $null
$devStorageCaptured = $false
$devStoragePath = Join-Path $artifactDir "$runId-dev-settings-snapshot.json"
$layoutTargets = $null

if ($NvimLayoutSmoke -or $McpTerminalSmoke) {
    $layouts = @([HookProbeNative]::GetInstalledKeyboardLayouts())
    $normal = @($layouts | Where-Object { $value = Convert-HklToUInt64 $_; (($value -band 0xFFFF) -eq 0x0409) -and (($value -shr 32) -eq 0) } | Select-Object -First 1)
    $insert = @($layouts | Where-Object { $value = Convert-HklToUInt64 $_; (($value -band 0xFFFF) -eq 0x0419) -and (($value -shr 32) -eq 0) } | Select-Object -First 1)
    if ($NvimLayoutSmoke -and (-not $normal.Count -or -not $insert.Count)) { throw "Neovim layout smoke requires live installed English-US and Russian HKLs; found=$(@($layouts | ForEach-Object { '0x{0:X}' -f (Convert-HklToUInt64 $_) }) -join ',')" }
    if ($normal.Count -and $insert.Count) { $layoutTargets = @{ normal = '0x{0:X}' -f (Convert-HklToUInt64 $normal[0]); insert = '0x{0:X}' -f (Convert-HklToUInt64 $insert[0]) } }
}

try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
    if ($ProbeStress -or $CallbackSmoke -or $CapsOnlySmoke -or $HookSequenceSmoke -or $TerminalRecorderSmoke -or $McpTerminalSmoke -or $NvimLayoutSmoke) { $env:SCANLINE_TERM_AUTOMATION_PROBE = '1' }
    if ($McpTerminalSmoke -or $NvimLayoutSmoke) {
        if ($layoutTargets) {
            $env:SCANLINE_TERM_AUTOMATION_PROBE_NORMAL_HKL = $layoutTargets.normal
            $env:SCANLINE_TERM_AUTOMATION_PROBE_INSERT_HKL = $layoutTargets.insert
        } else {
            Remove-Item Env:SCANLINE_TERM_AUTOMATION_PROBE_NORMAL_HKL -ErrorAction SilentlyContinue
            Remove-Item Env:SCANLINE_TERM_AUTOMATION_PROBE_INSERT_HKL -ErrorAction SilentlyContinue
        }
    }
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $launcher = Start-Process -FilePath $npm -ArgumentList @('run', 'tauri:dev', '--', '--no-watch') -WorkingDirectory $root -PassThru -WindowStyle Hidden

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $candidate = Get-Process -Name 'scanline_term' -ErrorAction SilentlyContinue | Where-Object { [string]::Equals($_.Path, $debugExe, [StringComparison]::OrdinalIgnoreCase) -and $_.MainWindowTitle -ceq $windowTitle } | Select-Object -First 1
        if ($candidate) { $ownedAppPid = $candidate.Id; break }
        if ($launcher.HasExited) { throw "tauri:dev exited with code $($launcher.ExitCode) before the dev window appeared" }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ownedAppPid) { throw "Timed out waiting for exact dev window '$windowTitle'" }

    $app = Get-Process -Id $ownedAppPid -ErrorAction Stop
    if (-not [string]::Equals($app.Path, $debugExe, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing non-debug executable '$($app.Path)'" }
    $focusReport = [HookProbeNative]::FocusOwnedWindow($app.MainWindowHandle)
    $focusAttempts.Add($focusReport)
    if (-not $focusReport.Success) { throw "Could not activate the exact owned dev HWND within 2 seconds; manual click is required, no input was sent: $($focusReport | ConvertTo-Json -Compress -Depth 4)" }
    $cdpDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $initial = $null
    while ([DateTime]::UtcNow -lt $cdpDeadline) {
        try {
            $initial = Invoke-Cdp 'state'
            if ($initial.target.title -ceq 'Scanline Term') { break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $initial -or $initial.target.title -cne 'Scanline Term') { throw 'Timed out waiting for the Scanline Term CDP page' }
    if ($McpTerminalSmoke -or $NvimLayoutSmoke) {
        $storage = Invoke-Cdp 'storageSnapshot'
        if ($storage.result.origin -cne 'http://localhost:5173' -or $storage.result.key -cne 'scanline-term.settings.v1') { throw "Unsafe MCP storage snapshot response: $($storage | ConvertTo-Json -Compress -Depth 5)" }
        $devStorageRaw = $storage.result.raw
        $devStorageCaptured = $true
        @{ origin = $storage.result.origin; key = $storage.result.key; raw = $devStorageRaw } | ConvertTo-Json -Compress -Depth 8 | Set-Content -LiteralPath $devStoragePath -Encoding utf8
        $null = Invoke-Cdp 'installStartupDiagnostics'
        $mcpUiCycle = Invoke-Cdp 'cycleMcpSettingsUi'
        if ($mcpUiCycle.result.origin -cne 'http://localhost:5173' -or @($mcpUiCycle.result.states).Count -ne 2 -or $mcpUiCycle.result.states[0].stored -ne $false -or $mcpUiCycle.result.states[1].stored -ne $true) { throw "Could not cycle MCP through its exact dev Settings switch: $($mcpUiCycle | ConvertTo-Json -Compress -Depth 6)" }
        $stateAfterMcpUi = Invoke-Cdp 'state'
        if ($stateAfterMcpUi.target.title -cne 'Scanline Term' -or -not $stateAfterMcpUi.result.href.StartsWith('http://localhost:5173/', [StringComparison]::OrdinalIgnoreCase)) { throw "Dev origin changed during MCP Settings UI cycle: $($stateAfterMcpUi | ConvertTo-Json -Compress -Depth 5)" }
        $terminalRuns.Add([pscustomobject]@{ stage = 'dev-settings-ui-mcp-cycle'; result = $mcpUiCycle.result; state = $stateAfterMcpUi.result; startup = (Invoke-Cdp 'startupDiagnostics').result })
        if ($McpTerminalSmoke) {
            $beforeMcpCreate = (Invoke-Cdp 'frontendProbe').result
            $initialDefaultTabId = [string]$beforeMcpCreate.context.tabId
            $terminalRuns.Add([pscustomobject]@{ stage = 'before-mcp-test-tab'; defaultTabId = $initialDefaultTabId; context = $beforeMcpCreate.context })
        }
        $mcpBridge = Start-McpClient
        $sidecarDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $sidecar = $null
        do {
            $sidecar = Get-CimInstance Win32_Process | Where-Object { [int]$_.ParentProcessId -eq $script:mcpClientPid -and $_.Name -ieq 'scanline-term-mcp.exe' -and $_.CommandLine -like '*--pipe scanline-term-mcp-dev*' } | Select-Object -First 1
            if ($sidecar) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $sidecarDeadline)
        if (-not $sidecar -or -not [string]::Equals((Get-Process -Id ([int]$sidecar.ProcessId)).Path, (Join-Path $root 'src-tauri\target\debug\scanline-term-mcp.exe'), [StringComparison]::OrdinalIgnoreCase)) { throw 'MCP bridge did not spawn the exact debug sidecar with --pipe scanline-term-mcp-dev' }
        $mcpInitial = Wait-McpAvailable
        $terminalRuns.Add([pscustomobject]@{ stage = 'mcp-ready'; bridge = $mcpBridge; sidecarPid = [int]$sidecar.ProcessId; sidecarCommandLine = $sidecar.CommandLine; listed = $mcpInitial })
        if ($McpTerminalSmoke) {
            $fixturePath = Join-Path $PSScriptRoot 'fixtures\ProbeRecorder.ps1'
            $recordingDir = Join-Path $artifactDir 'recordings'
            New-Item -ItemType Directory -Force -Path $recordingDir | Out-Null
            $recordPath = Join-Path $recordingDir "$runId-mcp-win32.jsonl"
            $created = Invoke-Mcp 'create_terminal' @{ command = 'pwsh.exe'; args = @('-NoProfile', '-File', $fixturePath, '-Mode', 'win32', '-Output', $recordPath, '-StopAfter', '4'); cwd = $root; cols = 100; rows = 30 }
            $handle = Get-McpHandle $created
            $mcpHandles.Add($handle)
            $mcpBootstrap = @{ mode = 'win32'; handle = $handle; output = $recordPath; stopAfter = 4; create = $created; sidecarPid = [int]$sidecar.ProcessId }
            $ready = $false
            $readyDeadline = [DateTime]::UtcNow.AddSeconds(20)
            do {
                $observed = Invoke-Mcp 'observe_terminal' @{ handle = $handle; timeoutMs = 900; quietMs = 100; includeScrollback = $true }
                if (($observed | ConvertTo-Json -Compress -Depth 15).Contains('PROBE_RECORDER_READY mode=win32', [StringComparison]::Ordinal)) { $ready = $true; break }
                if (Test-Path -LiteralPath "$recordPath.startup-error.txt") { throw "win32 fixture failed: $(Get-Content -LiteralPath "$recordPath.startup-error.txt" -Raw)" }
                if ((Test-Path -LiteralPath "$recordPath.ready") -and (Get-Content -LiteralPath "$recordPath.ready" -Raw) -match 'mode=win32') { $ready = $true; break }
            } while ([DateTime]::UtcNow -lt $readyDeadline)
            if (-not $ready) { throw "win32 fixture did not become ready: status=$(Get-Content -LiteralPath "$recordPath.status.json" -Raw -ErrorAction SilentlyContinue)" }
            $terminalRuns.Add([pscustomobject]@{ stage = 'bootstrap-win32-ready'; handle = $handle; output = $recordPath; ready = $true })
        } elseif ($NvimLayoutSmoke) {
            $nvim = Get-Command nvim.exe -ErrorAction Stop
            $fixturePath = Join-Path $PSScriptRoot 'fixtures\layout-nvim.lua'
            $recordPath = Join-Path $artifactDir "$runId-nvim.jsonl"
            $commandText = "`$env:STERM_PROBE_OUTPUT='$recordPath'; & '$($nvim.Source)' --clean -u '$fixturePath'"
            $created = Invoke-Mcp 'create_terminal' @{ command = 'pwsh.exe'; args = @('-NoProfile', '-Command', $commandText); cwd = $root; cols = 100; rows = 30 }
            $handle = Get-McpHandle $created
            $mcpHandles.Add($handle)
            $mcpBootstrap = @{ mode = 'nvim'; handle = $handle; output = $recordPath; create = $created; command = $commandText; targets = $layoutTargets }
            $nvimReadyDeadline = [DateTime]::UtcNow.AddSeconds(20)
            $nvimReady = $false
            do {
                $null = Invoke-Mcp 'observe_terminal' @{ handle = $handle; timeoutMs = 700; quietMs = 100; includeScrollback = $false }
                if (Test-Path -LiteralPath $recordPath) {
                    $initialRecords = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
                    if (@($initialRecords | Where-Object kind -eq 'ready').Count) { $nvimReady = $true; break }
                }
            } while ([DateTime]::UtcNow -lt $nvimReadyDeadline)
            if (-not $nvimReady) { throw "Neovim fixture did not record READY within 20s: output=$(Get-Content -LiteralPath $recordPath -Raw -ErrorAction SilentlyContinue)" }
            $terminalRuns.Add([pscustomobject]@{ stage = 'bootstrap-nvim-ready'; handle = $handle; output = $recordPath; ready = $true; command = $commandText; targets = $layoutTargets })
        }
    }
    $focusDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $focusResult = Invoke-Cdp 'focusTerminal'
        $cdpDiagnostic = $focusResult
        if ($focusResult.result.terminalFocused) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $focusDeadline)
    if (-not $focusResult.result.terminalFocused) { throw "Could not focus a live terminal canvas through CDP: $($focusResult | ConvertTo-Json -Compress -Depth 5)" }
    $install = Invoke-Cdp 'install'
    if (-not $install.result.installed) { throw "CDP capture listener did not report installed: $($install | ConvertTo-Json -Compress -Depth 5)" }
    $cdpDiagnostic = $install
    $emptyCapture = Invoke-Cdp 'events'
    if (-not $emptyCapture.result.installed -or $emptyCapture.result.events.Count -ne 0) { throw "CDP capture preflight was not clean: $($emptyCapture | ConvertTo-Json -Compress -Depth 5)" }
    if ($TransportSmoke) {
        $syntheticCheck = Invoke-Cdp 'syntheticCheck'
        if ($syntheticCheck.result.dispatchAccepted -or -not $syntheticCheck.result.defaultPrevented -or $syntheticCheck.result.count -ne 1) { throw "CDP synthetic listener self-check failed: $($syntheticCheck | ConvertTo-Json -Compress -Depth 5)" }
        $syntheticEvents = Wait-Capture 1
        if ($syntheticEvents.Count -ne 1 -or $syntheticEvents[0].keyCode -ne 65 -or -not $syntheticEvents[0].defaultPrevented) { throw "CDP synthetic event was not recorded and canceled: $($syntheticEvents | ConvertTo-Json -Compress -Depth 5)" }
        $clearSynthetic = Invoke-Cdp 'clear'
        if (-not $clearSynthetic.result.cleared -or $clearSynthetic.result.count -ne 1) { throw 'Could not clear the synthetic CDP event' }
    }
    $cdpDiagnostic = @{ install = $install; beforeInput = $emptyCapture; syntheticCheck = $syntheticCheck }
    $initial = Invoke-Cdp 'state'
    if ($initial.target.title -cne 'Scanline Term' -or -not $initial.result.terminalFocused) { throw "Unexpected CDP target or DOM focus: $($initial | ConvertTo-Json -Compress -Depth 5)" }
    $null = Assert-DevTarget $ownedAppPid

    if ($ProbeStress -or $CallbackSmoke -or $CapsOnlySmoke -or $HookSequenceSmoke -or $TerminalRecorderSmoke -or $McpTerminalSmoke -or $NvimLayoutSmoke) {
        $eventRegistration = Invoke-Cdp 'probeSetup'
        if (@($eventRegistration.result.registered).Count -lt 3) { throw "Could not register native probe events: $($eventRegistration | ConvertTo-Json -Compress -Depth 5)" }
        $readyDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $readyResult = $null
        do {
            $readyResult = Invoke-Cdp 'probeReady'
            if ($readyResult.result.emitted) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $readyDeadline)
        if (-not $readyResult.result.emitted) { throw "Native probe-ready event failed: $($readyResult.result | ConvertTo-Json -Compress -Depth 4)" }
        $probeStatus = Wait-ProbeEvent 'automation-probe-status'
        $expectedHwnd = '0x{0:X}' -f (Get-Process -Id $ownedAppPid).MainWindowHandle.ToInt64()
        if (-not $probeStatus.enabled -or -not $probeStatus.hookInstalled -or [int]$probeStatus.targetPid -ne $ownedAppPid -or -not [string]::Equals([string]$probeStatus.targetHwnd, $expectedHwnd, [StringComparison]::OrdinalIgnoreCase) -or -not $probeStatus.targetWebviewHwnd) {
            throw "Native hook readiness did not match owned dev target: $($probeStatus | ConvertTo-Json -Compress -Depth 5)"
        }
        $hostValue = [Convert]::ToInt64(([string]$probeStatus.targetWebviewHwnd).Substring(2), 16)
        $script:pinnedWebviewHwnd = [IntPtr]$hostValue
        $hostClass = Get-HwndClassName $script:pinnedWebviewHwnd
        if ($hostClass -cne 'WRY_WEBVIEW' -or -not ([HookProbeNative]::IsChild((Get-Process -Id $ownedAppPid).MainWindowHandle, $script:pinnedWebviewHwnd))) {
            throw "Refusing input: native host HWND is not the WRY_WEBVIEW child of this exact dev window (host=$($probeStatus.targetWebviewHwnd), class='$hostClass')"
        }
        $probeDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $probeFrontendBefore = (Invoke-Cdp 'frontendProbe').result
            if ($probeFrontendBefore.enabled -and $probeFrontendBefore.context -and $probeFrontendBefore.context.tabId -and $probeFrontendBefore.context.focused) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $probeDeadline)
        if (-not $probeFrontendBefore.enabled -or -not $probeFrontendBefore.context -or -not $probeFrontendBefore.context.tabId -or -not $probeFrontendBefore.context.focused) { throw "Frontend probe did not expose an active focused terminal context: $($probeFrontendBefore | ConvertTo-Json -Compress -Depth 5)" }
        $probeContext = $probeFrontendBefore.context
        if (-not $probeContext -or -not $probeContext.tabId -or -not $probeContext.focused -or -not $initial.result.terminalFocused) { throw "No live focused terminal context is available: $($probeFrontendBefore | ConvertTo-Json -Compress -Depth 5)" }
        $probeDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $probeTraceBefore = Get-LastProbeTrace
            if ($probeTraceBefore.hookInstalled -and $probeTraceBefore.armed) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $probeDeadline)
        if (-not $probeTraceBefore.hookInstalled -or -not $probeTraceBefore.armed -or [int]$probeTraceBefore.targetPid -ne $ownedAppPid -or -not [string]::Equals([string]$probeTraceBefore.targetHwnd, $expectedHwnd, [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals([string]$probeTraceBefore.targetWebviewHwnd, [string]$probeStatus.targetWebviewHwnd, [StringComparison]::OrdinalIgnoreCase) -or $probeTraceBefore.tabId -ne $probeContext.tabId -or [int]$probeTraceBefore.generation -ne [int]$probeContext.generation) {
            throw "Native hook did not arm for the exact frontend context: $($probeTraceBefore | ConvertTo-Json -Compress -Depth 6)"
        }
        if ($CallbackSmoke) {
            # The first stage sends only ordinary A down/up to prove the low-level callback is live.
            Start-Sleep -Milliseconds 120
            $probeTraceBefore = Get-LastProbeTrace
            $null = Invoke-Cdp 'clear'
            $null = Invoke-Cdp 'frontendProbeClear'
            $callbackBefore = [long]$probeTraceBefore.hookCallbackCount
            $sequence = @(@{ VirtualKey = [uint16]0x41; Up = $false }, @{ VirtualKey = [uint16]0x41; Up = $true })
            Send-KeyBatch $ownedAppPid $sequence $marker $log
            $probeDomEvents = Wait-Capture 2
            Start-Sleep -Milliseconds 120
            $probeFrontendAfter = (Invoke-Cdp 'frontendProbe').result
            $probeTraceAfter = Get-LastProbeTrace
            $callbackAfter = [long]$probeTraceAfter.hookCallbackCount
            $heartbeatBefore = [long]$probeTraceBefore.hookLoopHeartbeatTickMs
            $heartbeatAfter = [long]$probeTraceAfter.hookLoopHeartbeatTickMs
            if (-not $probeTraceAfter.hookInstalled -or $callbackAfter -le $callbackBefore) { throw "A-only probe did not increment native hook callback count ($callbackBefore -> $callbackAfter)" }
            if ($heartbeatBefore -eq 0 -or $heartbeatAfter -eq 0 -or $heartbeatAfter -eq $heartbeatBefore) { throw "Native hook loop heartbeat did not advance ($heartbeatBefore -> $heartbeatAfter)" }
            if ($probeDomEvents.Count -ne 2 -or @($probeDomEvents | Where-Object keyCode -eq 65).Count -ne 2) { throw "A-only control did not reach the focused DOM as exactly two keyCode 65 events: $($probeDomEvents | ConvertTo-Json -Compress -Depth 5)" }
            $events = @($probeDomEvents)
        } elseif ($CapsOnlySmoke) {
            $capsLockBefore = ([HookProbeNative]::GetKeyState(0x14) -band 1)
            if ($capsLockBefore -ne 0) { throw "Caps-only probe requires the confirmed OFF baseline, current=$capsLockBefore; no input sent" }
            Start-Sleep -Milliseconds 120
            $probeTraceBefore = Get-LastProbeTrace
            $callbackBefore = [long]$probeTraceBefore.hookCallbackCount
            $null = Invoke-Cdp 'clear'
            $null = Invoke-Cdp 'frontendProbeClear'
            $sequence = @(@{ VirtualKey = [uint16]0x14; Up = $false }, @{ VirtualKey = [uint16]0x14; Up = $true })
            Send-KeyBatch $ownedAppPid $sequence $marker $log
            Start-Sleep -Milliseconds 200
            $capture = Invoke-Cdp 'events'
            $probeDomEvents = @($capture.result.events)
            $probeFrontendAfter = (Invoke-Cdp 'frontendProbe').result
            $probeTraceAfter = Get-LastProbeTrace
            $capsLockAfter = ([HookProbeNative]::GetKeyState(0x14) -band 1)
            $callbackAfter = [long]$probeTraceAfter.hookCallbackCount
            $heartbeatBefore = [long]$probeTraceBefore.hookLoopHeartbeatTickMs
            $heartbeatAfter = [long]$probeTraceAfter.hookLoopHeartbeatTickMs
            $capsTrace = @($probeTraceAfter.entries | Where-Object { $_.vk -eq 20 })
            if (-not $probeTraceAfter.hookInstalled -or $callbackAfter -le $callbackBefore) { throw "Caps-only probe did not increment native hook callback count ($callbackBefore -> $callbackAfter)" }
            if ($heartbeatBefore -eq 0 -or $heartbeatAfter -eq 0 -or $heartbeatAfter -eq $heartbeatBefore) { throw "Native hook loop heartbeat did not advance ($heartbeatBefore -> $heartbeatAfter)" }
            if (@($capsTrace | Where-Object edge -eq 'down').Count -lt 1 -or @($capsTrace | Where-Object edge -eq 'up').Count -lt 1) { throw "Native trace lacks both CapsLock edges: $($probeTraceAfter | ConvertTo-Json -Compress -Depth 6)" }
            $events = @($probeDomEvents)
        } elseif ($HookSequenceSmoke) {
            $capsLockBefore = ([HookProbeNative]::GetKeyState(0x14) -band 1)
            if ($capsLockBefore -ne 0) { throw "Hook sequence probe requires the confirmed OFF baseline, current=$capsLockBefore; no input sent" }
            if (-not $probeTraceBefore.hookInstalled -or $probeTraceBefore.hookLoopHeartbeatTickMs -eq 0) { throw "Native hook is not installed or its message loop is not live: $($probeTraceBefore | ConvertTo-Json -Compress -Depth 5)" }
            $cases = [Collections.Generic.List[object]]::new()
            $capsScan = @(
                @{ Kind = 'Scan'; ScanCode = [uint16]0x3A; Up = $false },
                @{ VirtualKey = [uint16]0x48; Up = $false },
                @{ VirtualKey = [uint16]0x48; Up = $true },
                @{ Kind = 'Scan'; ScanCode = [uint16]0x3A; Up = $true }
            )
            $warmA = @()
            $warmCallbackBaseline = [long]$probeTraceBefore.hookCallbackCount
            for ($warmIndex = 1; $warmIndex -le 4; $warmIndex++) {
                $warmBefore = Get-LastProbeTrace
                $null = Invoke-Cdp 'clear'
                Send-KeyBatch $ownedAppPid @(@{ VirtualKey = [uint16]0x41; Up = $false }, @{ VirtualKey = [uint16]0x41; Up = $true }) $marker $log
                $warmDom = Wait-Capture 2
                Start-Sleep -Milliseconds 120
                $warmAfter = Get-LastProbeTrace
                $warmA += [pscustomobject]@{ attempt = $warmIndex; callbackBefore = [long]$warmBefore.hookCallbackCount; callbackAfter = [long]$warmAfter.hookCallbackCount; domEvents = @($warmDom); heartbeat = [long]$warmAfter.hookLoopHeartbeatTickMs }
                $probeTraceAfter = $warmAfter
                if ([long]$warmAfter.hookCallbackCount -gt $warmCallbackBaseline) { break }
            }
            if ([long]$probeTraceAfter.hookCallbackCount -le $warmCallbackBaseline) { throw "Native callback did not observe A after four bounded A down/up warmups: $($warmA | ConvertTo-Json -Compress -Depth 5)" }
            $hookSteps.Add([pscustomobject]@{ name = 'warm-a-liveness'; attempts = @($warmA); status = 'callback-observed' })
            $cases.Add(@{ name = 'vk-caps'; keys = @(@{ VirtualKey = [uint16]0x14; Up = $false }, @{ VirtualKey = [uint16]0x14; Up = $true }) })
            # If the VK form toggles the global lock, restore OFF through the same still-owned hooked window before continuing.
            $cases.Add(@{ name = 'vk-caps-off-reset'; keys = @(@{ VirtualKey = [uint16]0x14; Up = $false }, @{ VirtualKey = [uint16]0x14; Up = $true }) })
            $cases.Add(@{ name = 'scan-caps-h-nested'; keys = $capsScan })
            foreach ($case in $cases) {
                if ($case.name -eq 'scan-caps-h-nested' -and ([HookProbeNative]::GetKeyState(0x14) -band 1) -ne 0) { throw 'CapsLock was not restored OFF after VK comparison; refusing nested scan-code batch' }
                $stepBefore = Get-LastProbeTrace
                $stepCapsBefore = ([HookProbeNative]::GetKeyState(0x14) -band 1)
                $null = Invoke-Cdp 'clear'
                $null = Invoke-Cdp 'frontendProbeClear'
                Send-KeyBatch $ownedAppPid $case.keys $marker $log
                Start-Sleep -Milliseconds 120
                $stepDom = (Invoke-Cdp 'events').result.events
                $stepFrontend = (Invoke-Cdp 'frontendProbe').result
                $stepAfter = Get-LastProbeTrace
                $stepCapsAfter = ([HookProbeNative]::GetKeyState(0x14) -band 1)
                $lastSeq = -1
                if (@($stepBefore.entries).Count) { $lastSeq = [long]($stepBefore.entries | Select-Object -Last 1).sequence }
                $newEntries = @($stepAfter.entries | Where-Object { [long]$_.sequence -gt $lastSeq })
                $hookSteps.Add([pscustomobject]@{
                    name = $case.name
                    sendInputCount = $log[$log.Count - 1].sentCount
                    callbackBefore = [long]$stepBefore.hookCallbackCount
                    callbackAfter = [long]$stepAfter.hookCallbackCount
                    heartbeatBefore = [long]$stepBefore.hookLoopHeartbeatTickMs
                    heartbeatAfter = [long]$stepAfter.hookLoopHeartbeatTickMs
                    capsBefore = $stepCapsBefore
                    capsAfter = $stepCapsAfter
                    nativeEntries = $newEntries
                    domEvents = @($stepDom)
                    frontendTrace = @($stepFrontend.trace)
                })
                $probeTraceAfter = $stepAfter
                $probeFrontendAfter = $stepFrontend
                $probeDomEvents = @($stepDom)
            }
            $null = Invoke-Cdp 'removeCapture'
            $fixturePath = Join-Path $PSScriptRoot 'fixtures\ProbeRecorder.ps1'
            $recordingDir = Join-Path $artifactDir 'recordings'
            New-Item -ItemType Directory -Force -Path $recordingDir | Out-Null
            if (-not [string]::Equals([string]$probeStatus.currentHkl, '0x4090409', [StringComparison]::OrdinalIgnoreCase)) { throw "Scan-code shell command typing requires the measured US-English HKL 0x4090409; current=$($probeStatus.currentHkl)" }
            foreach ($recorderMode in @('vt', 'win32')) {
                if (([HookProbeNative]::GetKeyState(0x14) -band 1) -ne 0) { throw "CapsLock changed before $recorderMode PTY recording; refusing to continue" }
                $recordPath = Join-Path $recordingDir "$runId-$recorderMode.jsonl"
                $stopAfter = if ($recorderMode -eq 'vt') { 2 } else { 4 }
                $command = "pwsh -NoProfile -File $fixturePath -Mode $recorderMode -Output $recordPath -StopAfter $stopAfter".ToLowerInvariant()
                $stateBeforeLaunch = (Invoke-Cdp 'state').result
                if (-not $stateBeforeLaunch.pageFocused -or -not $stateBeforeLaunch.terminalFocused) { throw "Terminal canvas lost focus before launching $recorderMode recorder" }
                Send-ProbeText $ownedAppPid $command $marker $log
                $launchDeadline = [DateTime]::UtcNow.AddSeconds(8)
                $recorderProcesses = @()
                do {
                    $recorderProcesses = @(Get-RecorderProcesses $fixturePath $recorderMode $ownedAppPid)
                    if ($recorderProcesses.Count) { break }
                    Start-Sleep -Milliseconds 100
                } while ([DateTime]::UtcNow -lt $launchDeadline)
                if ($recorderProcesses.Count -ne 1) { throw "Could not identify exactly one owned $recorderMode recorder child process (count=$($recorderProcesses.Count))" }
                $recorderLaunches.Add([pscustomobject]@{ mode = $recorderMode; pid = [int]$recorderProcesses[0].ProcessId; parentPid = [int]$recorderProcesses[0].ParentProcessId; commandLine = $recorderProcesses[0].CommandLine })
                $readyPath = "$recordPath.ready"
                $readyDeadline = [DateTime]::UtcNow.AddSeconds(8)
                $readyText = $null
                $statusPath = "$recordPath.status.json"
                $startupErrorPath = "$recordPath.startup-error.txt"
                do {
                    if (Test-Path -LiteralPath $readyPath) { $readyText = Get-Content -LiteralPath $readyPath -Raw; if ($readyText -match "mode=$recorderMode\s+pid=$([int]$recorderProcesses[0].ProcessId)\b") { break } }
                    if (Test-Path -LiteralPath $startupErrorPath) { throw "$recorderMode recorder startup error: $(Get-Content -LiteralPath $startupErrorPath -Raw); status=$(Get-Content -LiteralPath $statusPath -Raw -ErrorAction SilentlyContinue)" }
                    if (-not (Get-Process -Id ([int]$recorderProcesses[0].ProcessId) -ErrorAction SilentlyContinue)) { throw "$recorderMode recorder exited before READY sentinel; launch=$($recorderLaunches[-1] | ConvertTo-Json -Compress)" }
                    Start-Sleep -Milliseconds 100
                } while ([DateTime]::UtcNow -lt $readyDeadline)
                if ($readyText -notmatch "mode=$recorderMode\s+pid=$([int]$recorderProcesses[0].ProcessId)\b") { throw "$recorderMode recorder did not publish its exact READY sentinel within 8s; launch=$($recorderLaunches[-1] | ConvertTo-Json -Compress), sentinel=$readyText, status=$(Get-Content -LiteralPath $statusPath -Raw -ErrorAction SilentlyContinue)" }
                $null = Invoke-Cdp 'frontendProbeClear'
                Send-KeyBatch $ownedAppPid @(@{ VirtualKey = [uint16]0x1B; Up = $false }, @{ VirtualKey = [uint16]0x1B; Up = $true }) $marker $log
                Send-KeyBatch $ownedAppPid $capsScan $marker $log
                $recordDeadline = [DateTime]::UtcNow.AddSeconds(10)
                do {
                    $processNow = Get-Process -Id ([int]$recorderProcesses[0].ProcessId) -ErrorAction SilentlyContinue
                    if (-not $processNow -and (Test-Path -LiteralPath $recordPath)) { break }
                    Start-Sleep -Milliseconds 100
                } while ([DateTime]::UtcNow -lt $recordDeadline)
                if ((Get-Process -Id ([int]$recorderProcesses[0].ProcessId) -ErrorAction SilentlyContinue)) {
                    $stillOwned = Get-RecorderProcesses $fixturePath $recorderMode $ownedAppPid
                    if ($stillOwned.Count -eq 1 -and [int]$stillOwned[0].ProcessId -eq [int]$recorderProcesses[0].ProcessId) { Stop-Process -Id ([int]$recorderProcesses[0].ProcessId) -Force }
                    throw "$recorderMode recorder did not finish after its exact expected input count"
                }
                if (-not (Test-Path -LiteralPath $recordPath)) { throw "$recorderMode recorder exited without producing its JSONL artifact" }
                $records = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
                if ($recorderMode -eq 'vt') {
                    $validRecords = $records.Count -eq 2 -and $records[0].hex -eq '1B' -and $records[1].hex -eq '08'
                } else {
                    $hRecords = @($records | Where-Object vk -eq 72)
                    $validRecords = $records.Count -eq 4 -and $records[0].vk -eq 27 -and $records[0].keyDown -and -not $records[1].keyDown -and $hRecords.Count -eq 2 -and $hRecords[0].keyDown -and -not $hRecords[1].keyDown -and (($hRecords[0].controlState -band 0xC) -ne 0)
                }
                $terminalRuns.Add([pscustomobject]@{ mode = $recorderMode; command = $command; processId = [int]$recorderProcesses[0].ProcessId; output = $recordPath; records = @($records); exactExpectedInputObserved = [bool]$validRecords; frontendTrace = @((Invoke-Cdp 'frontendProbe').result.trace) })
                if (-not $validRecords) { throw "$recorderMode PTY recorder observed an unexpected key sequence: $($records | ConvertTo-Json -Compress -Depth 5)" }
            }
            $capsLockAfter = ([HookProbeNative]::GetKeyState(0x14) -band 1)
            $events = @($hookSteps)
        } elseif ($TerminalRecorderSmoke) {
            $capsLockBefore = ([HookProbeNative]::GetKeyState(0x14) -band 1)
            if ($capsLockBefore -ne 0) { throw "Terminal recorder requires a confirmed CapsLock OFF baseline, current=$capsLockBefore" }
            $events = @()
        } elseif ($ProbeStress) {
        $capsLockBefore = ([HookProbeNative]::GetKeyState(0x14) -band 1)
        $null = Invoke-Cdp 'clear'
        $null = Invoke-Cdp 'frontendProbeClear'
        $sequence = @(
            @{ VirtualKey = [uint16]0x14; Up = $false },
            @{ VirtualKey = [uint16]0x48; Up = $false },
            @{ VirtualKey = [uint16]0x48; Up = $true },
            @{ VirtualKey = [uint16]0x14; Up = $true }
        )
        Send-KeyBatch $ownedAppPid $sequence $marker $log
        $probeDomEvents = Wait-Capture 4
        $probeFrontendDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $probeFrontendAfter = (Invoke-Cdp 'frontendProbe').result
            if ($probeFrontendAfter.trace.Count -ge 5) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $probeFrontendDeadline)
        $probeTraceAfter = Get-LastProbeTrace
        $capsLockAfter = ([HookProbeNative]::GetKeyState(0x14) -band 1)
        $tokenDownIndex = -1; $hDownIndex = -1
        for ($i = 0; $i -lt $probeDomEvents.Count; $i++) {
            $entry = $probeDomEvents[$i]
            if ($tokenDownIndex -lt 0 -and $entry.key -eq 'Unidentified' -and $entry.keyCode -eq 252 -and $entry.type -eq 'keydown') { $tokenDownIndex = $i }
            if ($hDownIndex -lt 0 -and $entry.keyCode -eq 72 -and $entry.type -eq 'keydown') { $hDownIndex = $i }
        }
        if ($tokenDownIndex -lt 0 -or $hDownIndex -lt 0 -or $tokenDownIndex -ge $hDownIndex) { throw "Token keydown did not reach the DOM before H; stopping before any follow-up sequence. Events: $($probeDomEvents | ConvertTo-Json -Compress -Depth 5)" }
        $baselineSequence = -1
        if (@($probeTraceBefore.entries).Count) { $baselineSequence = [long]($probeTraceBefore.entries | Select-Object -Last 1).sequence }
        $newNative = @($probeTraceAfter.entries | Where-Object { [long]$_.sequence -gt $baselineSequence })
        if (-not $probeTraceAfter.armed -or $newNative.Count -lt 6) { throw "Native trace lacks the complete nested Caps/H/token order: $($probeTraceAfter | ConvertTo-Json -Compress -Depth 6)" }
        if ($capsLockAfter -ne $capsLockBefore) { throw "CapsLock toggle state changed during the guarded hook batch (before=$capsLockBefore after=$capsLockAfter)" }
        $traceKinds = @($probeFrontendAfter.trace | ForEach-Object kind)
        if ($traceKinds -notcontains 'token-down' -or $traceKinds -notcontains 'chord-keydown' -or $traceKinds -notcontains 'token-up') { throw "Frontend tap/hold trace is incomplete: $($probeFrontendAfter.trace | ConvertTo-Json -Compress -Depth 6)" }
        $cdpDiagnostic = @{ install = $install; beforeInput = $emptyCapture; syntheticCheck = $syntheticCheck; nativeRegistration = $eventRegistration }
        $events = @($probeDomEvents)
        }
    }

    if ($McpTerminalSmoke) {
        $capsLockBefore = ([HookProbeNative]::GetKeyState(0x14) -band 1)
        if ($capsLockBefore -ne 0) { throw "MCP recorder requires a confirmed CapsLock OFF baseline, current=$capsLockBefore; no input sent" }
        $mcpInitial = Wait-McpAvailable
        $captureRemoval = Invoke-Cdp 'removeCapture'
        if (-not $captureRemoval.result.removed) { throw "Could not remove generic transport capture listener before recorder input: $($captureRemoval | ConvertTo-Json -Compress -Depth 4)" }
        $fixturePath = Join-Path $PSScriptRoot 'fixtures\ProbeRecorder.ps1'
        $recordingDir = Join-Path $artifactDir 'recordings'
        New-Item -ItemType Directory -Force -Path $recordingDir | Out-Null
        foreach ($recorderMode in @('win32', 'vt')) {
            $recordPath = Join-Path $recordingDir "$runId-mcp-$recorderMode.jsonl"
            $stopAfter = if ($recorderMode -eq 'vt') { 2 } else { 4 }
            if ($mcpBootstrap -and $recorderMode -eq $mcpBootstrap.mode) {
                if (-not $mcpBootstrap.handle) { throw "MCP $recorderMode fixture was not bootstrapped before canvas focus" }
                $handle = $mcpBootstrap.handle; $recordPath = $mcpBootstrap.output; $created = $mcpBootstrap.create
            } else {
                $recordPath = Join-Path $recordingDir "$runId-mcp-$recorderMode.jsonl"
                $created = Invoke-Mcp 'create_terminal' @{ command = 'pwsh.exe'; args = @('-NoProfile', '-File', $fixturePath, '-Mode', $recorderMode, '-Output', $recordPath, '-StopAfter', [string]$stopAfter); cwd = $root; cols = 100; rows = 30 }
                $handle = Get-McpHandle $created
                $mcpHandles.Add($handle)
            }
            $launchRecord = [pscustomobject]@{ mode = $recorderMode; handle = $handle; output = $recordPath; create = $created }
            $terminalRuns.Add($launchRecord)
            $ready = $false
            $readyDeadline = [DateTime]::UtcNow.AddSeconds(20)
            do {
                $observed = Invoke-Mcp 'observe_terminal' @{ handle = $handle; timeoutMs = 900; quietMs = 100; includeScrollback = $true }
                $observedJson = $observed | ConvertTo-Json -Compress -Depth 15
                if ($observedJson.Contains("PROBE_RECORDER_READY mode=$recorderMode", [StringComparison]::Ordinal)) { $ready = $true; break }
                if (Test-Path -LiteralPath "$recordPath.startup-error.txt") { throw "$recorderMode fixture failed: $(Get-Content -LiteralPath "$recordPath.startup-error.txt" -Raw)" }
                if ((Test-Path -LiteralPath "$recordPath.ready") -and (Get-Content -LiteralPath "$recordPath.ready" -Raw) -match "mode=$recorderMode") { $ready = $true; break }
            } while ([DateTime]::UtcNow -lt $readyDeadline)
            if (-not $ready) { throw "$recorderMode fixture produced no READY output/sentinel: $observedJson; status=$(Get-Content -LiteralPath "$recordPath.status.json" -Raw -ErrorAction SilentlyContinue)" }
            $parserModeAction = if ($recorderMode -eq 'vt') { 'setTerminalVtMode' } else { 'setTerminalWin32Mode' }
            $parserMode = (Invoke-Cdp $parserModeAction).result
            $expectedWin32Mode = $recorderMode -eq 'win32'
            if ($parserMode.win32InputMode -ne $expectedWin32Mode) { throw "Terminal parser did not enter requested $recorderMode mode: $($parserMode | ConvertTo-Json -Compress -Depth 4)" }
            $target = Assert-DevTarget $ownedAppPid
            $canvas = (Invoke-Cdp 'state').result
            if (-not $canvas.pageFocused -or -not $canvas.terminalFocused) { $canvas = (Invoke-Cdp 'focusTerminal').result }
            if (-not $canvas.terminalFocused) { throw "Cannot input into ${recorderMode}: active DOM terminal canvas is not focused" }
            $frontend = (Invoke-Cdp 'frontendProbe').result
            if (-not $frontend.enabled -or -not $frontend.context.focused -or -not $frontend.context.tabId) { throw "Cannot input into ${recorderMode}: frontend probe context is not active: $($frontend | ConvertTo-Json -Compress -Depth 5)" }
            $mcpContext = $frontend.context
            $null = Invoke-Cdp 'frontendProbeClear'
            Send-KeyBatch $ownedAppPid @(@{ VirtualKey = [uint16]0xFC; Up = $false }, @{ VirtualKey = [uint16]0xFC; Up = $true }) $probeTokenMarker $log
            $chord = @(@{ VirtualKey = [uint16]0xFC; Up = $false }, @{ VirtualKey = [uint16]0x48; Up = $false }, @{ VirtualKey = [uint16]0x48; Up = $true }, @{ VirtualKey = [uint16]0xFC; Up = $true })
            Send-KeyBatch $ownedAppPid $chord $probeTokenMarker $log
            $recordDeadline = [DateTime]::UtcNow.AddSeconds(12)
            do {
                if (Test-Path -LiteralPath $recordPath) {
                    $records = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
                    if ($records.Count -ge $stopAfter) { break }
                }
                $null = Invoke-Mcp 'observe_terminal' @{ handle = $handle; timeoutMs = 500; quietMs = 100; includeScrollback = $false }
            } while ([DateTime]::UtcNow -lt $recordDeadline)
            if (-not (Test-Path -LiteralPath $recordPath)) { throw "$recorderMode fixture produced no JSONL after marked token input" }
            $records = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
            if ($recorderMode -eq 'vt') {
                $validRecords = $records.Count -eq 2 -and $records[0].hex -eq '1B' -and $records[1].hex -eq '08'
            } else {
                $escRecords = @($records | Where-Object vk -eq 27); $hRecords = @($records | Where-Object vk -eq 72)
                $validRecords = $records.Count -eq 4 -and $escRecords.Count -eq 2 -and $escRecords[0].keyDown -and -not $escRecords[1].keyDown -and $hRecords.Count -eq 2 -and $hRecords[0].keyDown -and -not $hRecords[1].keyDown -and (($hRecords[0].controlState -band 0xC) -ne 0)
            }
            $trace = (Invoke-Cdp 'frontendProbe').result.trace
            $terminalRuns.Add([pscustomobject]@{ mode = $recorderMode; handle = $handle; output = $recordPath; readyObserved = $true; parserMode = $parserMode; records = @($records); exactExpectedInputObserved = [bool]$validRecords; frontendTrace = @($trace); tabContext = $mcpContext; nativePath = 'marked VK_NONAME surrogate; bypasses physical Caps hook' })
            if (-not $validRecords) { throw "$recorderMode PTY recorder did not observe the exact marked Escape/Ctrl-H sequence: $($records | ConvertTo-Json -Compress -Depth 6)" }
            $null = Invoke-Mcp 'close_terminal' @{ handle = $handle }
            [void]$mcpHandles.Remove($handle)
        }
        $lastClosedTestTabId = [string]$mcpContext.tabId
        $closedTrace = @((Invoke-Cdp 'frontendProbe').result.trace | Where-Object tabId -ceq $lastClosedTestTabId | Where-Object kind -in @('token-down', 'token-up', 'token-cancel', 'token-control-armed'))
        $unclosedLogicalToken = 0
        foreach ($entry in $closedTrace) {
            if ($entry.kind -eq 'token-down') { $unclosedLogicalToken++ }
            elseif ($entry.kind -in @('token-up', 'token-cancel')) { $unclosedLogicalToken = [Math]::Max(0, $unclosedLogicalToken - 1) }
        }
        $closeContextDeadline = [DateTime]::UtcNow.AddSeconds(4)
        $closeProbe = $null
        $closeNativeTrace = $null
        do {
            $closeProbe = (Invoke-Cdp 'frontendProbe').result
            if ($closeProbe.context.tabId -ne $lastClosedTestTabId) {
                $closeNativeTrace = Get-LastProbeTrace
                if ($closeNativeTrace.tabId -ne $lastClosedTestTabId) { break }
            }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $closeContextDeadline)
        $returnedToInitialTab = -not $initialDefaultTabId -or $closeProbe.context.tabId -eq $initialDefaultTabId
        $closeContextPassed = [bool]$lastClosedTestTabId -and $closeProbe.context.tabId -ne $lastClosedTestTabId -and $closeNativeTrace.tabId -ne $lastClosedTestTabId -and $returnedToInitialTab -and $unclosedLogicalToken -eq 0
        $terminalRuns.Add([pscustomobject]@{ stage = 'close-last-owned-test-tab-context'; initialDefaultTabId = $initialDefaultTabId; closedTestTabId = $lastClosedTestTabId; frontendContextAfterClose = $closeProbe.context; nativeContextAfterClose = @{ tabId = $closeNativeTrace.tabId; generation = $closeNativeTrace.generation; armed = $closeNativeTrace.armed }; closedTabTokenTrace = $closedTrace; unmatchedTokenDowns = $unclosedLogicalToken; returnedToInitialTab = $returnedToInitialTab; passed = $closeContextPassed })
        if (-not $closeContextPassed) { throw "Closing the last owned MCP test tab left stale probe context or a logical token down: $(($terminalRuns[-1] | ConvertTo-Json -Compress -Depth 7))" }
        $capsLockAfter = ([HookProbeNative]::GetKeyState(0x14) -band 1)
        if ($capsLockAfter -ne $capsLockBefore) { throw "CapsLock changed during Caps-free MCP recorder run ($capsLockBefore -> $capsLockAfter)" }
        $events = @($terminalRuns)
    } elseif ($NvimLayoutSmoke) {
        if (-not $mcpBootstrap -or $mcpBootstrap.mode -ne 'nvim') { throw 'Neovim fixture was not bootstrapped before canvas focus' }
        $captureRemoval = Invoke-Cdp 'removeCapture'
        if (-not $captureRemoval.result.removed) { throw "Could not remove generic transport capture listener before Neovim input: $($captureRemoval | ConvertTo-Json -Compress -Depth 4)" }
        $capsLockBefore = ([HookProbeNative]::GetKeyState(0x14) -band 1)
        if ($capsLockBefore -ne 0) { throw "Neovim layout smoke requires confirmed CapsLock OFF, current=$capsLockBefore; no input sent" }
        if (-not [string]::Equals([string]$probeStatus.targets.normalHkl, [string]$layoutTargets.normal, [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals([string]$probeStatus.targets.insertHkl, [string]$layoutTargets.insert, [StringComparison]::OrdinalIgnoreCase)) { throw "Native provider targets do not match enumerated installed HKLs: status=$($probeStatus.targets | ConvertTo-Json -Compress), selected=$($layoutTargets | ConvertTo-Json -Compress)" }
        $recordPath = $mcpBootstrap.output
        $handle = $mcpBootstrap.handle
        $normalBefore = $probeStatus.currentHkl
        if (-not [string]::Equals([string]$normalBefore, [string]$layoutTargets.normal, [StringComparison]::OrdinalIgnoreCase)) { throw "Neovim began in unexpected HKL $normalBefore; expected selected installed English HKL $($layoutTargets.normal)" }
        $insertRecordsBefore = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
        $insertNativeEventsBefore = @((Invoke-Cdp 'probeEvents').result.events)
        $insertScan = @(@{ Kind = 'Scan'; ScanCode = [uint16]0x17; Up = $false }, @{ Kind = 'Scan'; ScanCode = [uint16]0x17; Up = $true })
        Send-KeyBatch $ownedAppPid $insertScan $marker $log
        $insertDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $insertHkl = $null
        $insertObserved = $false
        $insertStatusReadback = $null
        do {
            $nativeEvents = (Invoke-Cdp 'probeEvents').result.events
            $newNativeEvents = @($nativeEvents | Select-Object -Skip $insertNativeEventsBefore.Count)
            $layoutEvents = @($newNativeEvents | Where-Object { $_.event -eq 'automation-probe-layout-changed' -and $_.payload.frontendId -ceq $probeStatus.frontendId })
            if ($layoutEvents.Count) { $insertHkl = [string]$layoutEvents[-1].payload.hkl }
            $insertStatusReadback = @($newNativeEvents | Where-Object { $_.event -eq 'automation-probe-status' -and $_.payload.frontendId -ceq $probeStatus.frontendId } | Select-Object -Last 1 | ForEach-Object payload)
            $insertObserved = [string]::Equals([string]$insertHkl, [string]$layoutTargets.insert, [StringComparison]::OrdinalIgnoreCase) -or [string]::Equals([string]$insertStatusReadback.currentHkl, [string]$layoutTargets.insert, [StringComparison]::OrdinalIgnoreCase)
            if ($insertObserved) { if (-not $insertHkl) { $insertHkl = [string]$insertStatusReadback.currentHkl }; break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $insertDeadline)
        $inserted = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
        $insertRecords = @($inserted | Select-Object -Skip $insertRecordsBefore.Count)
        $insertModeObserved = @($insertRecords | Where-Object { $_.mode -match '^i' -and $_.expectedCursorStyle -eq 'bar' }).Count -gt 0
        if (-not $insertObserved -or -not $insertHkl -or -not $insertModeObserved) { throw "Insert did not produce a new Insert/bar record and exact Russian HKL readback: native=$insertObserved hkl=$insertHkl records=$($insertRecords | ConvertTo-Json -Compress -Depth 5), events=$($nativeEvents | ConvertTo-Json -Compress -Depth 5)" }
        $hScan = @(@{ Kind = 'Scan'; ScanCode = [uint16]0x23; Up = $false }, @{ Kind = 'Scan'; ScanCode = [uint16]0x23; Up = $true })
        Send-KeyBatch $ownedAppPid $hScan $marker $log
        $textDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $textRecords = @()
        do {
            $textRecords = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
            if (@($textRecords | Where-Object { [regex]::IsMatch([string]$_.buffer, '[\u0400-\u04FF]') }).Count) { break }
            $null = Invoke-Mcp 'observe_terminal' @{ handle = $handle; timeoutMs = 400; quietMs = 100; includeScrollback = $false }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $textDeadline)
        $typedRussian = @($textRecords | Where-Object { [regex]::IsMatch([string]$_.buffer, '[\u0400-\u04FF]') })
        if (-not $typedRussian.Count) { throw "Physical H scan under the selected Russian HKL did not produce a Cyrillic character in the Neovim buffer: $($textRecords | ConvertTo-Json -Compress -Depth 5)" }
        $typedChar = [regex]::Match([string]$typedRussian[-1].buffer, '[\u0400-\u04FF]').Value
        $escapeRecordsBefore = $textRecords
        $escapeNativeEventsBefore = @((Invoke-Cdp 'probeEvents').result.events)
        $escScan = @(@{ Kind = 'Scan'; ScanCode = [uint16]0x01; Up = $false }, @{ Kind = 'Scan'; ScanCode = [uint16]0x01; Up = $true })
        Send-KeyBatch $ownedAppPid $escScan $marker $log
        $normalDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $normalObserved = $false
        $normalHkl = $null
        do {
            $normalEvents = (Invoke-Cdp 'probeEvents').result.events
            $newNormalEvents = @($normalEvents | Select-Object -Skip $escapeNativeEventsBefore.Count)
            $normalLayoutEvents = @($newNormalEvents | Where-Object { $_.event -eq 'automation-probe-layout-changed' -and $_.payload.frontendId -ceq $probeStatus.frontendId })
            if ($normalLayoutEvents.Count) { $normalHkl = [string]$normalLayoutEvents[-1].payload.hkl }
            $normalStatusReadback = @($newNormalEvents | Where-Object { $_.event -eq 'automation-probe-status' -and $_.payload.frontendId -ceq $probeStatus.frontendId } | Select-Object -Last 1 | ForEach-Object payload)
            if (-not $normalHkl) { $normalHkl = [string]$normalStatusReadback.currentHkl }
            $normalObserved = [string]::Equals([string]$normalHkl, [string]$layoutTargets.normal, [StringComparison]::OrdinalIgnoreCase)
            $freshRecords = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
            $normalRecords = @($freshRecords | Select-Object -Skip $escapeRecordsBefore.Count)
            $normalMode = @($normalRecords | Where-Object { $_.mode -notmatch '^i' -and $_.expectedCursorStyle -eq 'block' }).Count -gt 0
            if ($normalObserved -and $normalMode) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $normalDeadline)
        if (-not $normalObserved -or -not $normalMode) { throw "New Escape action did not produce Normal/block plus selected normal HKL: native=$normalObserved hkl=$normalHkl fixture=$normalMode records=$($normalRecords | ConvertTo-Json -Compress -Depth 5), events=$($newNormalEvents | ConvertTo-Json -Compress -Depth 5)" }
        $normalRecordsBeforeX = $freshRecords
        $xScan = @(@{ Kind = 'Scan'; ScanCode = [uint16]0x2D; Up = $false }, @{ Kind = 'Scan'; ScanCode = [uint16]0x2D; Up = $true })
        Send-KeyBatch $ownedAppPid $xScan $marker $log
        $deleteDeadline = [DateTime]::UtcNow.AddSeconds(4)
        $xRecords = @()
        do {
            $xRecords = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
            $xRecords = @($xRecords | Select-Object -Skip $normalRecordsBeforeX.Count)
            if (@($xRecords | Where-Object { -not ([string]$_.buffer).Contains($typedChar) }).Count) { break }
            $null = Invoke-Mcp 'observe_terminal' @{ handle = $handle; timeoutMs = 300; quietMs = 80; includeScrollback = $false }
        } while ([DateTime]::UtcNow -lt $deleteDeadline)
        $normalXDeleted = @($xRecords | Where-Object { -not ([string]$_.buffer).Contains($typedChar) }).Count -gt 0
        if (-not $normalXDeleted) { throw "English Normal-mode physical X scan did not delete the observed Russian-layout character '$typedChar': $($xRecords | ConvertTo-Json -Compress -Depth 5)" }
        $fastInsertRecordsBefore = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
        $fastInsertEventsBefore = @((Invoke-Cdp 'probeEvents').result.events)
        Send-KeyBatch $ownedAppPid $insertScan $marker $log
        $fastInsertDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $fastInsertReady = $false
        do {
            $fastInsertEvents = (Invoke-Cdp 'probeEvents').result.events
            $fastNewEvents = @($fastInsertEvents | Select-Object -Skip $fastInsertEventsBefore.Count)
            $fastHklEvent = @($fastNewEvents | Where-Object { $_.event -eq 'automation-probe-layout-changed' -and $_.payload.frontendId -ceq $probeStatus.frontendId -and [string]::Equals([string]$_.payload.hkl, [string]$layoutTargets.insert, [StringComparison]::OrdinalIgnoreCase) })
            $fastInsertRecords = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object -Skip $fastInsertRecordsBefore.Count)
            $fastInsertReady = $fastHklEvent.Count -gt 0 -and @($fastInsertRecords | Where-Object { $_.mode -match '^i' -and $_.expectedCursorStyle -eq 'bar' }).Count -gt 0
            if ($fastInsertReady) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $fastInsertDeadline)
        if (-not $fastInsertReady) { throw "Second Insert transition did not return to bar mode and Russian HKL: records=$($fastInsertRecords | ConvertTo-Json -Compress -Depth 4), events=$($fastNewEvents | ConvertTo-Json -Compress -Depth 5)" }
        Send-KeyBatch $ownedAppPid $hScan $marker $log
        $fastTypedDeadline = [DateTime]::UtcNow.AddSeconds(4)
        $fastTypedRecords = @()
        do {
            $fastTypedRecords = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
            if (@($fastTypedRecords | Where-Object { [regex]::IsMatch([string]$_.buffer, '[\u0400-\u04FF]') }).Count) { break }
            $null = Invoke-Mcp 'observe_terminal' @{ handle = $handle; timeoutMs = 300; quietMs = 80; includeScrollback = $false }
        } while ([DateTime]::UtcNow -lt $fastTypedDeadline)
        $fastTypedRussian = @($fastTypedRecords | Where-Object { [regex]::IsMatch([string]$_.buffer, '[\u0400-\u04FF]') })
        if (-not $fastTypedRussian.Count) { throw 'Second physical H scan under Russian layout did not produce a Cyrillic character' }
        $fastTypedChar = [regex]::Match([string]$fastTypedRussian[-1].buffer, '[\u0400-\u04FF]').Value
        $fastRecordsBeforeRace = $fastTypedRecords
        $fastEventsBeforeRace = @((Invoke-Cdp 'probeEvents').result.events)
        $raceInput = @(
            @{ Kind = 'Scan'; ScanCode = [uint16]0x01; Up = $false },
            @{ Kind = 'Scan'; ScanCode = [uint16]0x01; Up = $true },
            @{ Kind = 'Scan'; ScanCode = [uint16]0x2D; Up = $false },
            @{ Kind = 'Scan'; ScanCode = [uint16]0x2D; Up = $true }
        )
        $raceClock = [Diagnostics.Stopwatch]::StartNew()
        Send-KeyBatch $ownedAppPid $raceInput $marker $log
        $raceClock.Stop()
        $raceDeadline = [DateTime]::UtcNow.AddSeconds(3)
        $raceNormalObserved = $false
        $raceDeleted = $false
        do {
            $raceNativeEvents = (Invoke-Cdp 'probeEvents').result.events
            $raceNewNativeEvents = @($raceNativeEvents | Select-Object -Skip $fastEventsBeforeRace.Count)
            $raceNormalEvents = @($raceNewNativeEvents | Where-Object { $_.event -eq 'automation-probe-layout-changed' -and $_.payload.frontendId -ceq $probeStatus.frontendId -and [string]::Equals([string]$_.payload.hkl, [string]$layoutTargets.normal, [StringComparison]::OrdinalIgnoreCase) })
            $raceRecords = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object -Skip $fastRecordsBeforeRace.Count)
            $raceNormalMode = @($raceRecords | Where-Object { $_.mode -notmatch '^i' -and $_.expectedCursorStyle -eq 'block' }).Count -gt 0
            $raceDeleted = @($raceRecords | Where-Object { $_.kind -in @('TextChanged', 'TextChangedI') -and [string]::IsNullOrEmpty([string]$_.buffer) }).Count -gt 0
            $raceNormalObserved = $raceNormalEvents.Count -gt 0
            if ($raceDeleted -and $raceNormalObserved -and $raceNormalMode) { break }
            $null = Invoke-Mcp 'observe_terminal' @{ handle = $handle; timeoutMs = 300; quietMs = 80; includeScrollback = $false }
        } while ([DateTime]::UtcNow -lt $raceDeadline)
        $raceModeRecord = @($raceRecords | Where-Object { $_.kind -eq 'ModeChanged' -and $_.match -eq 'i:n' } | Select-Object -First 1)
        $raceKeyRecord = @($raceRecords | Where-Object { $_.kind -eq 'key' -and $_.mode -notmatch '^i' } | Select-Object -First 1)
        $raceModeToKeyMs = if ($raceModeRecord.Count -and $raceKeyRecord.Count) { ([double]$raceKeyRecord[0].at - [double]$raceModeRecord[0].at) / 1000000.0 } else { $null }
        $fastEscapeCommandRace = [pscustomobject]@{ status = if ($raceDeleted) { 'deleted' } else { 'missed-command' }; singleSendInputArray = $true; interKeyDelayMs = 0; fixtureModeToKeyMs = $raceModeToKeyMs; guardedBatchElapsedMs = $raceClock.Elapsed.TotalMilliseconds; elapsedIncludesPreflight = $true; deleted = $raceDeleted; deletionEvidence = 'new TextChanged/TextChangedI record with an empty buffer'; normalModeObserved = $raceNormalMode; normalHklObserved = $raceNormalObserved; records = @($raceRecords); nativeEvents = @($raceNewNativeEvents) }
        $focusCases = [Collections.Generic.List[object]]::new()
        $firstTabId = [string]$probeContext.tabId
        $preBlurProbe = (Invoke-Cdp 'frontendProbe').result
        $preBlurContext = $preBlurProbe.context
        $null = Invoke-Cdp 'probeClear'
        $blurResult = Invoke-Cdp 'focusSettingsButton'
        $blurDeadline = [DateTime]::UtcNow.AddSeconds(3)
        $blurProbe = $null
        $blurTrace = $null
        do {
            $blurProbe = (Invoke-Cdp 'frontendProbe').result
            if ($blurProbe.context -and -not $blurProbe.context.focused -and [int]$blurProbe.context.generation -gt [int]$preBlurContext.generation) {
                $blurTrace = Get-LastProbeTrace
                if (-not $blurTrace.armed) { break }
            }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $blurDeadline)
        $beforeStaleHklInfo = Assert-DevTarget $ownedAppPid
        $beforeStaleHkl = '0x{0:X}' -f (Convert-HklToUInt64 ([HookProbeNative]::GetKeyboardLayout([uint32]$beforeStaleHklInfo.FocusThreadId)))
        $staleRequest = @{ frontendId = $probeStatus.frontendId; tabId = $preBlurContext.tabId; generation = [int]$preBlurContext.generation; hkl = [string]$layoutTargets.insert }
        $staleEmit = Invoke-Cdp 'probeLayoutRequest' ($staleRequest | ConvertTo-Json -Compress)
        $staleDeadline = [DateTime]::UtcNow.AddSeconds(3)
        $staleError = $null
        $afterStaleHkl = $null
        do {
            $nativeEvents = @((Invoke-Cdp 'probeEvents').result.events)
            $staleError = @($nativeEvents | Where-Object { $_.event -eq 'automation-probe-layout-error' -and $_.payload.frontendId -ceq $probeStatus.frontendId -and [int]$_.payload.generation -eq [int]$preBlurContext.generation } | Select-Object -Last 1 | ForEach-Object payload)
            $currentFocus = Assert-DevTarget $ownedAppPid
            $afterStaleHkl = '0x{0:X}' -f (Convert-HklToUInt64 ([HookProbeNative]::GetKeyboardLayout([uint32]$currentFocus.FocusThreadId)))
            if ($staleError.Count -and $afterStaleHkl -eq $beforeStaleHkl) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $staleDeadline)
        $staleRejected = [bool]$staleEmit.result.emitted -and @($staleError).Count -gt 0 -and $afterStaleHkl -eq $beforeStaleHkl -and -not $blurTrace.armed
        $focusCases.Add([pscustomobject]@{ case = 'canvas-blur-and-stale-layout-request'; settingsClick = $blurResult.result; frontendContext = $blurProbe.context; nativeArmedAfterBlur = $blurTrace.armed; oldContextRequest = $staleRequest; emitResult = $staleEmit.result; rejection = $staleError; hklBefore = $beforeStaleHkl; hklAfter = $afterStaleHkl; passed = $staleRejected })
        $terminalRuns.Add([pscustomobject]@{ stage = 'focus-stale-request-case'; case = $focusCases[-1] })
        $focusAgain = Invoke-Cdp 'focusTerminal'
        $refocusDeadline = [DateTime]::UtcNow.AddSeconds(3)
        $refocusProbe = $null
        $refocusTrace = $null
        do {
            $refocusProbe = (Invoke-Cdp 'frontendProbe').result
            if ($focusAgain.result.terminalFocused -and $refocusProbe.context.focused -and $refocusProbe.context.tabId -eq $firstTabId) {
                $refocusTrace = Get-LastProbeTrace
                if ($refocusTrace.armed) { break }
            }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $refocusDeadline)
        $focusCases.Add([pscustomobject]@{ case = 'canvas-refocus-rearms-original-tab'; focused = $focusAgain.result.terminalFocused; context = $refocusProbe.context; nativeArmed = $refocusTrace.armed; passed = [bool]$focusAgain.result.terminalFocused -and [bool]$refocusTrace.armed -and $refocusProbe.context.tabId -eq $firstTabId })
        $terminalRuns.Add([pscustomobject]@{ stage = 'focus-refocus-case'; case = $focusCases[-1] })

        # Leave the first fixture in Insert, then send a bounded WM_INPUTLANGCHANGEREQUEST to its exact focused WebView child.
        $firstInsertRecordsBeforeExternal = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
        $firstInsertEventsBeforeExternal = @((Invoke-Cdp 'probeEvents').result.events)
        Send-KeyBatch $ownedAppPid $insertScan $marker $log
        $firstInsertDeadline = [DateTime]::UtcNow.AddSeconds(4)
        $firstInsertReady = $false
        do {
            $firstInsertRecords = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object -Skip $firstInsertRecordsBeforeExternal.Count)
            $firstInsertEvents = @((Invoke-Cdp 'probeEvents').result.events | Select-Object -Skip $firstInsertEventsBeforeExternal.Count)
            $firstRussian = @($firstInsertEvents | Where-Object { $_.event -eq 'automation-probe-layout-changed' -and $_.payload.tabId -ceq $firstTabId -and [string]::Equals([string]$_.payload.hkl, [string]$layoutTargets.insert, [StringComparison]::OrdinalIgnoreCase) })
            $firstInsertReady = @($firstInsertRecords | Where-Object { $_.kind -eq 'ModeChanged' -and $_.match -eq 'n:i' }).Count -gt 0 -and $firstRussian.Count -gt 0
            if ($firstInsertReady) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $firstInsertDeadline)
        $firstFocus = Assert-DevTarget $ownedAppPid
        $firstEnglishRequest = [UInt64]::Parse(([string]$layoutTargets.normal).Substring(2), [Globalization.NumberStyles]::HexNumber, [Globalization.CultureInfo]::InvariantCulture)
        $externalPosted = [HookProbeNative]::PostInputLanguageChangeRequest($firstFocus.Focus, $firstEnglishRequest)
        $firstExternalDeadline = [DateTime]::UtcNow.AddSeconds(3)
        $firstObservedEnglish = $false
        do {
            $externalEvents = @((Invoke-Cdp 'probeEvents').result.events | Select-Object -Skip $firstInsertEventsBeforeExternal.Count)
            $firstObservedEnglish = @($externalEvents | Where-Object { $_.event -eq 'automation-probe-layout-changed' -and $_.payload.tabId -ceq $firstTabId -and $_.payload.source -eq 'observed' -and [string]::Equals([string]$_.payload.hkl, [string]$layoutTargets.normal, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
            if ($firstObservedEnglish) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $firstExternalDeadline)
        $focusCases.Add([pscustomobject]@{ case = 'first-tab-insert-remembers-external-English'; tabId = $firstTabId; enteredInsertAndRussian = $firstInsertReady; postedExternalHkl = $layoutTargets.normal; postAccepted = $externalPosted; observedByNativePoller = $firstObservedEnglish; events = @($externalEvents); passed = $firstInsertReady -and $externalPosted -and $firstObservedEnglish })
        $terminalRuns.Add([pscustomobject]@{ stage = 'external-layout-observation-case'; case = $focusCases[-1] })

        $secondRecordPath = Join-Path $artifactDir "$runId-nvim-second.jsonl"
        $secondCommand = "`$env:STERM_PROBE_OUTPUT='$secondRecordPath'; & '$($nvim.Source)' --clean -u '$fixturePath'"
        $secondCreate = Invoke-Mcp 'create_terminal' @{ command = 'pwsh.exe'; args = @('-NoProfile', '-Command', $secondCommand); cwd = $root; cols = 100; rows = 30 }
        $secondHandle = Get-McpHandle $secondCreate
        $mcpHandles.Add($secondHandle)
        $secondReadyDeadline = [DateTime]::UtcNow.AddSeconds(20)
        $secondReady = $false
        do {
            $null = Invoke-Mcp 'observe_terminal' @{ handle = $secondHandle; timeoutMs = 700; quietMs = 100; includeScrollback = $false }
            if (Test-Path -LiteralPath $secondRecordPath) {
                $secondRecords = @(Get-Content -LiteralPath $secondRecordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
                if (@($secondRecords | Where-Object kind -eq 'ready').Count) { $secondReady = $true; break }
            }
        } while ([DateTime]::UtcNow -lt $secondReadyDeadline)
        if (-not $secondReady) { throw "Second Neovim fixture did not become ready: $(Get-Content -LiteralPath $secondRecordPath -Raw -ErrorAction SilentlyContinue)" }
        $activeSecond = $null
        $secondContextDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $activeSecond = (Invoke-Cdp 'frontendProbe').result.context
            if ($activeSecond.tabId -and $activeSecond.tabId -ne $firstTabId) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $secondContextDeadline)
        $secondTabId = [string]$activeSecond.tabId
        if (-not $secondTabId -or $secondTabId -eq $firstTabId) { throw "Second MCP Neovim tab did not become the active context: $(($activeSecond | ConvertTo-Json -Compress))" }
        $secondFocus = Invoke-Cdp 'focusTerminal'
        $secondInsertEventsBefore = @((Invoke-Cdp 'probeEvents').result.events)
        $secondInsertBefore = @(Get-Content -LiteralPath $secondRecordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
        Send-KeyBatch $ownedAppPid $insertScan $marker $log
        $secondInsertDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $secondRussian = $false
        do {
            $secondEvents = @((Invoke-Cdp 'probeEvents').result.events | Select-Object -Skip $secondInsertEventsBefore.Count)
            $secondRecordsNow = @(Get-Content -LiteralPath $secondRecordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object -Skip $secondInsertBefore.Count)
            $secondRussian = @($secondEvents | Where-Object { $_.event -eq 'automation-probe-layout-changed' -and $_.payload.tabId -ceq $secondTabId -and [string]::Equals([string]$_.payload.hkl, [string]$layoutTargets.insert, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
            if ($secondRussian -and @($secondRecordsNow | Where-Object { $_.kind -eq 'ModeChanged' -and $_.match -eq 'n:i' }).Count) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $secondInsertDeadline)
        $tabSelect = Invoke-Cdp 'selectTerminalTab' ($firstTabId | ConvertTo-Json -Compress)
        $firstRefocus = Invoke-Cdp 'focusTerminal'
        $firstReturnDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $firstReturnedEnglish = $false
        do {
            $returnContext = (Invoke-Cdp 'frontendProbe').result.context
            $returnEvents = @((Invoke-Cdp 'probeEvents').result.events)
            $firstReturnedEnglish = $returnContext.tabId -ceq $firstTabId -and $returnContext.focused -and @($returnEvents | Where-Object { $_.event -eq 'automation-probe-layout-changed' -and $_.payload.tabId -ceq $firstTabId -and [string]::Equals([string]$_.payload.hkl, [string]$layoutTargets.normal, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
            if ($firstReturnedEnglish) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $firstReturnDeadline)
        $focusCases.Add([pscustomobject]@{ case = 'tab-specific-insert-layout-restores-on-return'; firstTabId = $firstTabId; secondTabId = $secondTabId; secondTabInsertRussian = $secondRussian; selection = $tabSelect.result; firstTabRefocused = $firstRefocus.result.terminalFocused; firstTabReturnedEnglish = $firstReturnedEnglish; secondTabRecords = @($secondRecordsNow); passed = $secondRussian -and $firstReturnedEnglish -and $firstRefocus.result.terminalFocused })
        $terminalRuns.Add([pscustomobject]@{ stage = 'per-tab-layout-case'; case = $focusCases[-1] })
        $terminalRuns.Add([pscustomobject]@{ mode = 'nvim-layout'; handle = $handle; command = $mcpBootstrap.command; output = $recordPath; targetHkls = $layoutTargets; modeInsertObserved = $insertModeObserved; hklInsertObserved = $insertHkl; physicalScanH = '0x23'; bufferHasRussianCharacter = $true; characterTyped = $typedChar; escapeNormalAndBlock = $normalMode; hklNormalObserved = $normalObserved; normalHklReadback = $normalHkl; normalXDeleted = $normalXDeleted; fastEscapeCommandRace = $fastEscapeCommandRace; focusCases = @($focusCases); records = @($freshRecords) + @($xRecords) + @($raceRecords) + @($firstInsertRecords) + @($secondRecordsNow); nativeEvents = @($normalEvents) + @($raceNewNativeEvents) + @($externalEvents) + @($secondEvents) + @($returnEvents); capsBefore = $capsLockBefore })
        $capsLockAfter = ([HookProbeNative]::GetKeyState(0x14) -band 1)
        if ($capsLockAfter -ne $capsLockBefore) { throw "CapsLock changed during Neovim layout smoke ($capsLockBefore -> $capsLockAfter)" }
        $null = Invoke-Mcp 'close_terminal' @{ handle = $handle }
        [void]$mcpHandles.Remove($handle)
        $events = @($terminalRuns)
    }

    if ($TerminalRecorderSmoke) {
        $null = Invoke-Cdp 'removeCapture'
        $fixturePath = Join-Path $PSScriptRoot 'fixtures\ProbeRecorder.ps1'
        $recordingDir = Join-Path $artifactDir 'recordings'
        New-Item -ItemType Directory -Force -Path $recordingDir | Out-Null
        if (-not [string]::Equals([string]$probeStatus.currentHkl, '0x4090409', [StringComparison]::OrdinalIgnoreCase)) { throw "Scan-code shell command typing requires the measured US-English HKL 0x4090409; current=$($probeStatus.currentHkl)" }
        foreach ($recorderMode in @('vt', 'win32')) {
            $recordPath = Join-Path $recordingDir "$runId-plain-$recorderMode.jsonl"
            $stopAfter = if ($recorderMode -eq 'vt') { 2 } else { 4 }
            $command = "pwsh -NoProfile -File $fixturePath -Mode $recorderMode -Output $recordPath -StopAfter $stopAfter".ToLowerInvariant()
            $stateBeforeLaunch = (Invoke-Cdp 'state').result
            if (-not $stateBeforeLaunch.pageFocused -or -not $stateBeforeLaunch.terminalFocused) { throw "Terminal canvas lost focus before launching $recorderMode recorder" }
            Send-ProbeText $ownedAppPid $command $marker $log
            $launchDeadline = [DateTime]::UtcNow.AddSeconds(8)
            $recorderProcesses = @()
            do {
                $recorderProcesses = @(Get-RecorderProcesses $fixturePath $recorderMode $ownedAppPid)
                if ($recorderProcesses.Count) { break }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $launchDeadline)
            if ($recorderProcesses.Count -ne 1) { throw "Could not identify exactly one owned $recorderMode recorder child process (count=$($recorderProcesses.Count))" }
            $recorderLaunches.Add([pscustomobject]@{ mode = $recorderMode; pid = [int]$recorderProcesses[0].ProcessId; parentPid = [int]$recorderProcesses[0].ParentProcessId; commandLine = $recorderProcesses[0].CommandLine })
            $readyPath = "$recordPath.ready"
            $readyDeadline = [DateTime]::UtcNow.AddSeconds(8)
            $readyText = $null
            $statusPath = "$recordPath.status.json"
            $startupErrorPath = "$recordPath.startup-error.txt"
            do {
                if (Test-Path -LiteralPath $readyPath) { $readyText = Get-Content -LiteralPath $readyPath -Raw; if ($readyText -match "mode=$recorderMode\s+pid=$([int]$recorderProcesses[0].ProcessId)\b") { break } }
                if (Test-Path -LiteralPath $startupErrorPath) { throw "$recorderMode recorder startup error: $(Get-Content -LiteralPath $startupErrorPath -Raw); status=$(Get-Content -LiteralPath $statusPath -Raw -ErrorAction SilentlyContinue)" }
                if (-not (Get-Process -Id ([int]$recorderProcesses[0].ProcessId) -ErrorAction SilentlyContinue)) { throw "$recorderMode recorder exited before READY sentinel; launch=$($recorderLaunches[-1] | ConvertTo-Json -Compress)" }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $readyDeadline)
            if ($readyText -notmatch "mode=$recorderMode\s+pid=$([int]$recorderProcesses[0].ProcessId)\b") { throw "$recorderMode recorder did not publish its exact READY sentinel within 8s; launch=$($recorderLaunches[-1] | ConvertTo-Json -Compress), sentinel=$readyText, status=$(Get-Content -LiteralPath $statusPath -Raw -ErrorAction SilentlyContinue)" }
            Send-KeyBatch $ownedAppPid @(@{ VirtualKey = [uint16]0xFC; Up = $false }, @{ VirtualKey = [uint16]0xFC; Up = $true }) $probeTokenMarker $log
            $ctrlH = @(
                @{ VirtualKey = [uint16]0xFC; Up = $false },
                @{ VirtualKey = [uint16]0x48; Up = $false },
                @{ VirtualKey = [uint16]0x48; Up = $true },
                @{ VirtualKey = [uint16]0xFC; Up = $true }
            )
            Send-KeyBatch $ownedAppPid $ctrlH $probeTokenMarker $log
            $recordDeadline = [DateTime]::UtcNow.AddSeconds(10)
            do {
                $processNow = Get-Process -Id ([int]$recorderProcesses[0].ProcessId) -ErrorAction SilentlyContinue
                if (-not $processNow -and (Test-Path -LiteralPath $recordPath)) { break }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $recordDeadline)
            if ((Get-Process -Id ([int]$recorderProcesses[0].ProcessId) -ErrorAction SilentlyContinue)) {
                $stillOwned = Get-RecorderProcesses $fixturePath $recorderMode $ownedAppPid
                if ($stillOwned.Count -eq 1 -and [int]$stillOwned[0].ProcessId -eq [int]$recorderProcesses[0].ProcessId) { Stop-Process -Id ([int]$recorderProcesses[0].ProcessId) -Force }
                throw "$recorderMode recorder did not finish after its exact expected input count"
            }
            if (-not (Test-Path -LiteralPath $recordPath)) { throw "$recorderMode recorder exited without producing its JSONL artifact" }
            $records = @(Get-Content -LiteralPath $recordPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
            if ($recorderMode -eq 'vt') {
                $validRecords = $records.Count -eq 2 -and $records[0].hex -eq '1B' -and $records[1].hex -eq '08'
            } else {
                $escRecords = @($records | Where-Object vk -eq 27)
                $hRecords = @($records | Where-Object vk -eq 72)
                $validRecords = $records.Count -eq 4 -and $escRecords.Count -eq 2 -and $escRecords[0].keyDown -and -not $escRecords[1].keyDown -and $hRecords.Count -eq 2 -and $hRecords[0].keyDown -and -not $hRecords[1].keyDown -and (($hRecords[0].controlState -band 0xC) -ne 0)
            }
            $terminalRuns.Add([pscustomobject]@{ mode = $recorderMode; command = $command; processId = [int]$recorderProcesses[0].ProcessId; output = $recordPath; records = @($records); exactExpectedInputObserved = [bool]$validRecords })
            if (-not $validRecords) { throw "$recorderMode PTY recorder observed an unexpected Escape/Ctrl-H sequence: $($records | ConvertTo-Json -Compress -Depth 5)" }
        }
        $capsLockBefore = ([HookProbeNative]::GetKeyState(0x14) -band 1)
        $capsLockAfter = $capsLockBefore
        $events = @($terminalRuns)
    }

    if ($TransportSmoke) {
    $beforeControl = Invoke-Cdp 'state'
    if (-not $beforeControl.result.pageFocused -or -not $beforeControl.result.terminalFocused -or $beforeControl.result.windowLogCount -ne 0) { throw "Control-A preflight failed: $($beforeControl | ConvertTo-Json -Compress -Depth 5)" }
    Send-KeyBatch $ownedAppPid @(@{ VirtualKey = [uint16]0x41; Up = $false }, @{ VirtualKey = [uint16]0x41; Up = $true }) $marker $log
    $controlAEvents = Wait-Capture 2
    if ($controlAEvents.Count -ne 2 -or @($controlAEvents | Where-Object keyCode -eq 65).Count -ne 2 -or @($controlAEvents | Where-Object { -not $_.defaultPrevented }).Count -ne 0) { throw "Guarded A control did not produce two canceled keyCode 65 events: $($controlAEvents | ConvertTo-Json -Compress -Depth 5)" }
    if (@($controlAEvents | Where-Object type -eq 'keydown').Count -ne 1 -or @($controlAEvents | Where-Object type -eq 'keyup').Count -ne 1) { throw 'Guarded A control did not produce one down/up pair' }
    $afterControl = Invoke-Cdp 'state'
    $controlAState = @{ before = $beforeControl.result; after = $afterControl.result }
    if (-not $afterControl.result.pageFocused -or -not $afterControl.result.terminalFocused -or $afterControl.result.windowLogCount -ne 2) { throw "A control lost page/canvas focus or log count: $($afterControl | ConvertTo-Json -Compress -Depth 5)" }
    $clearControl = Invoke-Cdp 'clear'
    if (-not $clearControl.result.cleared -or $clearControl.result.count -ne 2) { throw 'Could not clear guarded A control events' }

    $sequence = @(
        @{ VirtualKey = [uint16]0xFC; Up = $false }, @{ VirtualKey = [uint16]0xFC; Up = $true },
        @{ VirtualKey = [uint16]0x41; Up = $false }, @{ VirtualKey = [uint16]0x41; Up = $true }
    )
    Send-KeyBatch $ownedAppPid $sequence $marker $log
    $tokenEvents = Wait-Capture 2
    $tokenKeys = @($tokenEvents | Where-Object { $_.key -eq 'Unidentified' -and $_.keyCode -in @(0, 252) -and $_.code -in @('', 'Unidentified') })
    $letters = @($tokenEvents | Where-Object keyCode -eq 65)
    if ($tokenKeys.Count -ne 2 -or @($tokenKeys | Where-Object type -eq 'keydown').Count -ne 1 -or @($tokenKeys | Where-Object type -eq 'keyup').Count -ne 1) { $tokenFailure = "VK_NONAME did not produce exactly one keyCode 0 down/up pair; saw $($tokenKeys.Count) token events" }
    if ($letters.Count -ne 2 -or @($letters | Where-Object type -eq 'keydown').Count -ne 1 -or @($letters | Where-Object type -eq 'keyup').Count -ne 1) { throw "Post-token A control did not produce keyCode 65 down/up: $($tokenEvents | ConvertTo-Json -Compress -Depth 5)" }
    if (@($tokenEvents | Where-Object { -not $_.defaultPrevented }).Count -ne 0) { throw 'At least one token or A event escaped the capture-and-cancel listener' }
    $tokenUpIndex = -1
    $letterDownIndex = -1
    for ($i = 0; $i -lt $tokenEvents.Count; $i++) {
        if ($tokenUpIndex -lt 0 -and $tokenEvents[$i].key -eq 'Unidentified' -and $tokenEvents[$i].keyCode -in @(0, 252) -and $tokenEvents[$i].type -eq 'keyup') { $tokenUpIndex = $i }
        if ($letterDownIndex -lt 0 -and $tokenEvents[$i].keyCode -eq 65 -and $tokenEvents[$i].type -eq 'keydown') { $letterDownIndex = $i }
    }
    if ($tokenUpIndex -ge 0 -and $letterDownIndex -le $tokenUpIndex) { $tokenFailure = 'A DOM A keydown did not follow the VK_NONAME keyup' }
    $events = @($tokenEvents)
    $cdpDiagnostic = @{ install = $install; beforeInput = $emptyCapture; syntheticCheck = $syntheticCheck; controlA = $controlAState }

    # F24 is synthetic here: verify ordinary WebView identity while preserving the real function-key mapping.
    $clearToken = Invoke-Cdp 'clear'
    if (-not $clearToken.result.cleared -or $clearToken.result.count -ne $tokenEvents.Count) { throw 'Could not clear VK_NONAME/control-A events before F24' }
    Send-KeyBatch $ownedAppPid @(@{ VirtualKey = [uint16]0x87; Up = $false }, @{ VirtualKey = [uint16]0x87; Up = $true }) $marker $log
    $f24Events = Wait-Capture 2
    $f24 = @($f24Events | Where-Object keyCode -eq 135)
    if ($f24.Count -ne 2 -or @($f24 | Where-Object type -eq 'keydown').Count -ne 1 -or @($f24 | Where-Object type -eq 'keyup').Count -ne 1 -or @($f24 | Where-Object { -not $_.defaultPrevented }).Count -ne 0) { throw "Expected a consumed F24 down/up pair: $($f24Events | ConvertTo-Json -Compress -Depth 5)" }
    $events = @($f24Events)
    if ($tokenFailure) { $failure = $tokenFailure }
    }
} catch {
    $failure = $_.Exception.Message
} finally {
    $primaryFailure = $failure
    $cleanupFailures = [System.Collections.Generic.List[string]]::new()
    if ($ownedAppPid) {
        try { $probeFrontendAfter = (Invoke-Cdp 'frontendProbe').result } catch { }
        try { $probeNativeEventsAtFailure = (Invoke-Cdp 'probeEvents').result.events } catch { }
        try { $domEventsAtFailure = (Invoke-Cdp 'events').result.events } catch { }
    }
    # Release partial batches while their exact terminal canvas is still active; do this before tab closure or reload.
    if ($log.Count -gt 0 -and $log[$log.Count - 1].sentCount -gt 0 -and $log[$log.Count - 1].sentCount -lt $log[$log.Count - 1].eventCount -and $ownedAppPid) {
        try {
            $inserted = [int]$log[$log.Count - 1].sentCount
            $downKeys = [Collections.Generic.List[object]]::new()
            foreach ($entry in $currentBatch[0..([Math]::Min($inserted - 1, $currentBatch.Count - 1))]) {
                $identity = if ($entry.Kind -eq 'Scan') { "Scan:$($entry.ScanCode)" } elseif ($entry.Kind -eq 'Unicode') { "Unicode:$([int][char]$entry.TextChar)" } else { "VirtualKey:$($entry.VirtualKey)" }
                $existing = @($downKeys | Where-Object identity -eq $identity)
                if (-not $entry.Up -and -not $existing.Count) { $downKeys.Add([pscustomobject]@{ identity = $identity; spec = $entry }) }
                elseif ($entry.Up -and $existing.Count) { $downKeys.Remove($existing[0]) }
            }
            if ($downKeys.Count) {
                $releases = @($downKeys | ForEach-Object { $entry = $_.spec; if ($entry.Kind -eq 'Scan') { @{ Kind = 'Scan'; ScanCode = [uint16]$entry.ScanCode; Up = $true } } elseif ($entry.Kind -eq 'Unicode') { @{ Kind = 'Unicode'; TextChar = [char]$entry.TextChar; Up = $true } } else { @{ VirtualKey = [uint16]$entry.VirtualKey; Up = $true } } })
                Send-KeyBatch $ownedAppPid $releases $script:currentBatchMarker $log
                $releaseAttempt = 'sent guarded key-up cleanup on original focused terminal canvas'
            }
        } catch { $releaseAttempt = "blocked or failed before tab/window cleanup: $($_.Exception.Message)"; $cleanupFailures.Add("partial input cleanup failed: $releaseAttempt") }
    }
    foreach ($handle in @($mcpHandles.ToArray())) {
        try { $null = Invoke-Mcp 'close_terminal' @{ handle = $handle } } catch { $cleanupFailures.Add("MCP terminal cleanup for '$handle' failed: $($_.Exception.Message)") }
    }
    if ($script:mcpClient) {
        try {
            if (-not $script:mcpClient.HasExited) {
                $script:mcpClient.StandardInput.Close()
                if (-not $script:mcpClient.WaitForExit(2500)) { $script:mcpClient.Kill(); $cleanupFailures.Add('MCP bridge exceeded the 2.5s shutdown bound and was killed') }
            }
        } catch { $cleanupFailures.Add("MCP bridge shutdown failed: $($_.Exception.Message)") }
    }
    if ($devStorageCaptured) {
        try {
            $restoreArgument = ConvertTo-Json -InputObject $devStorageRaw -Compress
            $restore = Invoke-Cdp 'restoreDevMcp' $restoreArgument
            if ($restore.result.origin -cne 'http://localhost:5173' -or -not $restore.result.restored) { throw "raw storage restore did not read back exactly: $($restore | ConvertTo-Json -Compress -Depth 5)" }
            $null = Invoke-Cdp 'reload'
            $restoreDeadline = [DateTime]::UtcNow.AddSeconds(8)
            $restorePage = $null
            do {
                try { $restorePage = Invoke-Cdp 'state'; if ($restorePage.target.title -ceq 'Scanline Term') { break } } catch { }
                Start-Sleep -Milliseconds 200
            } while ([DateTime]::UtcNow -lt $restoreDeadline)
            if (-not $restorePage -or $restorePage.target.title -cne 'Scanline Term') { throw 'dev page did not return after exact settings restore/reload' }
        } catch { $cleanupFailures.Add("dev MCP setting restore failed: $($_.Exception.Message)") }
    }
    if ($ownedAppPid) {
        try {
            $owned = Get-Process -Id $ownedAppPid -ErrorAction Stop
            [void]$owned.CloseMainWindow()
            if (-not $owned.WaitForExit(2500)) { Stop-Process -Id $ownedAppPid -Force -ErrorAction SilentlyContinue }
        } catch { }
    }
    if ($launcher -and -not $launcher.HasExited) {
        try { & taskkill.exe /PID $launcher.Id /T /F | Out-Null } catch { }
    }
    if ($null -eq $oldBrowserArgs) { Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue }
    else { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldBrowserArgs }
    if ($null -eq $oldCdpPort) { Remove-Item Env:STERM_PROBE_CDP_PORT -ErrorAction SilentlyContinue }
    else { $env:STERM_PROBE_CDP_PORT = $oldCdpPort }
    if ($null -eq $oldProbeEnv) { Remove-Item Env:SCANLINE_TERM_AUTOMATION_PROBE -ErrorAction SilentlyContinue }
    else { $env:SCANLINE_TERM_AUTOMATION_PROBE = $oldProbeEnv }
    if ($null -eq $oldNormalHkl) { Remove-Item Env:SCANLINE_TERM_AUTOMATION_PROBE_NORMAL_HKL -ErrorAction SilentlyContinue }
    else { $env:SCANLINE_TERM_AUTOMATION_PROBE_NORMAL_HKL = $oldNormalHkl }
    if ($null -eq $oldInsertHkl) { Remove-Item Env:SCANLINE_TERM_AUTOMATION_PROBE_INSERT_HKL -ErrorAction SilentlyContinue }
    else { $env:SCANLINE_TERM_AUTOMATION_PROBE_INSERT_HKL = $oldInsertHkl }
    if (($ProbeStress -or $CapsOnlySmoke -or $HookSequenceSmoke -or $TerminalRecorderSmoke) -and $null -ne $capsLockBefore -and $capsLockBefore -eq 0) {
        try {
            $currentCaps = ([HookProbeNative]::GetKeyState(0x14) -band 1)
            if ($currentCaps -eq 1) {
                $restoreScript = Join-Path $PSScriptRoot 'CapsRestore.ps1'
                $restoreStdout = Join-Path $artifactDir "$runId-caps-restore.stdout"
                $restoreStderr = Join-Path $artifactDir "$runId-caps-restore.stderr"
                $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
                $child = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-File', ('"{0}"' -f $restoreScript)) -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $restoreStdout -RedirectStandardError $restoreStderr
                $restoreArtifact = Join-Path $artifactDir 'caps-restore.json'
                $capsRestore = if (Test-Path $restoreArtifact) { Get-Content $restoreArtifact -Raw | ConvertFrom-Json } else { $null }
                $finalCaps = ([HookProbeNative]::GetKeyState(0x14) -band 1)
                if ($finalCaps -ne 0) { throw "Fresh runner-thread state still reads CapsLock ON (childExit=$($child.ExitCode), helper=$($capsRestore | ConvertTo-Json -Compress -Depth 3))" }
                if ($child.ExitCode -eq 0 -and $capsRestore -and $capsRestore.status -eq 'pass') {
                    $capsRestore = "restored OFF via disposable helper; helperUI=$($capsRestore.uiThread.threadId); SendInput=$($capsRestore.sendInput.returned)"
                } else {
                    $capsRestore = "runner-thread read OFF after helper; helper UI sample disagreed (helperExit=$($child.ExitCode), helperSample=$($capsRestore.finalCaps))"
                }
            } else { $capsRestore = 'already at original OFF baseline after app closed' }
        } catch { $capsRestore = "cleanup helper failed: $($_.Exception.Message)"; $cleanupFailures.Add($capsRestore) }
    }
    $failure = @(@($primaryFailure) + @($cleanupFailures | ForEach-Object { "cleanup: $_" }) | Where-Object { $_ }) -join '; '
    $artifact = [ordered]@{
        runId = $runId; status = if ($failure) { 'fail' } else { 'pass' }; target = $windowTitle
        executable = $debugExe; pid = $ownedAppPid; token = if ($CallbackSmoke -or $CapsOnlySmoke -or $HookSequenceSmoke) { 'none; native hook diagnostic only' } else { 'VK_NONAME (0xFC)' }; marker = '0x535445524D434150'
        sequence = if ($ProbeStress) { @('CapsLock down', 'H down', 'H up', 'CapsLock up') } elseif ($CallbackSmoke) { @('A down', 'A up') } elseif ($CapsOnlySmoke) { @('CapsLock down', 'CapsLock up') } elseif ($HookSequenceSmoke) { @('up to four A down/up warmups until hook callback observed', 'CapsLock VK down/up comparison', 'CapsLock VK down/up restore if changed', 'single array: scan Caps 0x3A down, H down, H up, scan Caps up') } elseif ($McpTerminalSmoke) { @('dev-only mcpEnabled raw snapshot', 'MCP debug-sidecar Win32 then VT recorder create + READY', 'marked VK_NONAME tap => Escape', 'marked VK_NONAME/H chord => Ctrl-H; Caps never injected') } elseif ($NvimLayoutSmoke) { @('MCP-created Neovim fixture', 'physical scan-code Insert and H under selected layouts', 'physical Escape and text assertion') } elseif ($TerminalRecorderSmoke) { @('legacy typed recorder path; no longer preferred', 'marked VK_NONAME down/up tap → terminal Escape', 'marked VK_NONAME down, H down/up, VK_NONAME up → terminal Ctrl-H') } else { @('VK_NONAME down', 'VK_NONAME up', 'A down', 'A up', 'F24 down', 'F24 up') }
        sendInputCalls = @($log); recorderLaunches = @($recorderLaunches); hookSteps = @($hookSteps); terminalRuns = @($terminalRuns); syntheticEvents = @($syntheticEvents); controlAEvents = @($controlAEvents); controlAState = $controlAState; tokenEvents = @($tokenEvents); f24Events = @($f24Events); cdpDiagnostic = $cdpDiagnostic; partialBatchRecovery = $releaseAttempt; error = $failure
        focusReport = $focusReport; focusAttempts = @($focusAttempts); probeStatus = $probeStatus; webviewHostClass = if ($script:pinnedWebviewHwnd -eq [IntPtr]::Zero) { $null } else { Get-HwndClassName $script:pinnedWebviewHwnd }; probeContext = $probeContext; probeTraceBefore = $probeTraceBefore; probeTraceAfter = $probeTraceAfter; probeFrontendBefore = $probeFrontendBefore; probeFrontendAfter = $probeFrontendAfter; probeNativeEventsAtFailure = @($probeNativeEventsAtFailure); domEventsAtFailure = @($domEventsAtFailure); probeDomEvents = @($probeDomEvents); capsLockBefore = $capsLockBefore; capsLockAfter = $capsLockAfter; capsLockRestore = $capsRestore
        physicalKeyStatus = 'not tested; this smoke uses synthetic SendInput only'
        devSettingsSnapshot = if ($devStorageCaptured) { $devStoragePath } else { $null }; mcpBridgePid = $script:mcpClientPid; mcpStartupDiagnostics = $script:mcpStartupDiagnostics; layoutTargets = $layoutTargets
        cleanup = 'owned MCP terminals closed; helper exited; exact dev mcpEnabled raw value restored before final reload; owned dev app/launcher closed; process environment restored'
    }
    $artifact | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $artifactPath -Encoding utf8
}

Get-Content -LiteralPath $artifactPath -Raw
if ($failure) { throw "$modeName failed: $failure (artifact: $artifactPath)" }
