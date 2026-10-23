# Debug automation probe

This folder contains a retained Windows-only probe for CapsLock edge routing and keyboard-layout readback. It is test scaffolding: the native hook is compiled only in debug builds and is enabled only with `SCANLINE_TERM_AUTOMATION_PROBE=1`. There is no Lua runtime, production setting, or shipping approval in this work.

## Prerequisites and safety

- Run on Windows from the repository root with PowerShell 7, Node 24, the Rust debug build, and the dependencies used by `npm run tauri:dev`.
- The runner owns the dev app it starts and checks the exact debug executable, title `Scanline Term  [dev]`, foreground HWND, pinned main WebView host, DOM canvas, and focused process ancestry immediately before synthetic input.
- Start CapsLock OFF. `-ProbeStress`, `-CapsOnlySmoke`, and `-HookSequenceSmoke` can send CapsLock input. The terminal recorder modes are fail-closed against CapsLock VK and scan-code input.
- Do not run the probe against a release/installed app. It uses a global low-level hook; the hook remains experimental and its callback reliability is not established.
- The runner uses a private CDP port (9223), a marked `VK_NONAME` (`0xFC`) token for recorder events, and artifacts under `output/automation-probe/`. Do not reuse a run while another probe or app instance is active.

## Commands

Run the native interop self-check first; it does not start a window, connect to CDP, open a pipe, or send input:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -SelfTest
```

Useful retained modes:

```powershell
# Baseline token DOM transport and A/F24 controls; no native hook.
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -TransportSmoke

# Hook callback liveness, Caps-only behavior, and ordered hook diagnostics.
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -CallbackSmoke
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -CapsOnlySmoke
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -HookSequenceSmoke
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -ProbeStress

# Guarded terminal-recording paths. These never inject CapsLock.
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -McpTerminalSmoke
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -NvimLayoutSmoke

# Compare configured Helix and Neovim cursor behavior with inherited TERM and a process-local TERM value
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -CursorEditorSmoke

# Helix cursor transitions with owned-window and canvas focus checks
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/automation-probe/Run.ps1 -FocusedCursorSmoke
```

`-TimeoutSeconds N` sets the timeout for individual startup, reload, or focus waits (1–300 seconds; default 90); it is not a total runtime limit. MCP fixture readiness and recorder waits have their own deadlines. `-TerminalRecorderSmoke` remains as a legacy fallback; `-McpTerminalSmoke` is preferred because it starts VT and Win32 recorder fixtures through the debug MCP sidecar and waits for their `READY` records instead of typing a shell command into the app.

`-McpTerminalSmoke` snapshots `scanline-term.settings.v1` only on `http://localhost:5173`, enables `mcpEnabled` for that dev origin, and restores the exact saved raw value during cleanup. It uses `src-tauri/target/debug/scanline-term-mcp.exe --pipe scanline-term-mcp-dev` through `mcp-client.mjs`; it does not change the release origin or persistent release settings. `-NvimLayoutSmoke` selects installed US and Russian HKLs from the live Windows list. Its scan-code `SendInput` stimuli are synthetic, not physical keyboard input.

`-CursorEditorSmoke` launches the installed Helix and Neovim with their normal user configs and unique empty scratch files, first with inherited process environment and then with `TERM=xterm-256color` set only in a child launcher. It captures only the child values for `TERM`, `COLORTERM`, and `WT_SESSION`. Before input, the runner correlates the newly selected tab's session id with the MCP screen using the unique scratch filename, then records output bytes before xterm parsing, the non-consuming DECSCUSR observer, the session override state, and the renderer-effective xterm cursor style. It sends Insert and Escape through the owned MCP handle; this mode does not test physical keyboard delivery.

## Artifacts and cleanup

Each run writes `output/automation-probe/<UTC-run-id>-<mode>.json`. MCP recorder streams are written under `output/automation-probe/recordings/`; the dev settings snapshot is named `<UTC-run-id>-dev-settings-snapshot.json`. The JSON includes exact input arrays, target/focus checks, native and frontend traces, test assertions, errors, and cleanup status. A failed run still writes an artifact; inspect its `error` and `cleanup` fields before retrying.

The runner closes only its owned terminal handles, ends its helper and debug app, removes the capture listener, restores process environment variables, and restores the exact dev MCP setting snapshot. Caps-related modes attempt to restore an initially OFF CapsLock state after the app and hook have closed. `CapsRestore.ps1` refuses to send its guarded pair while an owned Scanline Term process remains. Verify the artifact's cleanup and CapsLock fields before another run.

## Current evidence and limits

One synthetic single-array scan-code Caps/H sequence preserved the expected native ordering: [`20261023T031305293Z-hook-sequence.json`](../../output/automation-probe/20261023T031305293Z-hook-sequence.json). A later same-process sequence delivered four A warmups to DOM diagnostics while the native callback count remained zero, so it stopped before Caps input: [`20261023T031629672Z-hook-sequence.json`](../../output/automation-probe/20261023T031629672Z-hook-sequence.json). This is a reliability failure for the hook candidate; the one ordering pass does not establish repeatable operation.

The marked `VK_NONAME` frontend path passed VT and Win32 ConPTY recorder checks in [`20261023T035232963Z-mcp-pty-recorders.json`](../../output/automation-probe/20261023T035232963Z-mcp-pty-recorders.json) and the repeat [`20261023T040146091Z-mcp-pty-recorders.json`](../../output/automation-probe/20261023T040146091Z-mcp-pty-recorders.json). VT recorded Escape byte `1B` and Ctrl-H byte `08`; Win32 recorded Escape and H with Ctrl state `40`. Caps remained off. These marked tokens bypass the physical Caps hook, so the PTY passes do not establish hook reliability.

Neovim sequential layout testing passed in [`20261023T040712916Z-nvim-layout.json`](../../output/automation-probe/20261023T040712916Z-nvim-layout.json): Russian Insert mode entered `р`, Escape returned to Normal mode and English, and `x` deleted the character. The fixture explicitly emits DECSCUSR cursor-style sequences (`CSI 6 q` / `CSI 2 q`); `guicursor` alone did not produce a layout observation in the earlier [`20261023T035354052Z-nvim-layout.json`](../../output/automation-probe/20261023T035354052Z-nvim-layout.json). The runner also passed four focus/layout checks: blur disarmed the probe, a stale Russian request was rejected while English HKL stayed active, refocus rearmed the same tab, an external English layout change was observed and remembered, and per-tab Russian Insert defaults restored English on returning to the first tab. The test simulates layout changes by posting `WM_INPUTLANGCHANGEREQUEST`.

The same Neovim artifact reports `missed-command` for a zero-delay Escape+X batch: after Insert text `р`, a scan-code `X` injected with `SendInput` followed 3.758 ms after the fixture mode change; Neovim received `ч` while `р` remained, even though Normal mode and English HKL were later observed. This interval is fixture-mode-to-key timing, not a measurement of the Windows layout API. No artificial delay was added. The artifact's overall `status: pass` means the probe completed its asserted scenarios; it does not turn this missed-command result into a pass.

Physical keyboard behavior and physical/global CapsLock suppression remain unvalidated; callback reliability still fails on a repeated synthetic run. Held/repeated CapsLock behavior is also untested. The latest focus and per-tab checks passed, but these results do not justify shipping the hook or claiming an atomic Escape-to-command layout transition.

## Manual hardware observation

There is no dedicated one-command manual mode. To observe real hardware in a disposable dev session, start from PowerShell with the debug hook opt-in and CDP enabled:

```powershell
$env:SCANLINE_TERM_AUTOMATION_PROBE = '1'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
npm run tauri:dev
```

In another shell, use the retained CDP helper to inspect the dev page and probe state. Focus the live terminal canvas, run `probeSetup`, then `probeReady`; check `frontendProbe` reports the active focused tab. Clear both traces with `frontendProbeClear` and `probeClear`, press the physical keys manually, then collect `frontendProbe`, `probeTrace`, and `probeEvents`. Do **not** run the `install` action during terminal-delivery observation: it cancels captured keyboard events. Do not run `Run.ps1 -ProbeStress` as a substitute for hardware input; it injects synthetic input. Close the dev app after observation and confirm its hook has exited.

```powershell
node scripts/automation-probe/cdp.mjs state
node scripts/automation-probe/cdp.mjs focusTerminal
node scripts/automation-probe/cdp.mjs probeSetup
node scripts/automation-probe/cdp.mjs probeReady
node scripts/automation-probe/cdp.mjs frontendProbe
node scripts/automation-probe/cdp.mjs frontendProbeClear
node scripts/automation-probe/cdp.mjs probeClear
node scripts/automation-probe/cdp.mjs probeTrace
node scripts/automation-probe/cdp.mjs probeEvents
```

After the app exits, clear the opt-in from the manual shell before another launch:

```powershell
Remove-Item Env:SCANLINE_TERM_AUTOMATION_PROBE -ErrorAction SilentlyContinue
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
```
