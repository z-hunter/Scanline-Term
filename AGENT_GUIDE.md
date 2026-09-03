# Agent Guide — Scanline Term

[← Extension Guide](./docs/09-extension-guide.md) · [Documentation Index](./docs/README.md)

---

> This document is for coding agents (AI assistants) working on the Scanline Term codebase.
> It describes how to safely inspect, modify, and validate changes.

---

## Before Editing: Inspection Checklist

1. **Read the relevant module documentation** in [`docs/`](./docs/README.md) before editing any file.
2. **Understand the execution boundary:** Is the code you're editing WebView-side (TypeScript) or Rust-side? See [Architecture](./docs/02-architecture.md).
3. **Check for related tests:** Most modules have a `.test.ts` file alongside them. Run `npm test` to verify current state.
4. **Check for downstream consumers:** Use grep for the function/type/export name across the entire `src/` tree.
5. **Read the `CRTSettings` interface** before adding or modifying any CRT parameter — it's the shared contract between `CRTFilter.ts`, `settings.ts`, and `App.tsx`.

---

## High-Risk Files

These files are complex, tightly coupled, and easy to break:

| File | Risk | Why |
|------|------|-----|
| **`src/crt/CRTFilter.ts`** | 🔴 Critical | 1101 lines of WebGL + inline GLSL. Mistakes cause visual corruption, black screens, or WebGL errors. No automated visual tests. |
| **`src/terminal/TerminalSession.ts` / `TerminalRenderer.ts`** | 🔴 Critical | ConPTY/xterm lifecycle and source-canvas rendering; changes affect input, resize and display integrity. |
| **`src-tauri/src/main.rs`** | 🟠 High | ConPTY lifecycle, thread management, process cleanup. Bugs can cause orphaned processes, deadlocks, or data loss. Requires Windows to test. |
| **`src/win32-input.ts`** | 🟠 High | Virtual key code and scan code lookup tables. Errors cause incorrect key delivery to console apps. Hard to test without specific Windows apps. |
| **`src/crt/settings.ts`** | 🟡 Medium | Validation logic; incorrect ranges silently corrupt or reject settings. Well-tested but changes need test updates. |
| **`src/terminal/terminal-input.ts`** | 🟡 Medium | VT encoding tables and modifier math. Well-tested but encoding errors break console interaction. |
| **`src/terminal-color-profiles.ts`** | 🟢 Low | Self-contained palette data. Hard to break without deleting entries. |
| **`src/terminal/terminal-mouse.ts`** | 🟢 Low | Small, well-tested encoder. |

---

## Safe Editing Practices

### Preserve Unrelated Changes

- **Never** reformat or restructure files you're not actively modifying.
- The CRT shader strings in `CRTFilter.ts` use mixed line endings (`\r\n` and `\n`). Do not normalize them unless specifically asked.
- `App.tsx` is composition only; keep terminal, CRT lifecycle and settings UI in their dedicated modules.

### Documentation Maintenance

After completing a task that involves **significant architectural changes**, you **must** update the relevant documentation in `docs/` as a final step — after the code changes are working and validated.

A change is "architecturally significant" if it does any of the following:
- **Moves, renames, splits, or merges source files** (e.g., extracting parts of `App.tsx` into separate modules)
- **Adds, removes, or renames a Tauri command or event**
- **Changes data flow** between WebView and Rust, or between major frontend modules
- **Adds a new rendering pass, shader program, or FBO** to the CRT pipeline
- **Adds a new module or directory** to the project structure
- **Changes concurrency model** (threads, channels, state ownership)

**What to update:**
1. [`docs/03-codebase-guide.md`](./docs/03-codebase-guide.md) — repository tree, file descriptions, public API surface
2. [`docs/02-architecture.md`](./docs/02-architecture.md) — Mermaid diagrams, data flow sequences, execution boundary table
3. [`docs/04-core-systems.md`](./docs/04-core-systems.md) — if core behavior (input, rendering, console) changed
4. This file (`AGENT_GUIDE.md`) — high-risk files table, change impact map, line number references
5. Any other `docs/` page that references moved/renamed code

**Do not** update documentation for trivial changes (bug fixes, style tweaks, value adjustments) unless they contradict existing documentation.

### When Frontend-Only Validation Is Sufficient

You can validate with just `npm test` + `npm run dev` (browser preview) when:
- ✅ Modifying color profiles
- ✅ Modifying settings validation or defaults
- ✅ Modifying CRT shader uniforms (verify visually in browser)
- ✅ Modifying terminal-input or terminal-mouse encoding
- ✅ Modifying CSS/layout
- ✅ Adding/modifying settings panel UI controls

### When Full Tauri Build + Manual Test Is Required

You **must** test with `npm run tauri:dev` on Windows when:
- ❌ Modifying `main.rs` (any Rust change)
- ❌ Modifying `tauri.conf.json` or `capabilities/default.json`
- ❌ Changing how `invoke()` commands are called or their parameters
- ❌ Changing how `listen()` events are handled
- ❌ Modifying keyboard input flow (Menu shortcuts, Alt+Enter, focus behavior)
- ❌ Modifying mouse handling that interacts with ConPTY
- ❌ Modifying clipboard behavior
- ❌ Modifying resize logic (terminalDimensions → invoke resize_terminal)

---

## Avoiding Common Regressions

### Console Compatibility

- **Do not remove or alter the Win32 Input Mode CSI handlers** in `TerminalSession.ts`. These enable FAR Manager, PowerShell, and other Windows console apps.
- **Do not change the `pty_size()` validation ranges** without updating `terminalDimensions()` clamping to match, and vice versa.
- **Do not remove the initial `\r` write** in `start_terminal()` — it triggers the shell prompt.

### Input Latency

- **Do not add `await` before `invoke('write_terminal')`** — it's intentionally fire-and-forget (`void invoke(...)`)
- **Do not add debouncing to keyboard handlers** — terminal input must be delivered immediately.
- **Do not add `requestAnimationFrame` to input handlers** — they must execute synchronously.

### Rendering Integrity

- **Do not change `sourceDirty` semantics** — the dirty flag is the primary performance optimization in the render loop.
- **Do not remove `clearPersistence()` calls** on resize — stale FBO data causes ghost images.
- **Do not change the texture unit assignments** (0=main, 1=trail, 2=bloom, 3=glow) without updating all references.

---

## Change Impact Map

Use this table to identify which files to inspect and test when implementing common feature requests.

| Feature Request | Files to Inspect | Files to Modify | Test Method |
|----------------|-----------------|-----------------|-------------|
| **Add a color profile** | `terminal-color-profiles.ts`, `settings.ts` | `terminal-color-profiles.ts` | `npm test`, visual in dev |
| **Add a CRT effect** | `CRTFilter.ts`, `settings.ts`, `App.tsx` | All three | `npm test`, visual in dev |
| **Add a keyboard shortcut** | `terminal/useTerminal.ts`, `terminal/terminal-input.ts` | `terminal/useTerminal.ts` | `npm test`, `tauri:dev` manual test |
| **Add a Tauri command** | `main.rs`, `App.tsx` | Both | `cargo test`, `tauri:dev` |
| **Change font handling** | `App.tsx` (fontCellSize, terminalDimensions), `main.rs` (list_monospace_fonts) | Varies | `tauri:dev`, resize test |
| **Change console shell** | `main.rs` (start_terminal, %ComSpec%) | `main.rs` | `tauri:dev`, `cargo test` |
| **Add text attributes (bold/underline)** | `App.tsx` (drawTerminal), xterm buffer API | `App.tsx` | Visual in `tauri:dev` |
| **Fix mouse coordinates** | `App.tsx` (terminalMouseCell, copyPoint) | `App.tsx` | `tauri:dev` with TUI app |
| **Add a new resolution** | `settings.ts` (RESOLUTIONS) | `settings.ts` | `npm test`, visual in dev |
| **Change persistence behavior** | `CRTFilter.ts` (accum shader, persistenceDecay), `settings.ts` | Both | `npm test`, visual in dev |
| **Add window chrome / system tray** | `tauri.conf.json`, `main.rs`, `App.tsx` | All | `tauri:dev` |
| **Add multi-tab / split** | `App.tsx`, `terminal/useTerminal.ts`, `main.rs`, settings and styles | Major refactor | `cargo test`, `npm test`, `tauri:dev` |
| **Change CSP** | `tauri.conf.json` | `tauri.conf.json` | `tauri:dev` |
| **Add a new Tauri event** | `main.rs`, `App.tsx` | Both | `tauri:dev` |
| **Change bloom algorithm** | `CRTFilter.ts` (shader + render) | `CRTFilter.ts` | Visual in dev |
| **Fix copy/paste** | `App.tsx` (clipboard handlers) | `App.tsx` | `tauri:dev` manual test |

---

## Quick Reference

```sh
# Run all frontend tests
npm test

# Run Rust tests (Windows only)
cd src-tauri && cargo test

# Start browser-only dev (CRT filter, no console)
npm run dev

# Start full Tauri dev (real console session)
npm run tauri:dev

# Lint
npm run lint

# Build production installer
npm run tauri:build
```

### Key Files Quick Access

- Main component: [`src/App.tsx`](./src/App.tsx)
- CRT shader: [`src/crt/CRTFilter.ts`](./src/crt/CRTFilter.ts)
- Settings: [`src/crt/settings.ts`](./src/crt/settings.ts)
- VT input: [`src/terminal/terminal-input.ts`](./src/terminal/terminal-input.ts)
- Win32 input: [`src/win32-input.ts`](./src/win32-input.ts)
- Mouse: [`src/terminal/terminal-mouse.ts`](./src/terminal/terminal-mouse.ts)
- Color profiles: [`src/terminal-color-profiles.ts`](./src/terminal-color-profiles.ts)
- Rust backend: [`src-tauri/src/main.rs`](./src-tauri/src/main.rs)
- Tauri config: [`src-tauri/tauri.conf.json`](./src-tauri/tauri.conf.json)
- Capabilities: [`src-tauri/capabilities/default.json`](./src-tauri/capabilities/default.json)
