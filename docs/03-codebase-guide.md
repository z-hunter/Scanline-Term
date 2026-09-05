# 3 · Codebase Guide

[← Architecture](./02-architecture.md) · [Index](./README.md) · [Core Systems →](./04-core-systems.md)

---

## Repository Tree

```
ScanlineTerm/
├── docs/                         # This documentation
├── public/
│   ├── icon.svg                  # Favicon / window icon
│   ├── scanline-term-eye.png     # Product artwork
│   └── splash.jpg                # Splash screen image (256×256)
├── src/
│   ├── ai/
│   │   ├── CodexClient.ts         # app-server JSON-RPC client
│   │   ├── modelSelection.ts      # per-tab model/effort defaults and fallback
│   │   └── protocol.ts            # minimal protocol subset
│   ├── assets/
│   │   └── scanline-term-mini.png  # Logo asset
│   ├── crt/
│   │   ├── CRTFilter.ts           # ★ WebGL CRT shader pipeline (1101 lines)
│   │   ├── settings.ts            # CRT settings, resolutions, localStorage loader
│   │   └── settings.test.ts       # Unit tests for settings validation
│   ├── App.tsx                    # React composition root
│   ├── terminal/                  # xterm/ConPTY session, renderer and input helpers
│   ├── ui/                        # SettingsPanel, AiPanel, TerminalTabs, layoutFit and Knob components
│   ├── main.tsx                   # React entry point (createRoot)
│   ├── styles.css                 # Application stylesheet
│   ├── assets.d.ts                # TypeScript type shim for .png imports
│   ├── terminal/terminal-input.ts # VT key encoding (standard terminal mode)
│   ├── terminal/terminal-input.test.ts # Unit tests for VT key encoding
│   ├── win32-input.ts             # Win32 Input Mode key encoding
│   ├── win32-input.test.ts        # Unit tests for Win32 Input Mode
│   ├── terminal/terminal-mouse.ts # Mouse event SGR/X10 encoding
│   ├── terminal/terminal-mouse.test.ts # Unit tests for mouse encoding
│   ├── terminal-color-profiles.ts # 8 color palette definitions + remapping
│   ├── terminal-color-profiles.test.ts  # Unit tests for color profiles
│   └── terminal-responses.test.ts # Test: xterm cursor-position report
├── src-tauri/
│   ├── src/
│   │   ├── codex.rs              # Codex app-server lifecycle and JSONL bridge
│   │   └── main.rs               # ★ Rust backend — Tauri commands, ConPTY, fonts
│   ├── capabilities/
│   │   └── default.json          # Tauri security capability grants
│   ├── resources/
│   │   └── conpty/x64/           # Bundled ConPTY DLLs (Windows x64)
│   ├── icons/                    # Application icons (.ico, .png)
│   ├── tauri.conf.json           # Tauri build and window configuration
│   ├── Cargo.toml                # Rust crate manifest
│   ├── Cargo.lock                # Rust dependency lock
│   ├── build.rs                  # Tauri build hook (tauri_build::build)
│   └── THIRD_PARTY_NOTICES.md    # Third-party license notices
├── index.html                    # HTML entry point with splash screen
├── package.json                  # npm scripts and dependencies
├── vite.config.ts                # Vite + React plugin config
├── vitest.config.ts              # Vitest config (happy-dom environment)
├── eslint.config.js              # ESLint flat config
├── tsconfig.json                 # TypeScript project references root
├── tsconfig.app.json             # Frontend TypeScript config
├── tsconfig.node.json            # Node-side TypeScript config
├── BACKLOG.md                    # Planned features
├── README.md                     # Project readme
└── LICENSE                       # MIT license
```

---

## File-by-File Guide

> **Current frontend composition:** `App.tsx` is the layout root. `terminal/useTerminal.ts` owns terminal sessions plus ephemeral browser tabs, active input routing and per-tab colors; `ui/TerminalTabs.tsx` renders the post-it tab strip. Terminals share one `TerminalRenderer` and CRT filter; browser tabs are native child WebViews and deliberately bypass the CRT pipeline.

`App.tsx` also owns the Codex thread-to-terminal-session map and chat state. See [Codex Terminal Assistant](./10-ai-assistant.md) before changing that routing or the app-server isolation.

### AI assistant

| File | Public responsibility |
|---|---|
| [`ai/CodexClient.ts`](../src/ai/CodexClient.ts) | One app-server client: initialization, paged visible-model catalog, pending-request table, generation filtering, notifications and debug stream. |
| [`ai/modelSelection.ts`](../src/ai/modelSelection.ts) | Pure Luna/medium preference and model-effort fallback logic for each terminal tab. |
| [`ai/protocol.ts`](../src/ai/protocol.ts) | Small JSON-RPC `Json`, `Rpc` and event types used at the integration boundary. |
| [`ui/AiPanel.tsx`](../src/ui/AiPanel.tsx) | Renders the active session's local messages, slash-command palette, model/effort picker, sign-in action and debug console. |
| [`terminal/TerminalSession.ts`](../src/terminal/TerminalSession.ts) | `snapshot`, `waitForOutput` and `sendAutomationInput` used by the dynamic tools. |

### Frontend Core

#### [`src/App.tsx`](../src/App.tsx)

The single React component that constitutes the entire UI. Contains:

| Section | Lines (approx) | Responsibility |
|---------|------|------|
| Type definitions | 1–25 | `NumericKey`, `Control`, `CopyPoint`, `CopySelection`, settings control definitions |
| `Knob` component | 53–76 | Rotary knob widget with pointer-drag, wheel, and keyboard interaction |
| Layout helpers | 78–121 | `terminalPadding()`, `fontCellSize()`, `terminalDimensions()`, `sourceDimensions()`, `activeColorProfile()`, `cellColor()`, `canvasFont()` |
| `drawTerminal()` | 123–182 | Reads xterm buffer cells, draws background/foreground/cursor on Canvas 2D. Handles inverse, dim, invisible attributes. Draws copy selection highlight. |
| `drawMockTerminal()` | 184–263 | Animated mock terminal for browser preview (no ConPTY) |
| `App()` — state | 269–300 | React state: `stored` (settings), `error`, `terminalLive`, `monospaceFonts`, `settingsVisible`, `terminalSize`, `fps`. Refs for terminal, filter, canvas, input, modes, copy selection. |
| `App()` — effects | 297–466 | Settings persistence (localStorage), resolution sync, font enumeration, terminal init (xterm + ConPTY), resize handling, render loop (rAF) |
| `App()` — input | 468–664 | `sendInput()`, mouse cell mapping, copy selection, mouse handlers (down/up/move/leave/wheel), keyboard handler (keydown/keyup with capture) |
| `App()` — JSX | 666–836 | Layout: display panel + settings panel. Controls: resolution, color mode, color profile, bloom algorithm, console font/size, knob groups, checkboxes, reset button |

**Key state refs** (mutable refs for use in event handlers without re-renders):

| Ref | Type | Purpose |
|-----|------|---------|
| `terminalRef` | `Terminal \| null` | xterm instance |
| `filterRef` | `CRTFilter \| null` | WebGL filter instance |
| `sourceRef` | `HTMLCanvasElement \| null` | Source canvas for terminal drawing |
| `outputRef` | `HTMLCanvasElement` | WebGL output canvas (DOM ref) |
| `sendInputRef` | `(input: string) => void` | Stable reference to `sendInput` closure |
| `win32InputModeRef` | `boolean` | Whether ConPTY enabled Win32 Input Mode (`?9001h`) |
| `sgrMouseModeRef` | `boolean` | Whether SGR mouse mode is active (`?1006h`) |
| `menuKeyDownRef` | `boolean` | Context menu key is held |
| `fullscreenShortcutRef` | `boolean` | Alt+Enter in progress |
| `copyModeRef` | `boolean` | Copy-mode active (Menu+C) |
| `copyStartRowRef` | `CopyPoint \| null` | Drag selection anchor |
| `copySelectionRef` | `CopySelection \| null` | Current selection range |
| `pressedMouseButtonsRef` | `Set<number>` | Currently pressed mouse buttons |
| `terminalSizeRef` | `{cols, rows}` | Last sent terminal dimensions |
| `resolutionRef` | resolution object | Current resolution for use in callbacks |
| `settingsRef` | `CRTSettings` | Current settings for use in rAF loop |

---

#### [`src/crt/CRTFilter.ts`](../src/crt/CRTFilter.ts)

The WebGL CRT post-processing pipeline. Originated in the Quest/Scanline game engine.

**Exported types:**
- `CRTColorMode` — `'color' | 'bw' | 'green' | 'amber' | 'blue'`
- `BloomAlgorithm` — `'soft' | 'spiral'`
- `CRTSettings` — Full interface with 24 fields
- `persistenceDecay(persistence, elapsedSeconds)` — Calculates FBO decay factor and quantization cutoff

**Class: `CRTFilter`**

| Method | Purpose |
|--------|---------|
| `constructor(canvas)` | Acquires WebGL context, calls `init()` |
| `init()` | Compiles the initial CRT variant plus accumulation and blur programs; the final shader is specialized when Trail, Bloom, or Glow are toggled |
| `createShader(gl, type, source)` | Compiles a single GLSL shader |
| `createProgram(gl, vsSource, fsSource)` | Links a vertex+fragment program |
| `ensureFBO(width, height)` | Creates/resizes ping-pong FBOs for persistence |
| `ensureGlowFBO(width, height)` | Creates/resizes FBOs for bloom and glow blur passes |
| `blur(input, w, h, target, dx, dy, threshold, spread)` | Runs one separable Gaussian blur pass |
| `clearPersistence()` | Clears both persistence FBOs to black |
| `isValid()` | Returns `true` if WebGL resources are available |
| `render(sourceCanvas, settings, sourceChanged)` | Main render entry — direct pass-through with CRT off, otherwise persistence → bloom/glow → specialized final CRT |
| `dispose()` | Deletes all WebGL resources |

**Shader programs:**

1. **CRT Main Fragment Shader** — curvature, anti-moiré pixels, chromatic aberration, persistence trail overlay, bloom/halation, phosphor grain, scanlines (Sinc-integrated Fourier), beam modulation, screen glow, color mode conversion, vignette, brightness/contrast, bezel glow
2. **Accumulation Fragment Shader** — phosphor persistence: blends current frame with decayed history, desaturation, quantization cutoff
3. **Blur Fragment Shader** — 5-tap separable Gaussian, configurable threshold (bright-pass) and spread
4. **Pass-through Fragment Shader** — raw terminal image with brightness/contrast only when CRT emulation is off

---

#### [`src/crt/settings.ts`](../src/crt/settings.ts)

| Export | Purpose |
|--------|---------|
| `DEFAULT_CRT_SETTINGS` | Frozen defaults for all CRT parameters |
| `RESOLUTIONS` | Array of `{id, label, width?, height?}` — `'physical'`, `'physical-4x3'`, `'physical-8x5'`, `'420x300'`, `'640x480'`, `'800x600'`, `'1024x768'`, `'1280x800'` |
| `DEFAULT_RESOLUTION` | `'1024x768'` |
| `ResolutionId` | Union type of resolution identifiers |
| `StoredSettings` | `{ version: 1, resolution, crt }` |
| `loadStoredSettings(raw)` | Parses JSON from localStorage, validates each field against range constraints, migrates legacy profile names (`retrowave`/`zx-spectrum` → `cyberpunk`), returns safe defaults on any error |

---

#### [`src/terminal-input.ts`](../src/terminal-input.ts)

Standard VT terminal key encoding (used when Win32 Input Mode is **not** active).

| Export | Purpose |
|--------|---------|
| `TerminalInputModes` | `{ applicationCursorKeysMode, applicationKeypadMode }` |
| `terminalKey(event, modes)` | Returns a VT escape sequence string or `null`. Handles: F1–F24 with modifiers, cursor keys (DECCKM), numpad (DECKPAM), tilde keys (Insert/Delete/PgUp/PgDn), Pause, Escape, Backspace, Tab/Shift-Tab, Enter, Ctrl+letter, Alt+key |

Key encoding details:
- Function keys: `\x1bOP`..`\x1bOS` for F1–F4, `\x1b[15~`..`\x1b[45~` for F5–F24
- Modifiers encoded as `1 + shift + 2*alt + 4*ctrl`
- Ctrl+letter: maps A–Z → 0x01–0x1A via `controlCharacter()`
- Ctrl+Space / Ctrl+2 → NUL; Ctrl+? → DEL

---

#### [`src/win32-input.ts`](../src/win32-input.ts)

Win32 Input Mode (`?9001h`) key encoding. Sends both keydown and keyup events with full Win32 virtual key codes, scan codes, and modifier state.

| Export | Purpose |
|--------|---------|
| `win32InputKey(event, keyDown)` | Returns `\x1b[vk;sc;uc;kd;cs;1_` — a 7-field CSI sequence |

Fields: `virtualKey`, `scanCode`, `unicodeCharacter`, `keyDown` (0/1), `controlState` (bitmask: enhanced/right-ctrl 0x04, left-ctrl 0x08, right-alt 0x01, left-alt 0x02, shift 0x10, caps-lock 0x80, num-lock 0x20, scroll-lock 0x40), repeat count (always 1).

Contains lookup tables for:
- Named keys (punctuation, modifiers, navigation, numpad)
- Letter scan codes (QWERTY layout, `letterScans`)
- Digit scan codes (`digitScans`)
- Function key scan codes F1–F24 (`functionScans`)

---

#### [`src/terminal-mouse.ts`](../src/terminal-mouse.ts)

| Export | Purpose |
|--------|---------|
| `MouseTrackingMode` | `'none' | 'x10' | 'vt200' | 'drag' | 'any'` |
| `MouseAction` | `'press' | 'release' | 'move' | 'wheel-up' | 'wheel-down'` |
| `MouseEventData` | Full mouse event descriptor |
| `terminalMouse(event)` | Returns SGR (`\x1b[<...M/m`) or X10 (`\x1b[M...`) encoded string |

Button code calculation includes modifier bits (shift=4, alt=8, ctrl=16), wheel offset (64/65), and move flag (32).

---

#### [`src/terminal-color-profiles.ts`](../src/terminal-color-profiles.ts)

Defines 8 terminal color profiles:

| Profile ID | Label | Notable Colors |
|------------|-------|------|
| `dos-vga` | DOS VGA | Classic brown (#aa5500), bright colors |
| `windows-legacy` | Windows Legacy | Standard 16-color Windows palette |
| `windows-campbell` | Windows Campbell | Modern Windows Terminal palette |
| `xterm-x11` | xterm / X11 | 16 + 216 cube + 24 grayscale = 256 colors |
| `solarized-dark` | Solarized Dark | Ethan Schoonover's scheme |
| `ibm-3279` | IBM 3279 | Green/pure 8-color mainframe palette |
| `commodore-64` | Commodore 64 | Authentic C64 color values |
| `cyberpunk` | Cyberpunk | Neon accent palette |

| Export | Purpose |
|--------|---------|
| `COLOR_PROFILES` | Array of all profile objects |
| `colorProfile(id)` | Lookup by ID, falls back to `windows-legacy` |
| `profileColor(profile, index)` | Returns color at palette index; falls back to xterm extended cube for indices 16–255 |
| `remapLegacyRgb(profile, color)` | If `color` matches a Windows Legacy palette entry (by hex), returns the equivalent color in `profile`. Used because Windows console apps emit legacy RGB values that need remapping. |

---

### Rust Backend

#### [`src-tauri/src/codex.rs`](../src-tauri/src/codex.rs)

Owns the singleton hidden `codex app-server --stdio` process. It validates the CLI version, creates an app-local isolated `CODEX_HOME` and workspace, converts JSON-RPC messages to JSONL, emits `codex-message` / `codex-stderr` / `codex-exit`, and kills the known process tree on shutdown.

#### [`src-tauri/src/main.rs`](../src-tauri/src/main.rs)

| Item | Purpose |
|------|---------|
| `TerminalSession` | Holds `Child`, `Sender<Vec<u8>>` (input channel), `PtyController` |
| `TerminalState` | `Mutex<HashMap<SessionId, TerminalSession>>` with `Drop` that kills every child |
| `pty_size(cols, rows)` | Validates dimensions: cols ∈ [20, 300], rows ∈ [8, 150] |
| `bundled_conpty_dir(app)` | Resolves ConPTY DLL path: dev = `CARGO_MANIFEST_DIR/resources/conpty/x64`, release = Tauri resource `conpty/x64` |
| `collect_monospace_font()` | Win32 `EnumFontFamiliesExW` callback; filters by `TMPF_FIXED_PITCH`, skips `@`-prefixed and empty names |
| **`#[tauri::command] list_monospace_fonts()`** | Enumerates all system monospace fonts using GDI; returns `Vec<String>` sorted via `BTreeSet` |
| **`#[tauri::command] start_terminal(app, state, session_id, cols, rows, launch)`** | Validates the UUID, spawns and registers a ConPTY session with an optional command and working directory, then returns the executable filename |
| **`#[tauri::command] initial_terminal_launch()`** | Returns the parsed launch request for the first terminal tab |
| **`#[tauri::command] write_terminal(state, session_id, input)`** | Clones the target session's `mpsc::Sender`, sends `input.into_bytes()` |
| **`#[tauri::command] resize_terminal(state, session_id, cols, rows)`** | Validates with `pty_size()`, calls the target controller's `resize()` |
| **`#[tauri::command] active_terminal_process(state, session_id)`** | Returns the image name of the direct child process of the shell, if one is running |
| **`#[tauri::command] close_terminal(state, session_id)`** | Idempotently removes and kills the target child process |
| **`#[tauri::command] set_global_hotkey_enabled(app, enabled)`** | Registers or unregisters global `Win+~`; its callback hides the focused window or shows and focuses it |
| `main()` | Builds Tauri app with terminal and Codex managed state, app-server/opener/global-shortcut plugins and command handlers |
| **Tests** | `limits_terminal_dimensions`, `validates_frontend_session_ids`, bundled ConPTY integration tests |

### Tauri Commands and Events

#### Commands (frontend → Rust)

| Command | Parameters | Returns | Called from |
|---------|------------|---------|------------|
| `start_terminal` | `sessionId, cols: u16, rows: u16, launch?` | executable filename | Create a terminal tab |
| `initial_terminal_launch` | — | `{ command?, cwd? }` | First terminal tab |
| `write_terminal` | `sessionId, input: String` | `Result<(), String>` | `sendInput()`, keyboard/mouse handlers |
| `resize_terminal` | `sessionId, cols: u16, rows: u16` | `Result<(), String>` | Resize all live tabs after display changes |
| `active_terminal_process` | `sessionId` | `Option<String>` | Poll active child process for the tab-title fallback |
| `close_terminal` | `sessionId` | `Result<(), String>` | Tab close button |
| `list_monospace_fonts` | — | `Vec<String>` | Font enumeration effect |
| `operating_system` | — | OS/version string | Terminal-assistant instructions |
| `set_global_hotkey_enabled` | `enabled: boolean` | `Result<(), String>` | Persisted global-hotkey setting effect |
| `codex_start` | — | `{ generation, version, workspace }` | Start or reuse isolated app-server |
| `codex_send` | JSON-RPC object | `Result<(), String>` | `CodexClient` requests, notifications and tool responses |
| `codex_stop` | — | `Result<(), String>` | App-server shutdown |

#### Events (Rust → frontend)

| Event | Payload | Listener |
|-------|---------|----------|
| `terminal-output` | `{ sessionId, data: Vec<u8> }` | Matching `TerminalSession` → `terminal.write()` |
| `terminal-exit` | `{ sessionId }` | Marks that tab exited while preserving its screen buffer |
| `terminal-launch` | `{ command?, cwd? }` | Opens a new tab after a second `-T` invocation |
| `codex-message` | `{ generation, message }` | `CodexClient` JSON-RPC router |
| `codex-stderr` | `{ generation, text }` | Available diagnostic event; not yet subscribed by the frontend |
| `codex-exit` | `{ generation, text }` | Fails pending Codex requests for the active generation |

### Configuration

#### [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json)

| Key | Value | Notes |
|-----|-------|-------|
| `productName` | `"Scanline Term"` | Display name |
| `identifier` | `"com.zhunter.scanlineterm"` | Bundle identifier |
| `app.windows[0].theme` | `"Dark"` | Forces dark title bar |
| `app.windows[0].width/height` | 1440 × 960 | Default window size |
| `app.security.csp` | `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'` | Content Security Policy |
| `bundle.targets` | `["nsis"]` | NSIS installer only |
| `bundle.resources` | `"resources/conpty/" → "conpty/"` | Bundles ConPTY DLLs |

#### [`src-tauri/capabilities/default.json`](../src-tauri/capabilities/default.json)

Grants to `main` window:
- `core:event:allow-listen` — Required for `terminal-output` and `terminal-exit` events
- `core:window:allow-is-fullscreen` — Alt+Enter fullscreen check
- `core:window:allow-set-fullscreen` — Alt+Enter fullscreen toggle
- `opener:allow-open-url` (`https://**`) — ChatGPT browser login URL only

---

*[Next: Core Systems →](./04-core-systems.md)*
