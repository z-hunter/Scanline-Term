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

**Shell selection:** `start_terminal()` reads `%ComSpec%` (typically `C:\Windows\System32\cmd.exe`), sets the working directory to `%USERPROFILE%`, and sends an initial `\r` to trigger the prompt.

---

## ConPTY and Win32 Input Mode

### ConPTY Basics

The ConPTY session produces VT100/VT220-compatible output. Console applications that use Win32 console APIs (like FAR Manager) are translated by ConPTY to VT sequences.

### Win32 Input Mode (`?9001h`)

When the console host (conhost/ConPTY) requests Win32 Input Mode, it sends `\x1b[?9001h`. The frontend detects this via an xterm CSI handler:

```typescript
// In App.tsx — registerCsiHandler for ?h and ?l
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

The keyboard handler in `App.tsx` (lines 600–664) selects the encoding mode:

```typescript
const input = win32InputModeRef.current
  ? win32InputKey(event, true)
  : terminalKey(event, terminal.modes);
```

### Standard VT Mode (`terminal-input.ts`)

| Key Category | Encoding |
|---|---|
| F1–F4 | `\x1bOP` .. `\x1bOS` (bare); `\x1b[1;modP` .. `\x1b[1;modS` (with modifiers) |
| F5–F24 | `\x1b[15~` .. `\x1b[45~` (bare); `\x1b[N;mod~` (with modifiers) |
| Cursor keys | `\x1b[A`..`D` (normal) or `\x1bOA`..`D` (application cursor keys mode) |
| Home/End | `\x1b[H`/`\x1b[F` (normal) or `\x1bOH`/`\x1bOF` (DECCKM) |
| Insert/Delete/PgUp/PgDn | `\x1b[2~`..`\x1b[6~` with optional modifier parameter |
| Numpad (app mode) | `\x1bOp`..`\x1bOy` for 0–9, `\x1bOn` decimal, `\x1bOo` divide, etc. |
| Tab | `\t` (plain) or `\x1b[Z` (shift) |
| Enter | `\r` (plain) or `\x1b\r` (Alt+Enter, non-fullscreen) |
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
| **Alt+Enter** | Toggle fullscreen (Tauri only) | `onKeyDown`, lines 624–636 |
| **Menu+S** | Toggle settings panel visibility | `onKeyDown`, lines 603–608 |
| **Menu+V** | Paste from clipboard | `onKeyDown`, lines 609–613 |
| **Menu+C** | Enter copy mode | `onKeyDown`, lines 615–623 |

The Menu key (Context Menu / Apps key) is tracked via `menuKeyDownRef`. While held, letter keys are intercepted before terminal input encoding.

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

`terminalMouseCell()` (App.tsx, lines 487–500) maps pixel coordinates to terminal cells:

```typescript
const x = (event.clientX - rect.left) * source.width / rect.width;
const y = (event.clientY - rect.top) * source.height / rect.height;
const cell = fontCellSize(...);
col = Math.floor((x - padding) / cell.width) + 1;  // 1-based
row = Math.floor((y - padding) / cell.height) + 1;  // 1-based
```

**Coordinate caveat:** This mapping uses the source canvas (virtual resolution) dimensions and font cell size. It does **not** account for CRT curvature distortion. If curvature is non-zero, the rendered pixels are warped by the fragment shader, but mouse coordinates use the pre-warp linear mapping. The [BACKLOG.md](../BACKLOG.md) notes "Add inverse curvature mapping for selection and mouse-mode terminal input" as a planned improvement.

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

**Dirty-driving:** The rAF loop checks `sourceDirty` before calling `drawTerminal()`. The flag is set by:
- `terminal.onWriteParsed()` — new output was parsed
- `terminal.onScroll()` — viewport scrolled
- Cursor blink phase changed
- Source canvas size changed
- Settings (font, profile, selection) changed

### Color Remapping

Colors are resolved through the active color profile:
1. **RGB colors** (`cell.isFgRGB()`): Passed through `remapLegacyRgb()` which checks if the RGB value matches a Windows Legacy palette entry and remaps it to the active profile's equivalent.
2. **Palette colors** (`cell.isFgPalette()`): Looked up in `profileColor(profile, index)` — uses the profile's 16-color palette for indices 0–15, falls back to the xterm 256-color cube for 16–255.
3. **Default colors**: Uses `profile.foreground` / `profile.background`.

---

## CRT Pipeline

The CRT pipeline runs every frame inside `requestAnimationFrame`. The `CRTFilter.render()` method executes up to 3 WebGL passes:

### Pass 1: Persistence Accumulation (conditional)

**Active when:** `settings.persistence > 0` and `settings.crtEmulation === true`

Uses ping-pong FBOs at `persistenceResolutionScale` (0.5×) of source resolution.

1. Upload current source canvas to main texture (TEXTURE0)
2. Bind history FBO texture (TEXTURE1)
3. Render accumulation shader to target FBO:
   - `decayedHistory = max(0, history * decay - cutoff)`
   - `trail = max(current * 0.09, decayedHistory)`
   - Slight desaturation (mix with luma at 35%)
4. Swap ping-pong FBOs

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

The main fragment shader applies all visual effects in order:

```
1. CRT Emulation bypass check (if disabled → simple brightness/contrast only)
2. Curvature distortion (barrel/pincushion)
3. Bezel detection → bezel glow rendering (16-tap spiral blur if outside screen)
4. HV Breathing raster expansion
5. Chromatic aberration (R/B channel offset)
6. Persistence trail overlay (from Pass 1)
7. Bloom/halation overlay (from Pass 2 or inline 16-tap spiral)
8. Phosphor grain/noise texture
9. Scanlines (Sinc-integrated Fourier beam with Lottes phase jitter)
10. Beam modulation (luma-dependent scanline width)
11. Screen glow overlay (from Pass 2, desaturated 35%)
12. Image brightness/contrast correction
13. Color mode conversion (luma × phosphor tint)
14. Background desaturation (monochrome modes only)
15. Composite: finalImage × scanline + finalBackground
16. Vignette
17. Final clamp × 1.1
```

### CRT Emulation Toggle

When `crtEmulation` is `false`, the fragment shader skips all CRT effects and applies only brightness/contrast to the raw terminal image. This provides a "clean" terminal view.

### Color Modes

| Mode | Enum Value | Shader Behavior |
|------|-----------|----------------|
| Color | `'color'` (0) | Full RGB passthrough |
| B&W | `'bw'` (1) | Luma × vec3(1.0) — D65 white |
| Green | `'green'` (2) | Luma × vec3(0.45, 1.0, 0.62) |
| Amber | `'amber'` (3) | Luma × vec3(1.0, 0.58, 0.2) |
| Blue | `'blue'` (4) | Luma × vec3(0.42, 0.72, 1.0) |

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

### Virtual vs Physical Resolution

| Mode | Source Canvas Size | Effect |
|------|-------------------|--------|
| **Virtual** (QVGA, VGA, SVGA, XGA) | Fixed size (e.g., 640×480) | Terminal grid fits the virtual buffer; CRT shader upscales to physical display |
| **Physical** | `output.width × output.height` (physical pixels × DPR) | Terminal grid fits the actual window; no CRT upscaling — 1:1 pixels |

When resolution changes or the window resizes in Physical mode, the source canvas dimensions update, terminal dimensions are recalculated, and `invoke('resize_terminal')` is called.

---

*[Next: Design Decisions →](./05-design-decisions.md)*
