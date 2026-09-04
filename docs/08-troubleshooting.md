# 8 · Troubleshooting and Known Limitations

[← Testing](./07-testing.md) · [Index](./README.md) · [Extension Guide →](./09-extension-guide.md)

---

## Common Symptoms and Fixes

### Performance / Latency

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| FPS drops below 60 | Expensive shader (spiral bloom, high persistence) | Check FPS counter in settings panel header | Switch bloom algorithm to "Soft"; reduce persistence; lower virtual resolution |
| FPS drops to ~30 | WebGL software rendering | Check `edge://gpu` in a browser; look for "Software only" | Update GPU drivers; ensure hardware acceleration is enabled in WebView2 |
| Input feels laggy | `write_terminal` invocations backing up | Add `console.log` before `invoke('write_terminal')` | Check if ConPTY session is alive; verify writer thread isn't blocked |
| Typing latency on rapid keystrokes | Every keydown generates an `invoke()` IPC call | Profile with DevTools Performance tab | This is inherent to the architecture; Win32 Input Mode adds keyup events too |
| Breathing effect causes jank | `getImageData()` reads back the source canvas every frame | Profile CPU; breathing samples 64 grid pixels | Reduce breathing intensity or set to 0 when not needed |

### Console / ConPTY

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| "Windows console could not start" | ConPTY DLLs missing | Check `src-tauri/resources/conpty/x64/` | Ensure DLLs are present and readable |
| "Windows console could not start" | `%ComSpec%` not set or invalid | `echo %ComSpec%` in cmd | Set `ComSpec` environment variable to `C:\Windows\System32\cmd.exe` |
| Terminal starts but shows no prompt | `cmd.exe` startup delayed | Wait a few seconds; the initial `\r` should trigger the prompt | Check antivirus/security software intercepting process creation |
| Console exits unexpectedly | Child process crashed or was killed externally | Check for `terminal-exit` event | Restart with `npm run tauri:dev` |
| Orphaned `cmd.exe` after close | `TerminalState::drop` didn't fire | Check Task Manager for orphaned `cmd.exe` | The `Drop` impl calls `child.kill()` — if the process was already dead, this is a no-op |

### Focus and Input

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| Keyboard input not reaching terminal | Canvas doesn't have focus | Click the canvas; check `tabIndex` | Canvas gets `tabIndex={0}` when `terminalLive` is true |
| Alt+Enter doesn't toggle fullscreen | Not running in Tauri | Check `isTauri()` | Only works in Tauri app, not browser preview |
| Menu+key shortcuts not working | Menu key (`ContextMenu`) not recognized on some keyboards | Check if `event.key === 'ContextMenu'` fires | Verify keyboard layout; some keyboards lack a dedicated Menu key |
| Keys go to settings panel instead of terminal | A settings control has focus | Click the canvas to return focus | This is expected behavior — settings controls capture keyboard |

### Codex Assistant

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| `Codex CLI was not found on PATH` | Codex is not installed or invisible to the Tauri process | Run `codex --version` from a new terminal | Install Codex or repair `PATH`; version must be at least 0.152.1 |
| Sign-in button does nothing | External opener plugin/capability is missing | Debug has `authUrl`, but no browser opens | Ensure `tauri-plugin-opener` is registered and capability permits `https://**`; restart Tauri |
| `Login cancelled` | Browser login was closed or callback could not complete | `account/login/completed` in Debug console | Start a new login; do not reuse the old URL |
| `Unexpected external Codex instructions were loaded` | Isolation no longer applies | Inspect `thread/start` result | Restore app-local `CODEX_HOME`, neutral `cwd` and `project_doc_max_bytes: 0` |
| Assistant observes the wrong tab | Thread/session routing regression | Compare `threadId` and active terminal output in Debug console | Inspect the `threadId → sessionId` map in `App.tsx`; never add session ID to tool arguments |

### Buffer Size and Resize

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| Incorrect buffer size | Font measurement mismatch | Compare `fontCellSize()` output with actual rendered characters | Font fallback may be selecting a different font than expected |
| Text cut off at edges | Padding calculation too large/small | Check `terminalPadding()` | Padding = `max(2, floor(min(w,h) * 0.01))` — should be proportional |
| Resize causes crash | PTY size validation rejects dimensions | Check error message (cols ∈ [20, 300], rows ∈ [8, 150]) | Ensure window is large enough for minimum grid at the selected font size |
| Resize flicker | Persistence FBO cleared on resize | This is intentional (`clearPersistence()`) | Expected — prevents stale phosphor trail at wrong resolution |

### Color and Palette

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| Colors look wrong after profile switch | `remapLegacyRgb` didn't match | Check if the app emits exact Windows Legacy RGB values | Profile switch should be immediate; check `activeColorProfile()` |
| Extended colors (16–255) show profile background | `profileColor` fallback chain | Profile defines < 16 colors but index > 15 requested | Most profiles only define 16 colors; indices 16+ use xterm extended — this is correct |
| White text appears gray | Profile's foreground color isn't pure white | Check `profile.foreground` | By design — e.g., Windows Campbell foreground is `#cccccc` |
| Monochrome mode looks dim | Color mode converts to luma then tints | Check `applyColorMode()` phosphor tint values | Adjust image brightness control |

### Persistence and Phosphor Trail

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| Trail never disappears (burn-in) | Quantization cutoff too small for low persistence | Check `persistenceDecay()` output | The cutoff formula `(30/255) × elapsedSeconds` should prevent this; increase persistence to verify decay is working |
| Trail is too bright | `persistenceIntensity` too high | Reduce trail intensity control | Range is 0–4; typical value is 1 |
| Ghost images after resolution change | Old FBO data at different resolution | `clearPersistence()` should be called | Verify `ensureFBO` detects size change and calls `clearPersistence()` |

### Bloom and Glow

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| Bloom looks like copies/ghosts | Using spiral algorithm with high bloom | Switch to "Soft blur" algorithm | Spiral is a 16-tap approximation; soft uses proper Gaussian separable passes |
| Screen glow makes everything muddy | Glow too high | Reduce screen glow | Glow is desaturated 35% and uses screen blend mode |
| No bloom visible | Bloom threshold too high for content | Soft bloom uses bright-pass threshold 0.55 | Only pixels with luma > 0.55 contribute to soft bloom |

### Mouse Selection and Coordinates

| Symptom | Probable Cause | Diagnostic | Fix |
|---------|---------------|------------|-----|
| Selection highlights wrong cells | `copyPoint()` coordinate offsets | Check hardcoded offsets (`row - 2`, `col - 3`) in `copyPoint()` | These offsets are calibration-specific; adjust if font/padding changed |
| Mouse clicks offset with curvature | Curvature warps display but not input coordinates | This is a known limitation | Inverse curvature mapping is planned (see BACKLOG.md) |
| Copy pastes wrong text | `translateToString()` range errors | Log `start` and `end` CopyPoint values | Verify viewport offset (`viewportY`) is correctly included |

---

## Platform Constraints

| Constraint | Impact |
|------------|--------|
| **Windows-only** | All ConPTY, Win32 font, and GDI code is `#[cfg(windows)]`. macOS/Linux will compile a stub `list_monospace_fonts` but cannot run a terminal session. |
| **x64 only** | Bundled ConPTY DLLs are in `resources/conpty/x64/`. ARM64 Windows is not supported without additional DLLs. |
| **WebView2 required** | Tauri 2 uses WebView2 (Chromium-based). If WebView2 is missing, the app won't start. |
| **WebGL required** | The CRT pipeline requires WebGL 1. Software-rendered WebView2 may work but with degraded performance. |
| **Single window** | The app supports one main window with multiple terminal tabs; it does not support multiple app windows. |
| **Per-tab shell session** | Each tab owns one ConPTY session. Closing a shell leaves its exited tab and screen buffer available until the user closes it. |
| **No text attributes** | Bold, underline, and strikethrough are not yet rendered (tracked in BACKLOG.md). `isDim()` is supported. |

---

## Areas Requiring Windows-Specific Testing

These areas **cannot** be validated in browser preview or non-Windows CI:

1. ConPTY session lifecycle (start, I/O, resize, exit, cleanup)
2. Win32 Input Mode delivery to console applications
3. Font enumeration via GDI `EnumFontFamiliesExW`
4. Bundled ConPTY DLL loading
5. Alt+Enter fullscreen via `getCurrentWindow().setFullscreen()`
6. Console application compatibility (FAR Manager, PowerShell, SSH, vim)
7. Process cleanup on window close (`TerminalState::drop`)

---

*[Next: Extension Guide →](./09-extension-guide.md)*
