# 3 · Codebase Guide

[← Architecture](./02-architecture.md) · [Index](./README.md) · [Core Systems →](./04-core-systems.md)

---

## Codebase Metrics & Volume

Scanline Term is built with a dual-layer architecture: a native **Rust/Tauri backend** handling low-level OS operations (Win32 API, ConPTY, hooks, IPC, Lua sandbox) and a **React/TypeScript frontend** handling UI composition, terminal state, and CRT shader adaptation via the **Scanline Virtual Screen (SVS)** engine.

### Code Volume Summary

| Layer / Language | Total Files | Total Lines (LOC) | Code Lines | Comments | Blank Lines |
|:---|:---:|:---:|:---:|:---:|:---:|
| **Rust (`.rs`)** | 13 | 14,624 | 13,339 | 483 | 802 |
| **TypeScript (`.ts`)** | 55 | 9,427 | 8,406 | 103 | 918 |
| **TypeScript JSX (`.tsx`)** | 19 | 5,864 | 5,498 | 37 | 329 |
| **CSS (`.css`)** | 1 | 1,183 | 1,035 | 6 | 142 |
| **Lua Scripts (`.lua`)** | 7 | 280 | 187 | 63 | 30 |
| **JSON (Presets & Schemas)** | 39 | 11,327 | 11,327 | 0 | 0 |
| **Markdown Documentation** | 27 | 5,753 | 3,581 | 614 | 1,558 |
| **PowerShell Tooling (`.ps1`)** | 5 | 1,785 | 1,722 | 11 | 52 |
| **Other Configs (`html, toml, yml, js`)** | 5 | 416 | 375 | 10 | 31 |
| **Total Repository** | **171** | **~50,659** | **45,470** | **1,327** | **3,862** |

### Test vs. Production Code

Across the combined Rust backend and frontend production/test line totals, **over 41% of those lines are dedicated to automated tests**; this metric does not cover the full repository:

* **Rust Backend:** 9,020 prod lines / **5,604 test lines (38.3% test ratio)** via embedded `#[cfg(test)]` modules.
* **Frontend TS/TSX:** 8,031 prod lines / **7,212 test lines (47.3% test ratio)** across 33 dedicated test suites.
* **External Engine SVS:** ~3,100 prod lines in `Scanline-Virtual-Screen`, pinned by immutable commit.

---

## Repository Tree

```
ScanlineTerm/
├── home-default.json                      # Shared starter config for native and browser home pages
├── docs/                                  # 19 technical documentation chapters
├── examples/
│   └── lua/                               # Sandboxed Lua scripts & user palette presets
├── public/
│   ├── icon.svg                           # Favicon & window icon
│   ├── scanline-term-eye.png              # Product artwork
│   └── splash.jpg                         # Splash screen image (256×256)
├── src/
│   ├── ai/                                # Codex app-server client & protocol
│   │   ├── chatMessages.ts                # Chat message models & delta aggregation
│   │   ├── CodexClient.ts                 # JSON-RPC process client and event routing
│   │   ├── modelSelection.ts              # Model tier & reasoning effort resolution
│   │   ├── protocol.ts                    # Minimal JSON-RPC protocol types
│   │   └── useCodexAssistant.ts           # Per-session assistant state and turn lifecycle
│   ├── assets/
│   │   └── scanline-term-mini.png         # UI badge & mini logo asset
│   ├── crt/                               # CRT parameters, validation & SVS loop hook
│   │   ├── managed-settings.ts            # Persistence adapter for preset configurations
│   │   ├── settings.ts                    # Resolution definitions & CRT settings validation
│   │   └── useCRT.ts                      # WebGL render loop & canvas synchronization hook
│   ├── terminal/                          # xterm.js / ConPTY adapter, input & automation
│   │   ├── automation-probe.ts            # Dev-only context bridge & layout probe
│   │   ├── automation-probe-state.ts      # Tap/Hold classifier & probe reducer
│   │   ├── caps-frame.ts                  # Marked native Caps edge frame decoder
│   │   ├── lua-automation.ts              # Frontend snapshots & Caps policy leases
│   │   ├── lua-preset-request.ts          # Safe preset request validation & rejection
│   │   ├── ScanlineTerminalRenderer.ts    # SVS host adapter, image overlays & splash screen
│   │   ├── shells.ts                      # Shell identity, command resolution & catalog
│   │   ├── terminal-automation.ts         # Shared Codex/MCP observation & input dispatch
│   │   ├── terminal-input.ts              # Standard VT escape sequence keyboard encoder
│   │   ├── terminal-mouse.ts              # X10 & SGR (1006) terminal mouse encoder
│   │   ├── terminal-scroll-heuristic.ts   # Fullscreen TUI scroll detection
│   │   ├── terminal-search.ts             # Smart-case buffer search across viewport & history
│   │   ├── terminal-tab-color.ts          # Post-it tab color palettes & CSS variable mapper
│   │   ├── TerminalSession.ts             # xterm.js instance lifecycle & ConPTY stream buffer
│   │   ├── useLuaAutomationStatus.ts      # Lua diagnostics polling & reload hook
│   │   ├── useManagedSettings.ts          # Settings persistence synchronization hook
│   │   └── useTerminal.ts                 # Central tab state, PTY stream & canvas binding hook
│   ├── ui/                                # UI components, dialogs & panels
│   │   ├── AiPanel.tsx                    # Codex AI terminal assistant drawer
│   │   ├── HomeDashboard.tsx              # Blank tab launchpad & bookmark dashboard
│   │   ├── layoutFit.ts                   # Pixel-precise terminal grid dimension calculator
│   │   ├── LuaAutomationPanel.tsx         # Lua status, diagnostics & reload controls
│   │   ├── nativeNewTabMenu.ts            # Shared Win32 native popup menu for new tabs
│   │   ├── QuickPresetPicker.tsx          # Fast preset preview dialog (Alt+P) with rollback
│   │   ├── ScrollbackScrollbar.tsx        # Styled CRT frame scrollbar with auto-fade
│   │   ├── SettingsPanel.tsx              # Full configuration drawer (CRT, font, system)
│   │   ├── TabGallery.tsx                 # Visual tab matrix overview & CRT thumbnails
│   │   └── TerminalTabs.tsx               # Post-it tab strip with drag-and-drop reordering
│   ├── App.tsx                            # React composition root & global shortcut coordinator
│   ├── assets.d.ts                        # TypeScript declarations for image imports
│   ├── main.tsx                           # React 18 DOM mount point
│   ├── styles.css                         # Global CRT frame, scanlines, post-it notes styling
│   └── win32-input.ts                     # Win32 Console Mode key encoding tables (?9001h)
├── src-tauri/
│   ├── src/
│   │   ├── bin/
│   │   │   └── scanline-term-mcp.rs       # Standalone stdio MCP JSON-RPC sidecar CLI
│   │   ├── automation_probe.rs            # Debug-only Windows hook & input injection probe
│   │   ├── browser.rs                     # Native child WebViews for browser tabs
│   │   ├── caps_hook.rs                   # Low-level Windows hook (`WH_KEYBOARD_LL`) & Smart Caps
│   │   ├── codex.rs                       # Codex app-server child process & JSONL bridge
│   │   ├── explorer.rs                    # Per-user Windows Explorer folder integration
│   │   ├── home.rs                        # Validated home.json manager with .bak recovery
│   │   ├── lua_automation.rs              # Native worker, layout bridge & settings sync
│   │   ├── lua_runtime.rs                 # Sandboxed Lua VM (mlua), budgets & event loop
│   │   ├── main.rs                        # Tauri entry point, ConPTY lifecycle, font scan
│   │   ├── mcp.rs                         # Named-pipe MCP broker (`scanline-term-mcp[-dev]`)
│   │   ├── presets.rs                     # CRT preset catalog & atomic file operations
│   │   └── window_state.rs                # Window size/position persistence & monitor safety
│   ├── capabilities/                      # Tauri security permission capabilities
│   ├── resources/                         # Bundled ConPTY DLLs, fonts & canonical presets
│   ├── icons/                             # Windows executable & taskbar icons
│   ├── Cargo.toml                         # Rust crate manifest & dependencies
│   └── tauri.conf.json                    # Tauri application configuration
├── vite.config.ts                         # Vite configuration
├── vitest.config.ts                       # Vitest unit test runner configuration
├── package.json                           # Frontend scripts & pinned SVS dependency
└── tsconfig.json                          # TypeScript root configuration
```

---

## File-by-File Guide

### 1. Application Composition Root & Styles

#### [`src/App.tsx`](../src/App.tsx) *(composition root)*
The primary React composition root. Rather than containing low-level terminal rendering directly, it coordinates all submodules:
* **Global Hotkey & Shortcut Routing:** Handles `Ctrl+T` (new tab), `Ctrl+W` (close), `Ctrl+Tab` / `Ctrl+Shift+Tab` (tab cycle), `Alt+Enter` (fullscreen), `Alt+P` (quick preset picker), `Menu+Backspace` (tab gallery), and `Ctrl+F` (search).
* **Modal Dialog & Drawer State:** Controls visibility of `SettingsPanel`, `AiPanel`, `QuickPresetPicker`, `TabGallery`, and in-canvas search overlays.
* **Codex Session Mapping:** Supplies active-tab context to `useCodexAssistant`, which owns each tab's thread, messages, model selection, and turn lifecycle.
* **CRT Preview Cache:** Captures lightweight thumbnail frames of inactive tabs to feed the `TabGallery`.
* **Browser Child WebView Handoff:** Notifies `src-tauri/src/browser.rs` to show, resize, or hide child WebViews when switching between terminal and browser tabs.

#### [`src/styles.css`](../src/styles.css) *(1,183 lines)*
Global application stylesheet implementing the physical CRT monitor aesthetic:
* Outer bezel chassis, glass reflection, curved corners, and screen power-on/off flicker.
* Sticky-note (post-it) styling for tabs with realistic paper creases, drop shadows, and active drag states.
* Floating panels, rotary knob styling, search highlight boxes, and custom scrollbars.

---

### 2. Terminal & ConPTY Adapter Layer (`src/terminal/`)

#### [`src/terminal/useTerminal.ts`](../src/terminal/useTerminal.ts) *(1,060 lines)*
The core React hook governing terminal and browser tab lifecycle:
* **Tab Collections:** Manages `tabs: WorkspaceTab[]`, active tab index, tab reordering via pointer drag, and renumbering.
* **PTY Binding:** Invokes `start_terminal` and `close_terminal`, binds incoming `terminal-output` events to the active xterm instance.
* **Canvas Mounting:** Attaches offscreen and on-screen rendering targets to SVS.
* **Context Menus:** Manages native and web context menus for shells, images, and split operations.

#### [`src/terminal/TerminalSession.ts`](../src/terminal/TerminalSession.ts) *(813 lines)*
Encapsulates a single xterm.js terminal instance:
* Receives raw PTY chunks from Rust, buffering and dispatching them into xterm.
* Handles viewport vs. scrollback buffer queries (`getScrollbackLines`).
* Serializes dimension changes (`resize(cols, rows)`) to prevent ConPTY race conditions.
* Provides automation snapshot facilities (`snapshot()`, `waitForOutput()`) for Codex and MCP.

#### [`src/terminal/ScanlineTerminalRenderer.ts`](../src/terminal/ScanlineTerminalRenderer.ts) *(143 lines)*
Scanline Term's host adapter over the SVS WebGL compositor:
* Binds the current terminal session to SVS's `VirtualScreenRenderer`.
* Renders tab-local inline images (e.g. Sixel / graphics protocols) and manages image hit-testing.
* Displays the fallback mock screen and branded `/icon.png` splash screen when no terminal is connected.

#### Specialized Terminal Helpers:
* **[`terminal-input.ts`](../src/terminal/terminal-input.ts) (62 lines):** Standard VT escape sequence encoder (cursor keys, function keys F1–F24, tilde sequences, modifier bitmasks).
* **[`win32-input.ts`](../src/win32-input.ts) (99 lines):** Win32 Console Mode (`?9001h`) encoder. Translates browser keyboard events into 7-field `\x1b[vk;sc;uc;kd;cs;1_` sequences with virtual key codes and scan codes.
* **[`terminal-mouse.ts`](../src/terminal/terminal-mouse.ts) (28 lines):** Encodes mouse clicks, drags, and wheel actions into X10 or SGR (`\x1b[<...M/m`) formats.
* **[`terminal-search.ts`](../src/terminal/terminal-search.ts) (67 lines):** Smart-case search across visible viewport and scrollback buffer history.
* **[`terminal-scroll-heuristic.ts`](../src/terminal/terminal-scroll-heuristic.ts) (81 lines):** Heuristic detector identifying full-screen TUI scrolling (e.g., Far Manager, Vim, Midnight Commander) for smooth sub-line rendering.
* **[`lua-automation.ts`](../src/terminal/lua-automation.ts) (258 lines):** Gathers frontend state snapshots, focus generation counters, and verifies Smart Caps policy leases.
* **[`caps-frame.ts`](../src/terminal/caps-frame.ts) (96 lines):** Decodes binary frames from the native low-level keyboard hook.
* **[`shells.ts`](../src/terminal/shells.ts) (18 lines):** Detects and resolves installed shells (PowerShell, CMD, WSL, Git Bash) and custom profile mappings.

---

### 3. User Interface Components (`src/ui/`)

* **[`SettingsPanel.tsx`](../src/ui/SettingsPanel.tsx) (471 lines):** Full configuration drawer combining SVS CRT display parameters with host settings (font family/size, cursor style, audio bell, MCP toggle, shell defaults, and Explorer integration).
* **[`AiPanel.tsx`](../src/ui/AiPanel.tsx) (339 lines):** Slide-out drawer for the OpenAI Codex terminal assistant. Includes conversation turns, streaming typing indicator, model/effort selector, and shell execution blocks.
* **[`TabGallery.tsx`](../src/ui/TabGallery.tsx) (268 lines):** Matrix overview (opened via `Menu+Backspace`) displaying live CRT thumbnails of all open tabs with spatial keyboard navigation.
* **[`HomeDashboard.tsx`](../src/ui/HomeDashboard.tsx) (259 lines):** Start page for blank browser tabs, featuring categorized bookmarks, quick search, and shell launchers.
* **[`TerminalTabs.tsx`](../src/ui/TerminalTabs.tsx) (234 lines):** Post-it style tab strip with animated drag-and-drop reordering and color badges.
* **[`ScrollbackScrollbar.tsx`](../src/ui/ScrollbackScrollbar.tsx) (147 lines):** Transient CRT monitor border scrollbar with mouse drag-capture and auto-fade.
* **[`layoutFit.ts`](../src/ui/layoutFit.ts) (90 lines):** Mathematical grid calculator determining exact character columns and rows fitting within current window dimensions.
* **[`QuickPresetPicker.tsx`](../src/ui/QuickPresetPicker.tsx) (71 lines):** Fast CRT preset preview dialog with automatic rollback on cancellation.

---

### 4. CRT Pipeline & Adapters (`src/crt/`)

* **[`settings.ts`](../src/crt/settings.ts) (330 lines):** Validates, sanitizes, and clamps CRT configuration parameters (curvature, scanlines, bloom, phosphor persistence, jitter). Exposes resolution presets (`1024x768`, `640x480`, etc.).
* **[`useCRT.ts`](../src/crt/useCRT.ts) (98 lines):** Manages the WebGL rendering loop (`requestAnimationFrame`), canvas resize observer, and coordinates frame capture for thumbnail previews.
* **[`managed-settings.ts`](../src/crt/managed-settings.ts) (76 lines):** Adapter handling preset persistence and migration between local storage and disk.

---

### 5. AI Assistant Integration (`src/ai/`)

* **[`CodexClient.ts`](../src/ai/CodexClient.ts) (210 lines):** JSON-RPC client for the local `codex app-server` process via Tauri IPC; resolves responses and forwards server notifications.
* **[`useCodexAssistant.ts`](../src/ai/useCodexAssistant.ts):** Owns per-session assistant conversations, model selection, event handling, and turn lifecycle; `App.tsx` supplies active-tab context and renders the panel.
* **[`modelSelection.ts`](../src/ai/modelSelection.ts) (43 lines):** Helper logic determining supported model tiers and reasoning effort settings.
* **[`chatMessages.ts`](../src/ai/chatMessages.ts) (25 lines):** Chat history model and delta text aggregator.
* **[`protocol.ts`](../src/ai/protocol.ts) (20 lines):** Type definitions for JSON-RPC payloads and Codex lifecycle events.

---

### 6. Native Rust Backend (`src-tauri/src/`)

* **[`lua_automation.rs`](../src-tauri/src/lua_automation.rs) (3,155 lines prod / 847 tests):** High-performance native worker thread managing Lua automation. Owns thread-safe message queues, layout requests, window positioning, and state snapshots.
* **[`caps_hook.rs`](../src-tauri/src/caps_hook.rs) (1,229 lines prod / 196 tests):** Low-level Windows keyboard hook (`WH_KEYBOARD_LL`). Implements Smart Caps: intercepts CapsLock to distinguish rapid taps (dispatched as Esc) from held presses (modifier/mode switches), issuing temporary policy leases to the frontend.
* **[`main.rs`](../src-tauri/src/main.rs) (1,136 lines prod / 307 tests):** Main entry point. Handles ConPTY process lifecycle (`CreatePseudoConsole`), asynchronous I/O thread pools, DirectWrite font enumeration, and native Windows menus.
* **[`automation_probe.rs`](../src-tauri/src/automation_probe.rs) (918 lines prod / 85 tests):** Debug/testing probe for synthetic keyboard injection and layout event inspection without interfering with user input.
* **[`lua_runtime.rs`](../src-tauri/src/lua_runtime.rs) (610 lines prod / 3,735 tests):** Heavily tested sandboxed Lua runtime (`mlua`). Sets up per-tab isolated VMs, strict instruction and memory budgets, and exposes safe terminal control APIs.
* **[`mcp.rs`](../src-tauri/src/mcp.rs) (520 lines prod / 36 tests):** Named pipe server (`\\.\pipe\scanline-term-mcp[-dev]`) implementing Model Context Protocol for external AI agents.
* **[`presets.rs`](../src-tauri/src/presets.rs) (341 lines prod / 141 tests):** File-system manager for CRT presets with atomic writes and `.bak` backups.
* **[`bin/scanline-term-mcp.rs`](../src-tauri/src/bin/scanline-term-mcp.rs) (301 lines prod / 70 tests):** Standalone stdio MCP CLI adapter bridging AI tools to the named pipe broker.
* **[`home.rs`](../src-tauri/src/home.rs) (277 lines prod / 91 tests):** Manages `%APPDATA%/.../home.json` configuration and bookmarks.
* **[`window_state.rs`](../src-tauri/src/window_state.rs) (271 lines prod / 54 tests):** Saves and restores window size and position with multi-monitor boundary validation.
* **[`browser.rs`](../src-tauri/src/browser.rs) (174 lines prod / 37 tests):** Controls native child WebViews for embedded browser tabs, isolating them from CRT post-processing.
* **[`codex.rs`](../src-tauri/src/codex.rs) (88 lines prod):** Spawns and manages the `codex app-server --stdio` child process tree.
* **[`explorer.rs`](../src-tauri/src/explorer.rs):** Owns per-user Explorer registry verbs and the `set_explorer_integration` Tauri command.

---

## External Engine: Scanline Virtual Screen (`@svs/core`)

The WebGL rendering engine and analog CRT post-processing pipeline are maintained in the separate repository [`Scanline-Virtual-Screen`](https://github.com/z-hunter/Scanline-Virtual-Screen) and pinned by immutable commit.

### Engine Architecture & Key Files

| Module / File | LOC (prod) | Size | Responsibility & Key Exports |
|:---|:---:|:---:|:---|
| **`src/core/CRTFilter.ts`** | **1,793** | 92 KB | **Full WebGL CRT shader pipeline:** multi-pass barrel distortion, scanlines, shadow/slot/aperture grille phosphor masks, Kawase/Gaussian bloom, phosphor persistence decay (`persistenceDecay`), noise, chromatic aberration, and bezel reflection. |
| **`src/terminal/TerminalRenderer.ts`** | **536** | 40 KB | **Offscreen 2D character rasterizer:** reads xterm.js buffer cells, renders monospace glyphs, custom pixel-perfect box-drawing characters, and smooth scroll interpolations into textures. |
| **`src/core/profile.ts`** | **183** | 10 KB | Type contracts and schema definitions for `ScreenProfile`, `CRTVisualSettings`, and `TerminalSettings`. |
| **`src/react/ScreenProfileSections.tsx`** | **173** | 21 KB | React UI controls and collapsible accordions for adjusting CRT parameters. |
| **`src/core/color-profiles.ts`** | **96** | 5 KB | Monochrome phosphor color models (Amber, Green P1, Green P39, Paper White, Blue CRT) and RGB remapping. |
| **`src/react/settingHelp.ts`** | **54** | 5 KB | Human-readable descriptions and help tooltips for every CRT adjustment setting. |
| **`src/presets/builtins.ts`** | **35** | 2 KB | 17 canonical hardware presets: IBM 5151 (MDA), DEC VT-100/220, Commodore 8-bit, Trinitron, Robotron, etc. |

---

## Tauri Commands & IPC Interface

### Commands (Frontend → Rust)

| Command | Parameters | Returns | Called From |
|:---|:---|:---|:---|
| `start_terminal` | `sessionId, cols, rows, launch?` | `String` (executable) | Spawning a terminal tab |
| `initial_terminal_launch` | — | `{ command?, args?, cwd? }` | App startup launch |
| `write_terminal` | `sessionId, input` | `Result<(), String>` | Sending user keystrokes / input |
| `resize_terminal` | `sessionId, cols, rows` | `Result<(), String>` | Window or panel dimension resize |
| `active_terminal_process` | `sessionId` | `Option<String>` | Foreground child process detection |
| `close_terminal` | `sessionId` | `Result<(), String>` | Closing a tab / killing ConPTY process |
| `list_monospace_fonts` | — | `Vec<String>` | Enumerating installed monospace fonts |
| `list_available_shells` | — | `{ name, command }[]` | Populating shell selector |
| `set_global_hotkey_enabled`| `enabled, slideFromTop` | `Result<(), String>` | Registering `Win+~` hotkey |
| `set_explorer_integration` | `enabled` | `Result<(), String>` | Windows Explorer context menu verbs |
| `load_managed_settings` | — | Managed settings bundle | Loading Lua config & presets |
| `save_managed_settings` | `settings, revision` | Managed settings bundle | Persisting GUI-managed settings |
| `restore_window_state` | — | `boolean` | Restoring saved window geometry |
| `load_home_config` | — | `{ path, config }` | Reading bookmarks for home tab |
| `save_home_config` | `config` | `{ path, config }` | Saving bookmarks for home tab |
| `codex_start` | — | `{ generation, version }` | Launching Codex app-server |
| `codex_send` | `generation, rpc` | `Result<(), String>` | Forwarding JSON-RPC message to Codex |
| `codex_stop` | `generation` | `Result<(), String>` | Stopping Codex process tree |
| `mcp_set_enabled` | `enabled` | `Result<(), String>` | Toggling MCP Named Pipe server |
| `mcp_respond` | `requestId, result, error?`| `Result<(), String>` | Answering external MCP tool requests |

### Events (Rust → Frontend)

| Event | Payload | Listener | Description |
|:---|:---|:---|:---|
| `terminal-output` | `{ sessionId, data: Vec<u8> }` | `TerminalSession` | Raw PTY output stream chunks |
| `terminal-exit` | `{ sessionId }` | `useTerminal` | Process exit notification |
| `terminal-launch` | `{ command?, args?, cwd? }` | `App.tsx` | Second CLI instance launch request |
| `browser-title` | `{ sessionId, title }` | `useTerminal` | Document title change from child WebView |
| `browser-color` | `{ sessionId, background }`| `useTerminal` | Background color change from child WebView |
| `browser-shortcut` | `{ sessionId, code, shiftKey }`| `App.tsx` | Forwarded shortcut from child WebView |
| `lua-preset-request`| `{ frontendId, tabId, name }` | `useManagedSettings` | Requested preset change from Lua script |
| `codex-message` | `{ generation, message }` | `CodexClient` | Incoming JSON-RPC response from Codex |
| `codex-exit` | `{ generation, text }` | `CodexClient` | Unexpected termination of Codex server |
| `mcp-request` | `{ requestId, ownerId, method, params }` | `terminal-automation` | Inbound tool call from external MCP client |
| `mcp-owner-disconnected` | `{ ownerId }` | `useTerminal` | Closes terminal sessions tied to disconnected pipe |

---

*[Next: Core Systems →](./04-core-systems.md)*
