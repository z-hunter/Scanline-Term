# 1 · Project Overview

[← Index](./README.md) · [Architecture →](./02-architecture.md)

---

## Purpose

**Scanline Term** is a Windows desktop terminal emulator that renders a live ConPTY console session through a real-time WebGL CRT post-processing pipeline. It turns an ordinary Windows shell (`cmd.exe` by default) into a visually authentic cathode-ray tube display, complete with curvature, scanlines, phosphor persistence, bloom, chromatic aberration, and multiple phosphor color modes.

The project originated in the **Quest/Scanline** game engine. The [`CRTFilter`](../src/crt/CRTFilter.ts) module was extracted from that engine and is maintained here as an independent, framework-free WebGL class.

## Intended User Experience

- A full-featured Windows console (cmd, PowerShell, SSH, FAR Manager, etc.) presented as a retro CRT monitor.
- A rich settings panel ("CRT display lab") with real-time knobs for every visual parameter.
- Selectable virtual resolutions (QVGA through XGA) or physical-pixel mode.
- Selectable color profiles (DOS VGA, Windows Campbell, Solarized, IBM 3279, Commodore 64, Cyberpunk, etc.) and monochrome phosphor tints (B&W, Green, Amber, Blue).
- Instant startup; a splash image displays while the WebView and ConPTY session initialize.
- In browser/Vite preview mode: an animated mock terminal demonstrates the CRT filter without needing a native build.

## Major Capabilities

| Area | Details |
|------|---------|
| **Terminal backend** | Windows ConPTY via [`conpty-oxide`](https://crates.io/crates/conpty-oxide) crate, bundled ConPTY DLLs |
| **Terminal state** | [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm) v6 — used as a headless VT parser/state machine (no DOM rendering) |
| **Custom rendering** | 2D Canvas character grid → WebGL CRT fragment shader pipeline |
| **CRT effects** | Curvature, vignette, scanlines (Sinc-integrated Fourier beam), beam modulation, chromatic aberration, bloom (soft/spiral), screen glow, phosphor grain, phosphor persistence (ping-pong FBOs), HV breathing, bezel glow, anti-moiré pixels, brightness/contrast, background desaturation |
| **Color system** | 8 terminal color profiles × 5 phosphor color modes, ANSI 16/256/RGB remapping |
| **Input** | VT key encoding, Win32 Input Mode (`?9001h`), function keys F1–F24, numpad application mode, cursor keys, Ctrl/Alt combos, mouse tracking (X10, VT200, drag, any-event, SGR 1006) |
| **Clipboard** | Menu-key+V paste, Menu-key+C copy-mode, middle-button selection, browser `onPaste`, `navigator.clipboard` |
| **Font** | Enumeration of system monospace fonts via Win32 GDI `EnumFontFamiliesExW`, configurable font and size |
| **Settings** | All CRT + console settings persisted in `localStorage` under `scanline-term.settings.v1` with validated loading |
| **Packaging** | Tauri 2 NSIS installer, bundled ConPTY DLLs |

## Supported Platforms

| Platform | Status |
|----------|--------|
| **Windows 10/11 (x64)** | Primary target. Full ConPTY + Win32 font enumeration + bundled console. |
| **Browser (Vite dev server)** | CRT filter demo only. Mock terminal session; no real console I/O. Detected via `isTauri()`. |
| **macOS / Linux** | Not supported. The Rust backend uses Windows-only APIs (ConPTY, `windows-sys` GDI). |

## High-Level Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend framework | React | 19.2 |
| Bundler | Vite | 7.3 |
| Terminal parser | @xterm/xterm | 6.0 |
| Rendering | WebGL 1 (GLSL ES 100) + Canvas 2D | — |
| Desktop shell | Tauri | 2.11 |
| Native backend | Rust (2021 edition) | — |
| PTY library | conpty-oxide | 0.1.2 |
| Win32 font API | windows-sys | 0.61 |
| Tests (frontend) | Vitest + happy-dom | 4.1 |
| Tests (Rust) | `cargo test` | — |
| Lint | ESLint + Prettier | 9.x / 3.3 |
| Package format | NSIS installer | — |

---

*[Next: Architecture →](./02-architecture.md)*
