# Scanline Term Lua Automation Spike

## Purpose and accepted V1 scope

This spike checks whether a local, editor-focused Lua automation layer is viable for Scanline Term. V1 targets editors launched through local PowerShell or cmd.exe sessions. A plugin is optional; the core path must not require editor-specific plugins.

The proposed split is a Lua event engine for ordered rules and state, plus a declarative TypeScript map for remaps and tap/hold behavior. Both layout handling and Caps Lock behavior are required for the first release. If either gate fails, the V1 proposal is blocked pending a scope or design decision.

V1 excludes Settings API, SSH and WSL support, OSC integration, and MCP-driven tab automation. It also excludes global keyboard hooks and compensating Caps Lock toggles. Those are scope constraints, not conclusions from this spike.

## Status

**Historical result: NO-GO for the original full V1 under the accepted constraints.** The Caps gate failed on the tested WebView/TypeScript path. The layout probe confirmed bounded HKL request/readback and restoration, but did not test effective text mapping. A later, separately authorized hook spike is recorded below; it does not change the original no-global-hook constraint or approve shipping a hook. The original spec backlog remains unchanged.

## Evidence and limits

### Documented platform behavior

- WebView2 raises `AcceleratorKeyPressed` for accelerator keys while its WebView is focused. Microsoft defines accelerator keys as combinations with Ctrl/Alt held or keys that do not map to a character. Setting `Handled` stops WebView accelerator/default handling and propagation to web content; the API documentation does not promise cancellation of a Windows keyboard toggle. [Event documentation](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.acceleratorkeypressed?view=webview2-dotnet-1.0.4129.50), [event args and processing order](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2acceleratorkeypressedeventargs?view=webview2-winrt-1.0.4022.49)
- Windows documents Caps Lock as a toggle key. Thread keyboard state is associated with keyboard messages as they are read from the message queue; `GetKeyState` describes state for the message being processed. This makes an ordinary `WM_KEYDOWN` handler an insufficient documented guarantee that the system toggle has not occurred. [Keyboard input overview](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-keyboard-input), [GetKeyState](https://learn.microsoft.com/en-us/windows/desktop/api/winuser/nf-winuser-getkeystate)
- Microsoft documents `WH_KEYBOARD_LL` as running before asynchronous key state is updated and allows a handled event to be stopped before the target window procedure. Microsoft lists this hook as global-only. It is outside accepted V1 scope. [Low-level keyboard callback](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc), [hook scope table](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowshookexw)
- The documentation does not explicitly establish whether bare Caps Lock is delivered through WebView2's accelerator event or whether consuming it there prevents the OS toggle. Those points require empirical results for the tested app path.

### Baseline on clean HEAD

Baseline was captured before implementation at clean commit `353620e` (`main`, matching `origin/main`):

| Command | Result |
|---|---|
| `npm test` | Pass: 22 files, 212 tests |
| `npm run lint` | Fail: 3 existing React ref errors in `src/ui/SettingsPanel.tsx:60` and `src/ui/TabGallery.tsx:118`; 4 warnings |
| `npm run build` | Pass; Vite reports the existing 881 kB JS chunk exceeds its 500 kB advisory threshold |

These results describe the clean baseline, not spike changes.

## Empirical results

| Gate | Status | Measured result | Artifact / reproduction |
|---|---|---|---|
| Caps Lock suppression without hook or compensation | Failed on tested WebView/TypeScript path | In the real Tauri dev WebView2 with its canvas focused, the document-start DOM capture listener observed Caps Lock `keyup` but no Caps Lock `keydown`. In the scan-code trial, the native focus-thread toggle byte was on (`0x01`) before input and remained on afterward; this did not establish an off-to-on transition. In a separate VK trial, the preceding native/DOM observation was on; after exactly one `VK_CAPITAL` down/up pair, the DOM saw only Caps `keyup`, which capture code consumed with `preventDefault()` and `stopImmediatePropagation()`, then a following injected `A` was lowercase and reported Caps off. No reliable native post-VK state byte was sampled, and no compensating Caps event was sent. This shows the observed DOM consume path lacked the down edge needed for tap/hold; the VK DOM observation is consistent with the system toggle occurring despite consuming the observed keyup. | Temporary evidence: `%TEMP%\sterm-caps-probe\results.json`. To reproduce with the session-only harness: start dev with `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'; npm run tauri:dev`; install the document-start logger with `node (Join-Path $env:TEMP 'sterm-caps-probe\cdp.mjs') install`, select consume mode with `node (Join-Path $env:TEMP 'sterm-caps-probe\cdp.mjs') mode consume`, then retrieve events with `node (Join-Path $env:TEMP 'sterm-caps-probe\cdp.mjs') events`. The VK stimulus was one `VK_CAPITAL` down/up then `A` down/up via `CapsNative.Key` in the temporary harness. The scan-code tap command was `powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:TEMP 'sterm-caps-probe\inject-scan.ps1') -Scenario tap`. The harness was not checked in, so these commands alone are not independently reproducible from the repository. |
| Requested layout selection and effective key mapping | Partial pass | With the Scanline Term WebView2 child focused, a `WM_INPUTLANGCHANGEREQUEST` carrying candidate Russian HKL `0x04190419` was accepted: readback on the owning WebView thread returned that HKL. After focus returned to the app, the same thread read back original en-US HKL `0x04090409`. This establishes request/readback on the tested path; it does not establish that subsequent WebView DOM text uses the requested layout. A Russian IME HKL `0xFFFFF0080419` was observed on another thread while focus was away, but cause and global/thread isolation are unresolved. | Candidate HKLs from `GetKeyboardLayoutList`: `0x04090409`, `0x04190419`, `0xFFFFF0080419`; configured tips observed for en-US/Russian: `0409:00000409`, `0419:00010419`. Temporary probe `%TEMP%\sterm-layout-probe.ps1` posted `WM_INPUTLANGCHANGEREQUEST` (`0x0050`) to the focused WebView HWND and read back `GetKeyboardLayout` on its owning thread. The script was not checked in; no repository command can reproduce it as-is. Effective Russian key entry was not tested because focus was unstable, and no test key was delivered. |

### Cleanup

The probes ended with the temporary listener cleared, remote debugging removed, and the development app returned to a normal launch configuration. Caps Lock was left off. A later readback of the original focus-thread layout was en-US (`0x04090409`). No probe artifacts were added to the repository.

## Optional global-hook spike — 2026-10-23

The user authorized a Windows feasibility test of a dedicated Rust thread using `WH_KEYBOARD_LL`; this was test authorization only. Microsoft documents the hook as global-only and requires a message loop on the installing thread ([callback requirements](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc), [hook scope](https://learn.microsoft.com/en-us/windows/desktop/api/winuser/nf-winuser-setwindowshookexw)). The probe therefore inspected foreground HWND/PID on each callback and swallowed Caps Lock only while the explicitly armed top-level `[dev]` window was foreground. The callback remained free of IPC, locks, and allocations. The global hook still observes input across the desktop, so this test does not satisfy the original V1 no-global-hook constraint.

**Core result: pass on this workstation for marked injected VK input.** A marker-tagged `SendInput` Caps down/up pair sent to the armed dev window produced one swallowed down, one swallowed up, and one logical tap. The owned native helper window measured initial Caps state off. The next marker-tagged `A` down/up produced WebView events with `caps=false` and `ctrl=false`; no Caps key edge appeared, and the logger prevented the `A` from reaching the terminal. This supports that the intercepted tap left Caps off on this tested path. The probe reported zero synthetic Ctrl events: it classified the tap but did not send a remapped key into ConPTY.

The two Caps callbacks averaged 7.45 μs (7.8 μs maximum); the four Caps-plus-`A` callbacks averaged 5.85 μs. These figures include probe timing, foreground/PID queries, and atomic metrics. They are a small injected-event sample, not a production latency benchmark.

The run did not test physical keys, initial Caps-on state, unarmed or other-window pass-through, focus loss while Caps was held, repeats, long holds, chords, IME behavior, hook conflicts, or actual Ctrl/Esc delivery to a terminal. The documented global scope, those untested cases, and the missing Lua/layout production path mean this is **not a GO for shipping or the original full V1**.

Evidence and temporary reproduction material are under `%TEMP%\sterm-hook-probe\`: `state-proof-summary.json` is the result summary; `state-proof-hook-stats.json`, `state-proof-dom.json`, and `state-window-initial.json` contain callback, WebView, and initial-state observations. `keyboard_hook_probe.rs` plus `main.rs.patch` capture the debug-only probe and wiring. The successful sequence used direct marker-tagged calls through `HookProbeNative.cs` after arming the dev HWND through its PID-named local pipe; `caps-state-listener.mjs` and `read-caps-state.mjs` captured the WebView events. `send-input.ps1` was not used for the successful sequence. The exact direct-call sequence was not saved as a replay script, so these temporary files document the probe but do not provide a one-command reproduction. The failed interop/stats setup attempts sent no test input and are excluded from the result. A scoped native test also passed: `cargo test --bin scanline_term keyboard_hook_probe -- --nocapture` reported 1 passed, 35 filtered out (`cargo-test.log`). All temporary `main.rs` and probe-module changes were reverted after the run; no dependency was added. The final run ended with the dev/helper processes stopped and the CDP listener closed; process termination removed the hook.

## Gate outcome

The original full V1 remains **NO-GO** under its accepted constraints: its Caps path failed and its required effective layout mapping was not verified. The separate hook spike establishes only that a focused Caps down/up can be suppressed and classified on this workstation using explicitly marked injected input. Since `WH_KEYBOARD_LL` is global-only and terminal remapping, physical input, and the remaining focus/state cases are untested, no production implementation or shipping decision follows from this result.

## Later retained debug-only automation probe — 2026-10-23

This is a separate, test-only implementation pass after the historical experiments above. Unlike the temporary hook proof, the current debug-only source is retained in `src-tauri/src/automation_probe.rs`, `src/terminal/automation-probe.ts`, and `src/terminal/useTerminal.ts`. It is gated by `SCANLINE_TERM_AUTOMATION_PROBE=1` and a development build. It is not a Lua runtime, production feature, or change to the original V1 no-global-hook constraint.

One ordered routing run passed on this workstation: after an `A` warm-up established callback liveness, one marked `SendInput` array carried scan-code Caps down, `H` down/up, Caps up. The native callback trace preserved order; frontend diagnostics encoded the `H` edge as logical Ctrl down/up. The measured Caps state was OFF before and after. The run had no configured language targets and no terminal-process recorder, so it establishes neither language selection nor input received by a shell or editor. It is one synthetic-input sample, not reliability evidence. [Artifact](../output/automation-probe/20261023T031305293Z-hook-sequence.json).

Several later attempts failed before completing the sequence. In `20261023T031629672Z-hook-sequence.json`, four bounded synthetic `A` warm-ups each appeared in DOM diagnostics, while the native callback counter remained zero; the runner stopped without sending Caps or the follow-up sequence. In `20261023T031831237Z-terminal-recorders.json`, the token down edge was absent from DOM diagnostics; only `H` down/up and a Caps keyup were recorded, and the runner stopped before follow-up input. Other recorder attempts failed at child-process identification (`20261023T032015812Z-terminal-recorders.json`), recorder completion (`20261023T032313015Z-terminal-recorders.json`), or readiness/launch matching (`20261023T032601109Z-terminal-recorders.json`). These results establish that the tested attempts did not complete. They do not identify a cause for the missing callbacks, missing token edge, or recorder startup/completion failures.

The retained probe now has bounded real-PTY passes for both encoders and an initial Neovim layout transition, described below. The ordinary Insert-to-Normal transition worked in the measured sequence, but the zero-delay Escape-to-command batch exposed a layout race. No arbitrary input delay was added. Additional focus/per-tab and physical-key cases remain pending; no shipping decision follows from this work.

### Real-PTY encoder segment — 2026-10-23

The Win32 and VT recorder segments passed in artifact `20261023T035232963Z-mcp-pty-recorders.json`. Win32 input records contained Escape VK `27` down/up and H VK `72` down/up with Unicode character `8` and control state `40` (Ctrl). The VT recorder captured bytes `1B` and `08`, corresponding to Escape and Ctrl-H. The runner explicitly set each active session's parser mode through CSI `?9001h` or `?9001l` after recorder READY and waited for the terminal parser callback/readback before sending input. This removes recorder-startup versus parser-mode timing from this encoder check; it does not represent natural mode negotiation.

The trigger was marked `VK_NONAME` input and bypassed the physical Caps hook. Native Caps state was off both before and after the run. This encoder segment proves that the frontend routed the marked token tap to Escape and token-plus-H to Ctrl-H, and that both encoders delivered those sequences to a real ConPTY recorder. It does not prove physical Caps suppression or layout behavior. The runner had to enable MCP mode for this test setup; that observation does not establish the cause of earlier MCP readiness timeouts.

The repeat in `20261023T040146091Z-mcp-pty-recorders.json` captured the same four Win32 key records and VT bytes with the parser modes explicitly set and confirmed through the active terminal parser after recorder readiness. Caps state remained OFF (`0` before and after). This is another synthetic-token encoder pass, not physical Caps-hook evidence. The test setup successfully toggled the app's MCP setting through its UI; this does not identify the cause of earlier MCP startup timeouts.

### Neovim layout and Escape-order segment — 2026-10-23

The corrected Neovim run `20261023T040016311Z-nvim-layout.json` configured English `0x04090409` as the Normal target and Russian `0x04190419` as the Insert target. The fixture emits and flushes explicit DEC cursor-style sequences (`CSI 6 q` for Insert/bar and `CSI 2 q` for Normal/block) on startup and `ModeChanged`. The earlier `20261023T035354052Z-nvim-layout.json` attempt configured `guicursor` without emitting these sequences, so it did not feed mode changes to the app's cursor-style path. A different issue affected `20261023T035759807Z-nvim-layout.json`: it did emit explicit cursor-style sequences, but its fast-command assertion accepted an earlier empty-buffer record rather than requiring a new empty-buffer record after Escape+X. Its reported fast-command success is superseded and is not evidence that the race passed.

In the corrected run, Insert selected/read back the Russian HKL, synthetic scan-code H produced Cyrillic `р` in the actual Neovim buffer, Escape returned to Normal/block, and the English HKL was observed. After that settled transition, synthetic scan-code `x` deleted the character as expected. This verifies the ordinary Insert/Normal layout path for this test sequence.

The same run then sent Escape and X in one `SendInput` array with zero inter-key delay. Neovim entered Normal mode and the English layout request/readback was observed, but X arrived as Russian `ч`; the buffer remained `р` and the deletion assertion failed. The guarded batch elapsed about 501 ms including preflight checks, not an inserted delay between the two keys. This is direct evidence that a later mode/cursor event and layout request do not guarantee that an immediately following key already uses the new layout. The run does not decide whether to change that interaction with a pre-emptive layout switch, buffering, or another product-level behavior; no such change or arbitrary delay has been introduced.

The test exercised marked/injected scan codes and a fixture, not hardware keyboard input or an unmodified Neovim setup. Physical Caps held/chord behavior and pass-through in another application remain unverified. The evidence is specific to the selected layouts, host, WebView, and this fixture; it does not establish a general Neovim compatibility guarantee.

### Focus and per-tab layout segment — 2026-10-23

Run `20261023T040712916Z-nvim-layout.json` passed the bounded blur/stale-request and per-tab cases. On canvas blur to Settings, the frontend published the same tab with `focused=false` at generation 94 and native disarmed. A delayed generation-93 Russian layout request was rejected as stale; the owning thread's HKL remained English (`0x04090409`) before and after. Refocusing the original canvas advanced to generation 95 and re-armed the native probe.

The runner then simulated an external switch to English while the first tab was in Insert mode; native observation recorded that change and the tab later restored English. A second tab entered Insert with its configured Russian layout, then returning to the first tab restored that tab's English Insert layout. These per-tab results used a simulated `WM_INPUTLANGCHANGEREQUEST`/native observation, not a physical user keyboard-layout switch.

The same run repeated the zero-delay Escape+X race: the synthetic scan-code X arrived as Russian `ч` and left `р` in the buffer despite Normal mode and English HKL observation. The fixture's ModeChanged-to-key interval was 3.758 ms; this is an event interval from one run, not a measured request/readback latency or a guarantee. Physical Caps held/chord behavior and pass-through to another application remain unverified.

### Final bounded validation and cleanup — 2026-10-23

The final MCP terminal smoke `20261023T041139290Z-mcp-pty-recorders.json` again captured the expected Win32 Escape/H Ctrl-H records and VT `1B`/`08` bytes. Closing the active owned test tab moved frontend and native context to the replacement tab; the trace had zero unmatched token-downs. Caps state was OFF (`0`) before and after. Cleanup restored the exact prior MCP setting, closed owned terminals and helpers, stopped the owned dev app, and restored the runner's process environment.

Final validation reported 229 frontend tests passing, `npm run build` passing, 43 Rust tests passing, `cargo check --release` passing, changed-file ESLint passing, and `git diff --check` passing. Full lint still reports the known baseline of 3 errors and 4 warnings.

### User-reported physical editor smoke — 2026-10-23

The user reports that all four physical-input tests with the configured editors passed. The fast Escape-plus-next-key transition was not observed at human typing pace; this does not disprove the synthetic zero-delay race reproduced above.
