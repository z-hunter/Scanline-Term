# 6 · Development Workflow

[← Design Decisions](./05-design-decisions.md) · [Index](./README.md) · [Testing →](./07-testing.md)

---

## Prerequisites

| Requirement | Purpose | Install |
|-------------|---------|---------|
| **Node.js** (LTS) | Frontend build, dev server, tests | [nodejs.org](https://nodejs.org) |
| **Rust** (stable, MSVC toolchain) | Tauri backend compilation | `rustup` with `stable-x86_64-pc-windows-msvc` |
| **Microsoft C++ Build Tools** | MSVC linker and Windows SDK | Visual Studio Build Tools or full VS |
| **WebView2 Runtime** | Tauri 2 rendering engine | Pre-installed on Windows 10/11; [download](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |
| **ConPTY DLLs** | Bundled in `src-tauri/resources/conpty/x64/` | Included in repository |

### Windows-Specific Notes

- The project **only builds and runs on Windows**. The Rust backend uses `windows-sys` for GDI font enumeration and `conpty-oxide` for the pseudo-console.
- The `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` attribute in `main.rs` hides the console window in release builds.
- Ensure the MSVC toolchain is active: `rustup default stable-msvc`.

---

## Commands

### Install Dependencies

```sh
npm install
```

### Frontend Development (Browser Preview)

```sh
npm run dev
```

Starts Vite dev server at `http://localhost:5173`. Shows the mock terminal with CRT filter. No ConPTY, no real console — useful for shader/UI work.

### Full Tauri Development

```sh
npm run tauri:dev
```

Starts Vite dev server + compiles Rust backend + opens Tauri window with live ConPTY session. Hot-reloads frontend changes; Rust changes require restart.

### Run Tests

```sh
# Frontend tests (Vitest + happy-dom)
npm test

# Rust tests (ConPTY integration tests require Windows)
cd src-tauri && cargo test
```

### Lint

```sh
npm run lint
```

Runs ESLint with the flat config (`eslint.config.js`). Includes TypeScript, React hooks, and React refresh rules.

### Production Build

```sh
# Frontend only
npm run build

# Full Tauri build (NSIS installer)
npm run tauri:build
```

The Tauri build produces an NSIS installer in `src-tauri/target/release/bundle/nsis/`.

### Preview Production Frontend

```sh
npm run preview
```

Serves the built `dist/` directory via Vite preview server.

---

## Development Reload Behavior

| Change Type | Reload Behavior |
|-------------|----------------|
| TypeScript / TSX / CSS | Vite HMR — instant in both `npm run dev` and `npm run tauri:dev` |
| Rust (`main.rs`) | Requires `npm run tauri:dev` restart (Tauri dev watches Rust and auto-rebuilds, but the ConPTY session restarts) |
| `tauri.conf.json` | Requires `npm run tauri:dev` restart |
| `capabilities/default.json` | Requires `npm run tauri:dev` restart |
| GLSL shaders (inline in `CRTFilter.ts`) | Vite HMR — the TypeScript file change triggers reload |
| `package.json` scripts/deps | Requires `npm install` and restart |

---

## Configuration and Permissions

### Tauri Capabilities

The [`capabilities/default.json`](../src-tauri/capabilities/default.json) grants minimal permissions:

```json
{
  "permissions": [
    "core:event:allow-listen",
    "core:window:allow-is-fullscreen",
    "core:window:allow-set-fullscreen"
  ]
}
```

- **`core:event:allow-listen`**: Required for `terminal-output` and `terminal-exit` events. Without this, the frontend cannot receive ConPTY output.
- **`core:window:allow-is-fullscreen`** / **`core:window:allow-set-fullscreen`**: Required for Alt+Enter fullscreen toggle.

> **Important:** If you add a new Tauri event that the frontend needs to `listen()` to, no additional capability is needed — `core:event:allow-listen` is a blanket permission for all event listening. However, if you add an `invoke()` command, no additional capability is typically needed for commands (Tauri 2 allows commands by default unless explicitly restricted).

### Content Security Policy

```
default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'
```

- `'unsafe-inline'` for styles: Required because React and the settings panel use inline styles (e.g., the knob's `--knob-progress` CSS custom property).
- No `'unsafe-eval'` — no dynamic code execution.
- No external resources — all assets are bundled.

### localStorage

Settings are stored under key `scanline-term.settings.v1` as a JSON object. The `loadStoredSettings()` function validates all values and falls back to defaults on any error, so corrupt localStorage never prevents the application from starting.

---

## Common Build and Runtime Failures

### Rust Build Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `error[E0463]: can't find crate for 'std'` | Missing MSVC toolchain | `rustup default stable-msvc` |
| `error: failed to run custom build command for 'tauri-build'` | Missing Tauri CLI or WebView2 | `npm install`, install WebView2 Runtime |
| `LINK : fatal error LNK1181: cannot open input file 'windows.0.61.2.lib'` | Missing Windows SDK | Install Visual Studio Build Tools with "Desktop development with C++" workload |
| ConPTY DLLs not found at runtime | `resources/conpty/x64/` missing or empty | Ensure ConPTY DLLs are present in that directory |

### Frontend Build Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Module not found: @xterm/xterm` | Missing npm dependencies | `npm install` |
| TypeScript errors in `CRTFilter.ts` | TS strict mode, `useDefineForClassFields` | These are expected to compile correctly; check `tsconfig.app.json` |
| Vite HMR not working | Port 5173 in use | Kill other Vite instances or change port |

### Runtime Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Windows console could not start" error | ConPTY spawn failure, missing `cmd.exe`, wrong DLL path | Check `%ComSpec%`, verify ConPTY DLLs exist |
| Black canvas, no CRT effect | WebGL not available in WebView | Check WebView2 GPU acceleration settings |
| Console starts but no output | `terminal-output` event not received | Check `capabilities/default.json` includes `core:event:allow-listen` |
| "WebGL is unavailable in this WebView" | GPU driver issue or software rendering | Update GPU drivers, check `edge://gpu` in WebView2 |

---

*[Next: Testing →](./07-testing.md)*
