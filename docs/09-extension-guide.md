# 9 · Extension Guide

[← Troubleshooting](./08-troubleshooting.md) · [Index](./README.md) · [Agent Guide →](./AGENT_GUIDE.md)

---

## Adding a Color Profile

Color profiles are shared display data. Add them in the [SVS repository](https://github.com/z-hunter/Scanline-Virtual-Screen), run its tests and release an immutable tag, then update the Scanline Term dependency. Validate the selected profile through Scanline Term's settings tests and `tauri:dev`.

---

## Extending Scanline Virtual Screen

CRT settings, shaders, profiles, rendering passes and the shared React sections belong to [Scanline Virtual Screen](https://github.com/z-hunter/Scanline-Virtual-Screen). Follow its [contribution guide](https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/CONTRIBUTING.md) and release process, publish an immutable tag, then update the Scanline Term dependency according to [Scanline Virtual Screen Integration](./12-scanline-virtual-screen.md).


## Adding a Keyboard Shortcut

### Direct bindings vs. term-prefixed bindings

A command can use a direct combination such as `Alt+Enter`, or a combination such as `term+S` that uses the shared `term` modifier. The starter configuration maps `term` to `Menu`; changing `term` changes every binding that uses it. Both forms resolve through the same command catalog and action handler: a direct binding does not require a separate `onKeyDown` check.

The built-in bindings are in [`src/terminal/keymap.ts`](../src/terminal/keymap.ts). A Lua `sterm.keymap` declaration replaces the alternatives for each named command; other commands keep their defaults. Use `false` to disable a command's shortcuts. See the [Lua keyboard shortcut guide](./lua-automation.md#keyboard-shortcuts) for syntax and reload instructions.

### Adding a new command

1. Add a stable command ID and its default binding to [`src/terminal/keymap.ts`](../src/terminal/keymap.ts), and update [`examples/lua/keymap.lua`](../examples/lua/keymap.lua) and the Lua guide.
2. Handle the command at the existing owner of the action. Place its handler before terminal input encoding, and prevent the consumed event from reaching the terminal. Both frontend keyboard events and native browser commands reach the same action owner.
3. Check the native browser binding conversion and [`browser_keymap.rs`](../src-tauri/src/browser_keymap.rs) when the command must work in native browser tabs. System-wide shortcuts also use [`global-hotkeys.ts`](../src/terminal/global-hotkeys.ts) and [`main.rs`](../src-tauri/src/main.rs).
4. For terminal input encoding rather than an application command, update [`terminal-input.ts`](../src/terminal/terminal-input.ts) for VT mode or [`win32-input.ts`](../src/win32-input.ts) for Win32 mode.

```typescript
if (commandForEvent(event) === 'my.command') {
  event.preventDefault();
  if (!event.repeat) runAction();
  return;
}
```

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

## Gallery card size

The global **Gallery card size** knob in UI settings uses integer percentages from 80% to 200%, defaults to 100%, and applies evenly to terminal and browser cards. It is stored in `StoredSettings` and the Lua GUI-managed settings block as `gallery_card_size`; omitted Lua values use the 100% application default. Preview raster size follows the selected percentage, from 384px to 960px on the long edge. Larger cards use more rendering work; the existing adaptive refresh backs off when captures slow down and stops live updates after severe stalls.

---

## Windows Explorer integration

The System setting `Windows Explorer: Open with ScanlineTerm here` is persisted in `StoredSettings`. The native `set_explorer_integration` command owns the matching per-user registry verbs under `HKCU\\Software\\Classes`, including the `Icon` value sourced from the bundled window icon; keep enable, disable, and the MSI's `ForceDeleteOnUninstall` entries in sync. Commands use `-T -P` for folder objects and folder backgrounds, so the regular CLI and single-instance launch path remain the only terminal-start path.

### Existing Menu Actions

| Chord | Action | Handler |
|-------|--------|---------|
| Menu+S | Toggle settings panel | `setSettingsVisible()` |
| Menu+Z | Toggle tab-bar visibility | `setStored()` |
| Menu+- / Menu++ | Decrease / increase terminal font size by one point | `updateActivePreset()` |
| Menu+P | Open quick preset picker | `QuickPresetPicker` |
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
