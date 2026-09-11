# 4 · Core Systems

[← Codebase Guide](./03-codebase-guide.md) · [Index](./README.md) · [Design Decisions →](./05-design-decisions.md)

---

## Windows Console Host Architecture

Scanline Term runs a real Windows console session inside the Tauri application. The architecture:

```
┌──────────────────────────────────────────────────────┐
│  Tauri Process (Rust)                                │
│                                                      │
│  conpty-oxide crate                                  │
│    └── Loads ConPTY DLLs from bundled resources      │
│          └── Creates pseudo-console                  │
│                ├── Spawns cmd.exe as child            │
│                ├── Exposes output pipe (reader)       │
│                ├── Exposes input pipe (writer)        │
│                └── Provides resize controller        │
└──────────────────────────────────────────────────────┘
```

**Why this approach:** Windows does not expose a traditional Unix PTY. ConPTY (Windows Pseudo Console API, introduced in Windows 10 1809) provides a pipe-based VT-compatible interface to Windows console applications. The `conpty-oxide` crate provides a Rust wrapper. The project bundles ConPTY DLLs (`resources/conpty/x64/`) rather than relying on the system's ConPTY, likely for version consistency and to support specific features like Win32 Input Mode.

**Shell selection:** `start_terminal()` reads `%ComSpec%` (typically `C:\Windows\System32\cmd.exe`), sets the working directory to `%USERPROFILE%`, and starts the process.

### Multiple sessions and tabs

The backend stores sessions by frontend-generated UUID. Each ConPTY reader emits its UUID with output and exit events, so every tab keeps an independent xterm scrollback buffer. The frontend reuses one source canvas and CRT filter: selecting a tab normally clears phosphor persistence, preventing a previous tab's afterglow from appearing on the next one. The optional Channel switch roll deliberately preserves it so the previous source decays naturally over the new one. Display resize and font changes resize every live ConPTY session to keep terminal geometry consistent.

Tab backgrounds are derived from the visible xterm cells, blending cell backgrounds with a small contribution from glyph foregrounds. Recalculation is coalesced per animation frame and works for inactive tabs; WebGL output is not read back.

Applications can name their tab with the standard OSC 0 or OSC 2 terminal-title sequence. xterm parses it in `TerminalSession`, and the tab keeps its ordinal prefix (for example, `2. FAR Manager`). When a shell does not set an OSC title (such as `pwsh` launched from `cmd.exe`), `TerminalSession` polls `active_terminal_process` every 500 ms and uses the direct child image name instead; OSC titles take priority.

### Command-line launch

`scanline-term [target] [-P <path>]` starts the first tab. An existing `.htm`, `.html` or `.pdf` target opens in the embedded browser; an existing directory opens the default shell there; other file paths or executable names run as commands. `-P` explicitly sets the command's existing working directory. A second `scanline-term -T [target] [-P <path>]` is routed to the existing application and opens the requested browser document or terminal session in a new tab.

---

## Codex terminal automation

The AI assistant does not own a second shell. `TerminalSession` exposes its parsed xterm state and uses the same per-session `write_terminal` path as normal input, which keeps agent input attached to one existing ConPTY tab. It supplies immediate snapshots or bounded output waits, and reuses the standard VT/Win32 key encoders for named key actions.

One isolated `codex app-server` process serves the app. The WebView maps each ephemeral Codex thread to a terminal session before dispatching dynamic tool calls, so a tool call cannot choose another tab. After authentication it loads the account-visible model catalog and keeps model/effort selection plus running-turn UI state local to each terminal tab; Luna with medium effort is preferred for new tabs when available. The detailed lifecycle, authentication flow, protocol contracts and current limitations are in [Codex Terminal Assistant](./10-ai-assistant.md).

---

## ConPTY and Win32 Input Mode

### ConPTY Basics

The ConPTY session produces VT100/VT220-compatible output. Console applications that use Win32 console APIs (like FAR Manager) are translated by ConPTY to VT sequences.

### Win32 Input Mode (`?9001h`)

When the console host (conhost/ConPTY) requests Win32 Input Mode, it sends `\x1b[?9001h`. The frontend detects this via an xterm CSI handler:

```typescript
// In terminal/TerminalSession.ts — registerCsiHandler for ?h and ?l
terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
  if (params.length !== 1 || params[0] !== 9001) return false;
  win32InputModeRef.current = true;
  return true;
});
```

When active, **every** keydown and keyup event is encoded using `win32InputKey()` (from `win32-input.ts`) instead of standard VT sequences. This preserves full Win32 `KEY_EVENT_RECORD` semantics including virtual key codes, scan codes, Unicode characters, and modifier state.

**Wire format:** `\x1b[virtualKey;scanCode;unicodeChar;keyDown;controlState;repeatCount_`

Example: Ctrl+C → `\x1b[67;46;3;1;8;1_` (VK_C=67, scan=0x2E, unicode=3, down=1, LEFT_CTRL=8, repeat=1)

**Compatibility motivation:** Many Windows console applications (FAR Manager, PowerShell `ReadKey`, `cmd.exe` internal commands) depend on Win32 input records rather than VT sequences. Win32 Input Mode lets them receive modifier-only events, key-up events, and exact scan codes that cannot be represented in standard VT.

**Limitations:**
- The browser `KeyboardEvent` doesn't provide native Win32 virtual key codes directly; `win32-input.ts` maps `event.code` to VK/scan code pairs via lookup tables.
- Right-Alt vs Left-Alt distinction is handled via `event.code === 'AltRight'`, but some international keyboard layouts may not report this correctly.
- Key repeat is always reported as count 1 (no native repeat count from DOM events).

### Rust Test: `bundled_conpty_streams_win32_input_request`

This integration test verifies that the bundled ConPTY DLLs emit `\x1b[?9001h` (Win32 Input Mode request) when `cmd.exe` starts. This confirms the bundled ConPTY version supports Win32 Input Mode.

### Rust Test: `win32_input_mode_delivers_function_key`

This test writes a Win32 Input Mode F1 sequence (`\x1b[112;59;0;1;0;1_`) into a PowerShell `ReadKey` session and verifies the application receives `F1`.

---

## Keyboard Handling

### Dual Mode

The keyboard handler in `terminal/useTerminal.ts` selects the encoding mode:

```typescript
const input = session.win32InputMode
  ? win32InputKey(event, true)
  : terminalKey(event, terminal.modes);
```

### Standard VT Mode (`terminal/terminal-input.ts`)

| Key Category | Encoding |
|---|---|
| F1–F4 | `\x1bOP` .. `\x1bOS` (bare); `\x1b[1;modP` .. `\x1b[1;modS` (with modifiers) |
| F5–F24 | `\x1b[15~` .. `\x1b[45~` (bare); `\x1b[N;mod~` (with modifiers) |
| Cursor keys | `\x1b[A`..`D` (normal) or `\x1bOA`..`D` (application cursor keys mode) |
| Home/End | `\x1b[H`/`\x1b[F` (normal) or `\x1bOH`/`\x1bOF` (DECCKM) |
| Insert/Delete/PgUp/PgDn | `\x1b[2~`..`\x1b[6~` with optional modifier parameter |
| Numpad (app mode) | `\x1bOp`..`\x1bOy` for 0–9, `\x1bOn` decimal, `\x1bOo` divide, etc. |
| Tab | `\t` (plain) or `\x1b[Z` (shift) |
| Enter | `\r` (plain); Alt+Enter is intercepted by the Tauri app for fullscreen before terminal encoding |
| Backspace | `\x7f` |
| Escape | `\x1b` |
| Ctrl+letter | ASCII 1–26 (Ctrl+A=0x01, Ctrl+Z=0x1A) |
| Ctrl+Space | NUL (0x00) |
| Alt+key | `\x1b` + key character |
| Meta key | Ignored (returns `null`) |

### Modifier Encoding

Modifier parameter = `1 + shift + 2*alt + 4*ctrl`

| Combination | Value |
|---|---|
| No modifiers | 1 (omitted for most keys) |
| Shift | 2 |
| Alt | 3 |
| Shift+Alt | 4 |
| Ctrl | 5 |
| Shift+Ctrl | 6 |
| Alt+Ctrl | 7 |
| Shift+Alt+Ctrl | 8 |

### Special Keyboard Shortcuts (App-Level)

| Shortcut | Behavior | Location |
|---|---|---|
| **Alt+Enter** | Toggle fullscreen (Tauri only) | `terminal/useTerminal.ts` keyboard handler |
| **Menu+S** | Toggle settings panel visibility | `terminal/useTerminal.ts` keyboard handler |
| **Menu+A** | Toggle AI assistant panel visibility | `terminal/useTerminal.ts` keyboard handler |
| **Menu+'** | Toggle keyboard focus between terminal and AI assistant | `terminal/useTerminal.ts` keyboard handler |
| **Menu+V** | Paste from clipboard | `terminal/useTerminal.ts` keyboard handler |
| **Menu+C** | Enter copy mode | `terminal/useTerminal.ts` keyboard handler |
| **Menu+N** | Create a new terminal tab | `terminal/useTerminal.ts` keyboard handler |
| **Menu+B** | Create a browser tab with the local home dashboard | `terminal/useTerminal.ts` keyboard handler |
| **Menu+W** | Close the active terminal or browser tab | `terminal/useTerminal.ts` keyboard handler |
| **Menu+1…9** | Select the tab whose name begins with that number | `terminal/useTerminal.ts` keyboard handler |
| **Menu+→ / Menu+>** | Select the next tab (cycles) | `terminal/useTerminal.ts` keyboard handler |
| **Menu+← / Menu+<** | Select the previous tab (cycles) | `terminal/useTerminal.ts` keyboard handler |
| **Menu+Tab** | Toggle to the previously active tab | `terminal/useTerminal.ts` keyboard handler |

The Menu key (Context Menu / Apps key) is tracked via `menu` ref in `terminal/useTerminal.ts`. While held, letter keys are intercepted before terminal input encoding. A lone Menu press is forwarded to the active Win32 Input Mode terminal as a deferred down/up pair when it is released; this preserves application shortcuts while allowing console applications to observe `VK_APPS`. Standard VT has no equivalent Menu sequence.

`Alt+Enter` is reserved for fullscreen and is intercepted before terminal encoding. Do not rely on `KeyboardEvent.altKey` alone: on some Windows layouts Right Alt is exposed as AltGr and does not reliably set it. The handler tracks physical `AltLeft` and `AltRight` key events, and clears that state on window blur so a later plain Enter cannot toggle fullscreen.

In a native browser child WebView, only key codes matching the `browser_shortcut` allowlist are forwarded to that same application handler and stopped before the page sees them: `KeyS`, `KeyA`, `KeyB`, `KeyV`, `KeyC`, `KeyN`, `KeyW`, `PageUp`, `PageDown`, `Digit1` through `Digit9`, `ArrowRight`, `ArrowLeft`, `Period`, `Comma`, and `Tab`; other key codes are rejected. A lone Menu press and release remain normal page input. The injected script suppresses only an orphan Menu keyup left by a terminal → browser Menu shortcut, preventing a spurious browser context menu. Closing an empty browser tab also clears its host address modal. When a browser tab closes to reveal a terminal tab, focus is restored to the terminal canvas after the child WebView has closed.

### Native Browser Focus Handoff

Each browser tab owns a separate WebView2 controller. Hiding a browser child does **not** automatically move controller focus back to the main terminal WebView, even when Windows reports the Tauri top-level window as focused. In that state the terminal canvas can be `document.activeElement` while normal physical key events never reach its JavaScript window.

`browser::set_active_browser` handles the browser → terminal transition: hide the children, release `BrowserState`, and call `app.get_webview("main").set_focus()`. Keep this controller-focus call conditional on that transition; do not call it at startup or from the top-level `WM_SETFOCUS` callback, where it can re-enter native focus dispatch and hang the app. Window activation instead uses Win32 `SetFocus` on the first visible direct `WRY_WEBVIEW` child. Do not use recursive `EnumChildWindows`: hidden browser children may precede the terminal and steal focus.

WebView2 does not preserve a held `Menu` modifier across the browser → terminal boundary. After that transition, the user must release and press Menu again before another Menu shortcut; do not synthesize modifier key state to hide this limitation.

### Native context menu

The `+` tab button and terminal canvas suppress the browser's default context menu and invoke the shared `ui/nativeNewTabMenu.ts` builder in the desktop build. The popup contains `New Terminal tab`, `New Browser tab`, and a `Shells` submenu populated by `list_available_shells`. Tauri renders it as a native Windows popup, which keeps the complete menu above native browser child WebView2 surfaces; a DOM menu cannot cross that z-order boundary. Browser preview mode retains the DOM fallback for development without Tauri.

### Browser Home Dashboard

Blank browser tabs render `ui/HomeDashboard.tsx` in the main WebView. The page provides categorized links, local filtering, direct URL opening, single-key shortcuts, browser-style `F` hints for every visible link/button/input, and a minimal editor. While hints are active, their `asdfghjkl` labels take precedence over link shortcuts; `Esc` closes the mode and `F5` is consumed so the home panel cannot reload the application. Its source of truth is `%APPDATA%\\com.zhunter.scanlineterm\\home.json`, loaded and saved by `home::load_home_config` and `home::save_home_config`; filesystem access is kept on the Rust side. A successful link navigation promotes the tab to a native browser child. On every native page load, the injected browser script reads `meta[name=theme-color]` or the document background and sends a validated `browser-color` event; the frontend chooses a readable tab foreground and applies the reported background. The same update occurs for subsequent in-page navigation. Loading performs a one-time v1-to-v2 migration for the bundled default links; the MVP otherwise has no file watcher, cloud sync, general merge logic, or multi-page dashboard.

### Key-Repeat Handling

- In Win32 Input Mode, both keydown and keyup events are sent. The `event.repeat` flag is not used for filtering — repeat events flow through as normal keydown sequences.
- In standard VT mode, only keydown events generate input. There is no explicit repeat suppression.
- For fullscreen toggle (Alt+Enter), `event.repeat` is checked to prevent rapid toggling.
- For Menu+key shortcuts, `event.repeat` is checked to prevent re-triggering.

---

## Mouse Handling

### Application Mouse Tracking

Mouse tracking is driven by `terminal.modes.mouseTrackingMode` (read from xterm's mode state) and `sgrMouseModeRef` (toggled by `?1006h`/`?1006l`).

| Mode | Tracking Behavior |
|------|------------------|
| `'none'` | No mouse events sent to application |
| `'x10'` | Press only, no modifiers |
| `'vt200'` | Press + release, no move |
| `'drag'` | Press + release + move while button held |
| `'any'` | All mouse events including free movement |

The SGR mode (`?1006h`) affects the encoding format (SGR vs X10 legacy).

### SGR Encoding

```
\x1b[<button;col;row M    (press/move)
\x1b[<button;col;row m    (release)
```

### X10 Legacy Encoding

```
\x1b[M <button+32> <col+32> <row+32>
```

### Cell Coordinate Mapping

`TerminalRenderer.cellAtPoint()` maps output-canvas coordinates through the CRT curve and then into terminal cells:

```typescript
let u = (clientX - rect.left) / rect.width;
let v = (clientY - rect.top) / rect.height;
if (settings.crtEmulation && settings.curvature > 0) {
  let x = (u - 0.5) * 2 * (1 + settings.curvature * 0.1);
  let y = (v - 0.5) * 2 * (1 + settings.curvature * 0.1);
  x *= 1 + Math.pow(Math.abs(y) / 5, 2) * settings.curvature * 5;
  y *= 1 + Math.pow(Math.abs(x) / 4, 2) * settings.curvature * 5;
  u = x / 2 + 0.5;
  v = y / 2 + 0.5;
}
const cell = fontCellSize(...);
const offset = terminalContentOffset(source.width, source.height, terminal.cols, terminal.rows, cell);
col = Math.floor((u * source.width - offset.x) / cell.width) + 1;
row = Math.floor((v * source.height - offset.y) / cell.height) + 1;
```

The inline TypeScript mapping matches the shader's `curve()` formula. Selection and terminal mouse input therefore follow the visible curvature back into source-canvas coordinates.

### Scrollback

When `terminal.buffer.active === terminal.buffer.normal` (normal buffer, not alternate screen), wheel events that are not consumed by application mouse tracking scroll the xterm viewport by ±3 lines.

### Copy Mode

1. **Enter copy mode:** Menu+C sets `copyModeRef.current = true`
2. **Start selection:** Left-click in copy mode (or middle-button in any mode) begins a drag selection
3. **Drag:** `handleTerminalMouseMove` updates `copySelectionRef` with start/end `CopyPoint`
4. **End selection:** `handleTerminalMouseUp` calls `copySelection()` which reads text from xterm buffer using `line.translateToString()` and writes to `navigator.clipboard`
5. **Visual feedback:** `drawTerminal()` draws a semi-transparent blue highlight (`rgba(125, 210, 255, 0.42)`) over selected cells

The `copyPoint()` helper (lines 513–516) has hardcoded coordinate offsets (`cell.row - 2` and `cell.col - 3`) that appear to be calibration adjustments. These may need tuning if font metrics or padding calculations change.

### Clipboard Behavior

| Action | Mechanism | Source |
|--------|-----------|--------|
| Paste (Menu+V) | `navigator.clipboard.readText()` → `sendInput()` | App keyboard handler |
| Paste (browser) | `onPaste` event on canvas → `clipboardData.getData('text')` → `sendInput()` | Canvas paste handler |
| Copy (Menu+C drag) | Buffer text extraction → `navigator.clipboard.writeText()` | Copy mode handlers |

All clipboard access uses the browser/WebView's `navigator.clipboard` API. This requires the WebView to have clipboard permissions (typically granted by default in Tauri WebView2).

---

## Terminal Buffer Rendering

### Canvas 2D Drawing (`drawTerminal()`)

The terminal is drawn to an offscreen source canvas at the virtual resolution (e.g., 640×480), not at physical pixel resolution (unless "Physical" mode is selected).

**Drawing algorithm (simplified):**

```
for each row (0..terminal.rows):
  line = buffer.getLine(viewportY + row)
  for each column (0..terminal.cols):
    cell = line.getCell(column)
    fg = cellColor(cell, foreground=true, profile)
    bg = cellColor(cell, foreground=false, profile)
    if cell.isInverse(): swap fg, bg
    if bg ≠ profile.background: fillRect(bg)
    if selection active and cell in range: fillRect(selection highlight)
    if cell has chars and not invisible:
      globalAlpha = cell.isDim() ? 0.6 : 1
      fillText(chars, x, y)
cursor: blinking block/bar/underline at 2Hz
```

**Dirty-driving:** `onWriteParsed()` and cursor movement mark the terminal for comparison, not an automatic full repaint. The renderer snapshots every row's visible cell state and redraws only changed rows plus the old/new cursor row. A scroll, source resize, font/profile change, or selection change invalidates the whole source canvas.

### Color Remapping

Colors are resolved through the active color profile:
1. **RGB colors** (`cell.isFgRGB()`): Passed through `remapLegacyRgb()` which checks if the RGB value matches a Windows Legacy palette entry and remaps it to the active profile's equivalent.
2. **Palette colors** (`cell.isFgPalette()`): Looked up in `profileColor(profile, index)` — uses the profile's 16-color palette for indices 0–15, falls back to the xterm 256-color cube for 16–255.
3. **Default colors**: Uses `profile.foreground` / `profile.background`.

---

## CRT Pipeline

The CRT pipeline runs every frame inside `requestAnimationFrame`. The `CRTFilter.render()` method executes up to 9 WebGL passes, reflecting the listed luma reduction, persistence, soft-bloom, glow, and final passes:

### Pass 1: Persistence Accumulation (conditional)

**Active when:** `settings.persistence > 0` and `settings.crtEmulation === true`

Uses ping-pong FBOs at `persistenceResolutionScale` (0.5×) of output resolution, so history is in physical screen coordinates.

1. Ping-pong two full-resolution source textures: the latest terminal frame and the immediately preceding one.
2. Bind the latest source (TEXTURE0), previous source (TEXTURE1), history FBO texture (TEXTURE2), and current/previous average-luma textures (TEXTURE3/4).
3. Render accumulation shader to target FBO:
   - `decayedHistory = max(0, history * decay - cutoff)`
   - map both source frames through their own curvature and HV-breathing raster geometry; when the source changed, `emission = max(previous - current, 0) * 0.09`
   - `trail = max(emission, decayedHistory)`
   - Slight desaturation (mix with luma at 35%)
4. Swap ping-pong FBOs

#### Persistence invariant: history contains only extinguished light

The direct source image already displays steady phosphors. The persistence FBO must therefore store only the light that disappeared between source frames, never a standing copy of the current frame or its background.

This matters for FAR Manager and other TUIs with a bright coloured background. The former model seeded every accumulation pass with `current * 0.09`. A static blue panel consequently maintained a non-zero history floor forever; a ghost was especially visible through scanlines and only appeared to fade when a later screen update changed the input. The render loop itself was healthy (60 FPS, ~16.7 ms accumulation intervals); clearing history on a scene change merely hid the defect and was intentionally rejected.

The current model compares the two source textures only when `sourceChanged` is true and emits the positive part of `previous - current`. This comparison is in output space after curvature and HV Breathing, using a ping-ponged average luma for each raster; when HV Breathing contracts the raster, the exposed physical phosphor points decay naturally. Closing a FAR dialog, moving a selection highlight, or covering shell text with a panel therefore creates a trail; an unchanged panel contributes no new energy and the FBO decays to zero. `clearPersistence()` also drops the source-frame comparison state so a resize cannot create a false first-frame trail.

**Decay calculation** (`persistenceDecay()`):
- Base = lerp(0.2, 0.9915, persistence)
- Half-life computed from base
- Decay = exp(-ln2/halfLife × elapsedSeconds) — time-based, not frame-based
- Cutoff = (30/255) × elapsedSeconds — prevents 8-bit quantization floor from causing permanent burn-in

### Pass 2: Bloom + Glow Blur (conditional)

**Active when:** `bloom > 0` (soft algorithm) or `glow > 0`, and `crtEmulation === true`

Uses FBOs at `glowResolutionScale` (0.5×).

**Bloom** (soft algorithm, 2 passes):
1. Horizontal blur with bright-pass threshold 0.55, spread 1.0
2. Vertical blur with no threshold, spread 1.0

**Glow** (4 passes — wider kernel):
1. Horizontal blur with threshold 0.08, spread 1.5
2. Vertical blur, spread 1.5
3. Horizontal blur (second iteration), spread 1.5
4. Vertical blur (second iteration), spread 1.5

Each blur pass uses a 5-tap Gaussian kernel (weights: 0.227027, 0.316216×2, 0.070270×2).

### Pass 3: Final CRT Fragment Shader

The final shader is specialized when Trail, Bloom, Glow, Imperfect signal, Hum-bar, or Channel switch roll are toggled, so disabled effect branches are removed at compile time. Persistence FBOs are cleared only when Trail transitions from enabled to disabled.

The main fragment shader applies all visual effects in order:

```
1. CRT Emulation bypass check (if disabled → simple brightness/contrast only)
2. Curvature distortion (barrel/pincushion)
3. Bezel detection → selected bezel treatment: 16-tap phosphor spill or blurred screen reflection
4. HV Breathing raster expansion
5. Imperfect signal UV distortion
6. Hum-bar UV position
7. Channel switch roll
8. Chromatic aberration (R/B channel offset)
9. Persistence trail overlay (from Pass 1)
10. Bloom/halation overlay (from Pass 2 or inline 16-tap spiral)
11. Phosphor grain/noise texture
12. Scanlines (Sinc-integrated Fourier beam with Lottes phase jitter)
13. Beam modulation (luma-dependent scanline width)
14. Image brightness/contrast correction
15. Color mode conversion (luma × phosphor tint)
16. Background desaturation (monochrome modes only)
17. Composite, Imperfect signal flicker, and Hum-bar light band
18. Color phosphor mask (optional; RGB aperture, slot, or shadow pattern)
19. Screen glow overlay (from Pass 2, desaturated 35%, thick-glass diffusion over phosphors & mask)
20. Vignette & ambient glass light
21. Final clamp × 1.1
```

### HV Breathing

HV Breathing drives raster expansion from a GPU reduction of the actual source texture: when the source changes and the effect is enabled, a 16×16 evenly spaced luma sample grid is rendered to a 1×1 texture. The final CRT shader samples that texture directly, so the response remains frame-accurate without a CPU canvas readback or dependence on terminal-cell and tab-colour heuristics. With HV Breathing disabled, the reduction pass is skipped entirely.

### Ambient Glass Light

Ambient Glass Light is a static, soft external illumination across the centre of the curved screen, modelled after cool-retro-term's `Ambient Light`. It is independent of terminal content, bloom, and glow. A 0–1 control blends a pale glass-light mask that smoothly fades toward the screen edges; at zero its shader branch is compiled out.

### Bezel Glow Modes

`Phosphor spill` is the original 16-tap local halo sampled from the source image. `Screen reflection` mirrors a softened reduced-resolution bright screen texture into the curved matte bezel, like the cool-retro-term frame-shininess effect. It uses the same four half-resolution blur passes as Screen glow, reusing that texture whenever glow is enabled. Both it and Bezel highlight pass through the phosphor colour conversion in monochrome modes.

`Bezel highlight` is separate: an external-light band on the inner plastic facet. Its geometric mask fades toward corners and is independent of reflection mode and blur passes. With HV Breathing enabled, the existing GPU average-luma texture gently modulates it from 0.65× to 1.25×; otherwise it stays at the selected strength and does not enable luma reduction.

`Bezel thickness` (0–10 px) adjusts the extra inward frame margin. When set above 0, the matte bezel, highlight facet, and glow/reflections become visible even at zero curvature, proportionally contracting the active screen area by the selected number of physical pixels.

### Signal Effects

- **Imperfect signal** is one 0–1 strength control for subtle temporal flicker, global and per-line X/Y jitter, and rolling horizontal waves. Wave motion runs at 15 Hz while its random interference state changes at 1.5 Hz, avoiding a repeated uniform pattern.
- **Hum-bar** is a separate 0–1 control for a glowing horizontal band that travels top-to-bottom at 0.08 cycles per second. It adds light only; it does not displace scanlines or create tearing.
- **Channel switch roll** is an on/off CRT control. On a terminal-to-terminal tab change, the current image starts a 420 ms vertical roll; the new source is bound after 150 ms and continues the same roll. Persistence history is deliberately retained for this transition, so the old source decays over the new one. Browser transitions, new tabs, and tab closure stay immediate.

When a signal effect is off, its final-shader macro is compiled out. Channel switch roll also has no transition delay when disabled.

### CRT Emulation Toggle

When `crtEmulation` is `false`, a separate pass-through shader applies only brightness/contrast to the raw terminal image; CRT, persistence, blur, and final CRT shader work do not run. This provides a "clean" terminal view.

### Color Modes

| Mode | Enum Value | Shader Behavior |
|------|-----------|----------------|
| Color | `'color'` (0) | Full RGB passthrough |
| B&W | `'bw'` (1) | Luma × vec3(1.0) — D65 white |
| Green | `'green'` (2) | Luma × vec3(0.45, 1.0, 0.62) |
| Amber | `'amber'` (3) | Luma × vec3(1.0, 0.58, 0.2) |
| Blue | `'blue'` (4) | Luma × vec3(0.42, 0.72, 1.0) |

### Color Phosphor Mask

Color mode can optionally apply a screen-space procedural RGB mask after the final image, scanlines, and hum-bar are composited, before the thick-glass screen glow is overlaid. Tight Bloom/halation remains before the mask to expand the electron-beam image; wide Glow is applied afterward as diffusion of the emitted light through the faceplate glass. `Aperture grille` uses vertically blended RGB stripes, `Slot mask` blends neighbouring RGB phosphors while retaining staggered dark rows, and `Shadow mask` uses a staggered `RRGGBB / GBBRRG` pattern. The mask remains in physical output-pixel coordinates for stable high-frequency detail, uses an Auto scale of approximately 640 triads across the screen, and is disabled for B&W and monochrome phosphor modes.

### Bloom Algorithms

| Algorithm | Method |
|-----------|--------|
| **Soft** (default) | Pre-computed separable Gaussian blur at half resolution (Pass 2). Clean, fast. |
| **Spiral** (legacy) | Inline 16-tap golden-angle spiral blur in the fragment shader. More textured, more expensive. |

---

## Font Discovery and Console Sizing

### Font Enumeration

The `list_monospace_fonts` Tauri command uses Win32 GDI:

1. Creates a compatible DC (`CreateCompatibleDC`)
2. Calls `EnumFontFamiliesExW` with `DEFAULT_CHARSET`
3. Callback (`collect_monospace_font`) filters by `TMPF_FIXED_PITCH` flag
4. Skips names starting with `@` (vertical fonts) and empty names
5. Collects into `BTreeSet<String>` for sorted, deduplicated output

The frontend prepends `"Consolas"` to ensure a fallback is always available.

### Global Summon Hotkey

The persisted `globalHotkeyEnabled` setting invokes `set_global_hotkey_enabled`. When enabled, the Rust-side `tauri-plugin-global-shortcut` registers `Win+~` (`SUPER+Backquote`) with Windows. Pressing it hides Scanline Term only when it is already focused; otherwise it shows and focuses the main window. A registration failure, such as an OS-reserved or already claimed shortcut, is reported to the UI and resets the setting to disabled.

### Font Size and Cell Measurement

`fontCellSize(fontSize, fontFamily)` in App.tsx:

```typescript
context.font = `${fontSize}px "${family}", Consolas, "Courier New", monospace`;
const metrics = context.measureText('M');
width = Math.ceil(metrics.width);
height = Math.ceil(ascent + descent);  // fontBoundingBox or actualBoundingBox
```

### Terminal Dimensions Calculation

`terminalDimensions(width, height, fontSize, fontFamily)`:

```
padding = max(2, floor(min(width, height) * 0.01))
cell = fontCellSize(fontSize, fontFamily)
cols = clamp(floor((width - 2*padding) / cellWidth), 20, 300)
rows = clamp(floor((height - 2*padding) / cellHeight), 8, 150)
```

These limits match the Rust validation in `pty_size()`: cols ∈ [20, 300], rows ∈ [8, 150].

After the dimensions are rounded down to whole cells, the renderer centres the resulting grid in the source canvas. The remaining pixels are therefore shared between opposite bezel edges instead of all accumulating below and to the right.

### Virtual vs Physical Resolution

| Mode | Source Canvas Size | Effect |
|------|-------------------|--------|
| **Virtual** (QVGA, VGA, SVGA, XGA) | Fixed size (e.g., 640×480) | Terminal grid fits the virtual buffer; CRT shader upscales to physical display |
| **Physical** | `output.width × output.height` (physical pixels × DPR) | Terminal grid fits the actual window; no CRT upscaling — 1:1 pixels |

When resolution changes or the window resizes in Physical mode, the source canvas dimensions update, terminal dimensions are recalculated, and `invoke('resize_terminal')` is called.

---

*[Next: Design Decisions →](./05-design-decisions.md)*
