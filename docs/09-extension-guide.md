# 9 · Extension Guide

[← Troubleshooting](./08-troubleshooting.md) · [Index](./README.md) · [Agent Guide →](./AGENT_GUIDE.md)

---

## Adding a Color Profile

Color profiles are shared display data. Add them in the [SVS repository](https://github.com/z-hunter/Scanline-Virtual-Screen), run its tests and release an immutable tag, then update the Scanline Term dependency. Validate the selected profile through Scanline Term's settings tests and `tauri:dev`.

---

## Extending Scanline Virtual Screen

CRT settings, shaders, profiles, rendering passes and the shared React sections belong to [Scanline Virtual Screen](https://github.com/z-hunter/Scanline-Virtual-Screen). Follow its [contribution guide](https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/CONTRIBUTING.md) and release process, publish an immutable tag, then update the Scanline Term dependency according to [Scanline Virtual Screen Integration](./12-scanline-virtual-screen.md).


## Adding a Keyboard Shortcut

### Files to Modify

- **App-level shortcut (like Menu+S):** [`src/terminal/useTerminal.ts`](../src/terminal/useTerminal.ts) — `down` handler in `useTerminal`
- **Terminal-level key (VT mode):** [`src/terminal/terminal-input.ts`](../src/terminal/terminal-input.ts)
- **Terminal-level key (Win32 mode):** [`src/win32-input.ts`](../src/win32-input.ts)

### Steps (App-Level Shortcut)

1. Add detection in the `onKeyDown` function inside the keyboard effect:
   ```typescript
   if (menuKeyDownRef.current && event.code === 'KeyX') {
     event.preventDefault();
     event.stopPropagation();
     if (!event.repeat) { /* your action */ }
     return;
   }
   ```

2. The shortcut must be checked **before** the terminal input encoding at the bottom of `onKeyDown`.

### Validation

- [ ] Shortcut works with Menu key held
- [ ] Shortcut doesn't interfere with terminal input (doesn't leak to ConPTY)
- [ ] `event.repeat` is checked to prevent rapid re-triggering
- [ ] `event.preventDefault()` and `event.stopPropagation()` are called

### Terminal Buffer Search

Terminal search is split across three frontend responsibilities:

- [`src/terminal/terminal-search.ts`](../src/terminal/terminal-search.ts) performs literal smart-case matching and returns physical line/cell ranges. Normal-buffer searches include scrollback; alternate-buffer searches use only the current viewport.
- [`src/terminal/useTerminal.ts`](../src/terminal/useTerminal.ts) owns transient query state, Menu+/ interception, cyclic navigation, scroll-to-match, and terminal-input suppression while search is open.
- [`src/terminal/ScanlineTerminalRenderer.ts`](../src/terminal/ScanlineTerminalRenderer.ts) supplies the terminal source to SVS; [`src/App.tsx`](../src/App.tsx) renders the compact DOM input above the display canvas.

When extending search, preserve the distinction between absolute buffer line coordinates and viewport row coordinates. Keep the query overlay out of the canvas so it remains readable with CRT curvature, scanlines, and persistence enabled.

---

## Adding a Native Command / Event

### Files to Modify

1. **[`src-tauri/src/main.rs`](../src-tauri/src/main.rs)** — Add `#[tauri::command]` function
2. **[`src-tauri/src/main.rs`](../src-tauri/src/main.rs)** — Register in `generate_handler![]` in `main()`
3. **[`src/App.tsx`](../src/App.tsx)** — Call via `invoke('command_name', { params })`

### Steps (New Command)

```rust
#[tauri::command]
fn my_command(state: State<TerminalState>, param: String) -> Result<String, String> {
    // Implementation
    Ok("result".into())
}

// In main():
.invoke_handler(tauri::generate_handler![
    start_terminal, write_terminal, resize_terminal,
    list_monospace_fonts, my_command
])
```

### Steps (New Event — Rust → Frontend)

```rust
// In Rust:
let _ = app.emit("my-event", payload);

// In frontend:
const unlisten = await listen<PayloadType>('my-event', (event) => {
    // handle event.payload
});
```

### Capability Requirements

- **Commands**: No additional capability needed (Tauri 2 allows all commands by default).
- **Events**: `core:event:allow-listen` is already granted — covers all events.
- **New window operations**: May require additional `core:window:allow-*` permissions in `capabilities/default.json`.
- **Native popup menus**: Use `@tauri-apps/api/menu`; grant `core:menu:allow-new` and `core:menu:allow-popup` in `capabilities/default.json`. Prefer a shared builder when the same actions are available from multiple surfaces.

### Validation

- [ ] `cargo test` passes
- [ ] Command/event works in `tauri:dev`
- [ ] Error cases return meaningful error strings
- [ ] Resources are cleaned up (no leaks on repeated calls)

---

## Adding a Font-Related Setting

### Files to Modify

1. **SVS terminal/profile API** — Add the shared setting and validation in the SVS repository.
2. **[`src/crt/settings.ts`](../src/crt/settings.ts)** — Keep only Scanline Term persistence adapters current.
3. **[`src/terminal/useTerminal.ts`](../src/terminal/useTerminal.ts)** — Update host resize behavior if the setting changes cell geometry.

### Key Considerations

- Font changes trigger terminal resize: the `useEffect` at line 370 watches `stored.crt.consoleFont` and `stored.crt.consoleFontSize`.
- `fontCellSize()` measures the 'M' character — ensure new fonts are monospace.
- `canvasFont()` builds the CSS font string with fallbacks: `"${family}", Consolas, "Courier New", monospace`.
- `list_monospace_fonts` in Rust filters by GDI `TMPF_FIXED_PITCH`.

### Validation

- [ ] Font appears in the dropdown (if it's a system font)
- [ ] Terminal grid recalculates on font change
- [ ] Characters render correctly (no overlap, no clipping)
- [ ] `invoke('resize_terminal')` is called with correct dimensions

---

## Adding a System Menu Action

### Files to Modify

1. **[`src/App.tsx`](../src/App.tsx)** — `onKeyDown` handler for Menu+key shortcut
2. Optionally: [`src-tauri/src/main.rs`](../src-tauri/src/main.rs) — if the action requires native functionality

### Pattern

System menu actions follow the Menu-key chord pattern:

```typescript
if (menuKeyDownRef.current && event.code === 'KeyX') {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
        // Action
    }
    return;
}
```

### Existing Menu Actions

| Chord | Action | Handler |
|-------|--------|---------|
| Menu+S | Toggle settings panel | `setSettingsVisible()` |
| Menu+A | Toggle AI assistant panel | `onToggleAi()` |
| Menu+' | Toggle terminal/AI focus | `focus()` |
| Menu+V | Paste from clipboard | `navigator.clipboard.readText()` → `sendInput()` |
| Menu+C | Enter copy mode | `copyModeRef.current = true` |
| Menu+/ | Open terminal-buffer search | `openSearch()` |
| Menu+Shift+/ | Open reverse terminal-buffer search | `openSearch(-1)` |
| Menu+N | Create a new terminal tab | `openSession()` |
| Menu+1…9 | Select a numbered terminal tab | `selectSession()` |
| Menu+→ / Menu+> | Select next tab | `selectSession()` |
| Menu+← / Menu+< | Select previous tab | `selectSession()` |
| Menu+Tab | Toggle previous active tab | `selectSession()` |

### Validation

- [ ] Shortcut fires once on press (not on repeat)
- [ ] Shortcut doesn't reach the terminal
- [ ] Action is reversible or safe
- [ ] Works with keyboard layouts that have a Menu key

---

*[Next: Agent Guide →](./AGENT_GUIDE.md)*
