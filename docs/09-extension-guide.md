# 9 · Extension Guide

[← Troubleshooting](./08-troubleshooting.md) · [Index](./README.md) · [Agent Guide →](./AGENT_GUIDE.md)

---

## Adding a Color Profile

A color profile defines a 16-color (or 256-color) palette for the terminal.

### Files to Modify

1. **[`src/terminal-color-profiles.ts`](../src/terminal-color-profiles.ts)**

### Steps

1. Add the new profile ID to `COLOR_PROFILE_IDS`:
   ```typescript
   export const COLOR_PROFILE_IDS = ['dos-vga', ..., 'cyberpunk', 'my-new-profile'] as const;
   ```

2. Add a profile object to the `profiles` array:
   ```typescript
   {
     id: 'my-new-profile',
     label: 'My New Profile',
     foreground: '#e0e0e0',
     background: '#1a1a2e',
     cursor: '#ff6b6b',  // optional — falls back to foreground
     colors: [
       '#1a1a2e', '#e74856', '#16c60c', '#f9f1a5',
       '#3b78ff', '#b4009e', '#61d6d6', '#cccccc',
       '#767676', '#e74856', '#16c60c', '#f9f1a5',
       '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2',
       // For 256 colors, append xterm extended table
     ],
   },
   ```

3. If the profile should be the new default, update `DEFAULT_COLOR_PROFILE_ID`.

### Validation

- [ ] `npm test` — `terminal-color-profiles.test.ts` passes
- [ ] Add a test case for the new profile's key colors
- [ ] `npm test` — `crt/settings.test.ts` passes (loadStoredSettings accepts the new ID)
- [ ] In `tauri:dev`: select the new profile in the dropdown → colors update
- [ ] Verify 16 ANSI colors look correct in a color test utility
- [ ] Verify `remapLegacyRgb` works correctly for legacy Windows apps

---

## Adding a CRT Setting

### Files to Modify

1. **[`src/crt/CRTFilter.ts`](../src/crt/CRTFilter.ts)** — Add to `CRTSettings` interface, add shader uniform, update `render()`
2. **[`src/crt/settings.ts`](../src/crt/settings.ts)** — Add default, add numeric range, add validation in `loadStoredSettings()`
3. **[`src/App.tsx`](../src/App.tsx)** — Add UI control (knob, checkbox, or select)

### Steps

1. Add the field to `CRTSettings` in `CRTFilter.ts`:
   ```typescript
   myNewSetting: number; // 0.0 to 1.0 (description)
   ```

2. Add a GLSL uniform in the fragment shader and use it.

3. Add the uniform location field and lookup in `init()`.

4. Set the uniform value in `render()`.

5. Add default in `DEFAULT_CRT_SETTINGS` in `settings.ts`:
   ```typescript
   myNewSetting: 0.5,
   ```

6. Add validation range in `numericRanges`:
   ```typescript
   myNewSetting: [0, 1],
   ```

7. Add a UI control in `App.tsx` — add to the appropriate `controls` group or create a new `<fieldset>`.

### For Boolean Settings

- Add to `CRTSettings` as `boolean`
- Add validation in `loadStoredSettings()` alongside other boolean checks
- Add a checkbox in the Display fieldset

### Validation

- [ ] `npm test` — `crt/settings.test.ts` passes (add a test for the new setting)
- [ ] `npm run dev` — verify the control appears and adjusts the visual effect
- [ ] Reset defaults — verify the new setting resets
- [ ] Save and reload — verify persistence via localStorage

---

## Adding a Shader / Rendering Effect

### Files to Modify

1. **[`src/crt/CRTFilter.ts`](../src/crt/CRTFilter.ts)** — Modify GLSL shader source and/or add new pass

### Steps (inline shader modification)

1. Add a `uniform` declaration in the fragment shader source string.
2. Add the uniform location field to the class.
3. Look up the location in `init()`.
4. Set the uniform value in `render()`.
5. Write the GLSL logic in `main()` at the appropriate point in the pipeline.

### Steps (new render pass)

1. Write a new fragment shader as a string in `init()`.
2. Create a new program with `createProgram()`.
3. Create FBOs with `ensureFBO()` or `ensureGlowFBO()` patterns.
4. Add the pass in `render()` between existing passes.
5. Clean up in `dispose()`.

### Validation

- [ ] No WebGL compile errors (check browser console)
- [ ] Effect is visible and controllable
- [ ] CRT Emulation toggle bypass still works (bypass check is at the top of `main()`)
- [ ] Performance acceptable at 60fps (check FPS counter)
- [ ] `dispose()` cleans up all new resources

---

## Adding a Keyboard Shortcut

### Files to Modify

- **App-level shortcut (like Menu+S):** [`src/App.tsx`](../src/App.tsx) — `onKeyDown` handler (lines 601–643)
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

### Validation

- [ ] `cargo test` passes
- [ ] Command/event works in `tauri:dev`
- [ ] Error cases return meaningful error strings
- [ ] Resources are cleaned up (no leaks on repeated calls)

---

## Adding a Font-Related Setting

### Files to Modify

1. **[`src/crt/CRTFilter.ts`](../src/crt/CRTFilter.ts)** — Add to `CRTSettings` if it affects rendering
2. **[`src/crt/settings.ts`](../src/crt/settings.ts)** — Add default, validation
3. **[`src/App.tsx`](../src/App.tsx)** — Add UI control, update `terminalDimensions()` dependency if needed

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
| Menu+V | Paste from clipboard | `navigator.clipboard.readText()` → `sendInput()` |
| Menu+C | Enter copy mode | `copyModeRef.current = true` |

### Validation

- [ ] Shortcut fires once on press (not on repeat)
- [ ] Shortcut doesn't reach the terminal
- [ ] Action is reversible or safe
- [ ] Works with keyboard layouts that have a Menu key

---

*[Next: Agent Guide →](./AGENT_GUIDE.md)*
