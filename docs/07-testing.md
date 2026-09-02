# 7 · Testing and Validation

[← Development](./06-development.md) · [Index](./README.md) · [Troubleshooting →](./08-troubleshooting.md)

---

## Test Layout

### Frontend Tests (Vitest)

All frontend tests use **Vitest** with the **happy-dom** environment (configured in `vitest.config.ts`).

| Test File | Area | Coverage |
|-----------|------|----------|
| [`terminal-input.test.ts`](../src/terminal-input.test.ts) | VT key encoding | F1–F24 with modifiers; Ctrl+C, Ctrl+Alt+C; cursor keys with DECCKM; numpad application mode |
| [`win32-input.test.ts`](../src/win32-input.test.ts) | Win32 Input Mode | Modifier-only down/up; ContextMenu key; Ctrl+C; Enter; Backspace; ArrowUp; F1; virtual keys, scan codes, control state bitmask |
| [`terminal-mouse.test.ts`](../src/terminal-mouse.test.ts) | Mouse encoding | SGR clicks, releases, wheel with Ctrl modifier; X10 legacy encoding; mouse move without button |
| [`terminal-color-profiles.test.ts`](../src/terminal-color-profiles.test.ts) | Color profiles | Historical palette values; xterm extended table (256 colors); `remapLegacyRgb` for DOS VGA, Solarized, passthrough |
| [`terminal-responses.test.ts`](../src/terminal-responses.test.ts) | xterm VT responses | Cursor position report (`\x1b[6n` → `\x1b[1;1R`) |
| [`crt/settings.test.ts`](../src/crt/settings.test.ts) | CRT settings | Persistence decay physics; default values; corrupt value rejection; physical resolution; malformed JSON survival; trail intensity range; color modes; bloom algorithms; color profiles (including legacy name migration); console font/size; CRT emulation toggle; brightness/contrast/desaturation |

Run: `npm test`

### Rust Tests (`cargo test`)

| Test | Area | Coverage |
|------|------|----------|
| `limits_terminal_dimensions` | PTY validation | Valid size (80×30), invalid cols (0), invalid rows (151) |
| `bundled_conpty_streams_win32_input_request` | ConPTY integration | Spawns cmd.exe with bundled ConPTY, verifies `\x1b[?9001h` appears in output |
| `win32_input_mode_delivers_function_key` | ConPTY + Win32 Input | Sends F1 Win32 input sequence to PowerShell `ReadKey`, verifies "F1" output |

Run: `cd src-tauri && cargo test`

> **Note:** The Rust integration tests require Windows and spawn actual console processes. They will not pass in CI environments without a Windows runner. The `bundled_conpty_streams_win32_input_request` test has a 5-second timeout per read.

---

## Validation Checklists

### After Changes to Rust / Native Console Code

- [ ] `cargo test` passes (all 3 tests)
- [ ] `npm run tauri:dev` starts without errors
- [ ] Console session starts (cmd.exe prompt appears)
- [ ] Type a command (e.g., `dir`) — output appears correctly
- [ ] Terminal resize: drag window, verify grid updates, no artifacts
- [ ] Close and reopen — ConPTY session cleans up without orphaned processes

### After Changes to Keyboard Input

- [ ] `npm test` — `terminal-input.test.ts` and `win32-input.test.ts` pass
- [ ] In `tauri:dev`: type regular text, verify echoed correctly
- [ ] Ctrl+C interrupts a running command (e.g., `ping -t localhost`)
- [ ] Ctrl+L or `cls` clears screen
- [ ] Arrow keys navigate (cmd.exe history, or in a TUI app)
- [ ] Function keys work in a console app (e.g., FAR Manager F1–F10)
- [ ] Tab completion works in cmd/PowerShell
- [ ] Alt+Enter toggles fullscreen
- [ ] Menu+S toggles settings panel
- [ ] Menu+V pastes from clipboard
- [ ] Menu+C enters copy mode (verify visual feedback)
- [ ] Numpad keys work in application keypad mode (if applicable)

### After Changes to Mouse Input

- [ ] `npm test` — `terminal-mouse.test.ts` passes
- [ ] In a mouse-aware app (e.g., `less`, FAR Manager): click, drag, scroll — events received correctly
- [ ] Wheel scrolls terminal scrollback in normal mode (not in alternate screen)
- [ ] Copy mode: Menu+C → click+drag → text selected → text copied to clipboard
- [ ] Middle button click starts selection
- [ ] Mouse coordinates match expected cells (verify in a TUI app that shows cursor position)

### After Changes to Clipboard

- [ ] Menu+V pastes text from clipboard into terminal
- [ ] Menu+C → drag-select → release copies text to clipboard (verify with Ctrl+V in another app)
- [ ] Browser `onPaste` on canvas works (Ctrl+V in browser preview mode)
- [ ] Large clipboard content doesn't freeze the terminal

### After Changes to Resizing / Fonts

- [ ] Window resize updates terminal grid dimensions (visible in settings panel header)
- [ ] Console buffer size matches displayed `cols × rows`
- [ ] Font change in settings → grid recalculates → no cut-off characters
- [ ] Font size change → proportional grid change
- [ ] All virtual resolutions (QVGA → XGA) produce correct grid sizes
- [ ] Physical resolution tracks window size
- [ ] No crash or corruption when rapidly resizing

### After Changes to Rendering / Shaders

- [ ] `npm test` passes (no regressions in settings validation)
- [ ] CRT filter renders correctly with default settings
- [ ] Toggle CRT Emulation off → clean terminal image
- [ ] Toggle CRT Emulation on → full CRT effects visible
- [ ] Each CRT control knob produces visible effect
- [ ] Persistence: enable trail, type rapidly, verify afterglow appears and decays
- [ ] Bloom: increase bloom, verify bright areas glow (test both soft and spiral algorithms)
- [ ] Glow: increase screen glow, verify diffuse light overlay
- [ ] Color modes: switch through Color/B&W/Green/Amber/Blue
- [ ] Bezel: toggle bezel glow, toggle monitor frame
- [ ] Anti-moiré: toggle, verify difference at low virtual resolutions
- [ ] No WebGL errors in DevTools console
- [ ] Performance: 60fps maintained with default settings (check FPS counter)

### After Changes to Color Profiles

- [ ] `npm test` — `terminal-color-profiles.test.ts` passes
- [ ] `npm test` — `crt/settings.test.ts` passes (profile validation)
- [ ] In `tauri:dev`: switch profiles → colors update immediately
- [ ] ANSI 16-color test: verify each color index maps correctly
- [ ] 256-color test: verify extended colors (if profile defines only 16, verify xterm cube fallback)
- [ ] RGB color: verify direct RGB and legacy remapping
- [ ] Background color matches profile
- [ ] Cursor color matches profile (or foreground if no cursor color defined)

---

## Automated vs Manual Testing

| Area | Automated | Manual Verification Needed |
|------|-----------|---------------------------|
| VT key encoding | ✅ Vitest | FAR Manager function keys, SSH session |
| Win32 Input Mode encoding | ✅ Vitest + Cargo | PowerShell `ReadKey`, cmd.exe F-key menus |
| Mouse encoding | ✅ Vitest | FAR Manager mouse clicks, `less` scroll |
| Color profiles | ✅ Vitest | Visual color accuracy comparison |
| Settings validation | ✅ Vitest | — |
| Persistence decay | ✅ Vitest | Visual trail quality |
| ConPTY session | ✅ Cargo (basic) | Full session lifecycle, edge cases |
| PTY size limits | ✅ Cargo | — |
| CRT rendering | ❌ | Visual inspection required |
| Font enumeration | ❌ | Check font list in settings panel |
| Clipboard | ❌ | Manual paste/copy verification |
| Resize + font sizing | ❌ | Visual verification at multiple sizes |
| Performance | ❌ | FPS counter, profiling tools |
| Window lifecycle | ❌ | Open/close/fullscreen/minimize/restore |

---

*[Next: Troubleshooting →](./08-troubleshooting.md)*
