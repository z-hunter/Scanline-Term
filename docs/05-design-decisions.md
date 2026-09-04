# 5 · Design Decisions and Rationale

[← Core Systems](./04-core-systems.md) · [Index](./README.md) · [Development →](./06-development.md)

---

## Why xterm Is Used as a Parser, Not a Renderer

**Decision:** `@xterm/xterm` is used as a headless VT state machine. It is never attached to the DOM. All rendering is done via custom Canvas 2D + WebGL.

**Rationale:**
- The CRT pipeline requires a pixel-level source image. xterm's built-in canvas/DOM renderers produce their own styled output that cannot be fed into a fragment shader pipeline.
- By keeping xterm headless, the project gets a battle-tested VT100/VT220/xterm parser (cursor movement, alternate screen, scrollback, 256/RGB color, mouse modes, application keypad mode, etc.) without being constrained by xterm's rendering pipeline.
- The custom `drawTerminal()` reads xterm's buffer cells and color attributes directly, then applies the active color profile and draws to the virtual-resolution source canvas.
- This separation means new text attributes (bold, underline, strikethrough — listed in [BACKLOG.md](../BACKLOG.md)) only need `drawTerminal()` changes, not xterm renderer patches.

---

## Why Input Is Queued (mpsc Channel)

**Decision:** Terminal input flows through an `mpsc::channel<Vec<u8>>` to a dedicated writer thread, rather than writing directly to the ConPTY pipe from the Tauri command handler.

**Rationale:**
- The `write_terminal` Tauri command runs on the main Tauri thread. Pipe writes can block (e.g., if the ConPTY input buffer is full).
- Using a channel makes `write_terminal` non-blocking from the caller's perspective: `sender.send(bytes)` returns immediately.
- The writer thread blocks on `recv()`, writes, and flushes. If the pipe errors, the thread exits cleanly.
- This prevents input lag from backing up the Tauri event loop.

---

## Why Console Output Redraws Are Dirty-Driven

**Decision:** The `requestAnimationFrame` loop only calls `drawTerminal()` when `sourceDirty === true`.

**Rationale:**
- The terminal output changes infrequently compared to the 60fps render loop. Most frames only need to update the CRT shader (time-varying effects like persistence decay, breathing, cursor blink, phosphor noise).
- `drawTerminal()` iterates every cell in the terminal grid and performs Canvas 2D `fillText()` calls, which is expensive.
- The `sourceDirty` flag is set by xterm's `onWriteParsed` and `onScroll` hooks — only when actual content changes.
- Additional dirty triggers: cursor blink phase change, settings changes (font, profile), selection changes, and source canvas resize.
- The CRT shader's `render(source, settings, sourceChanged)` parameter propagates the dirty flag to skip unnecessary texture re-uploads when only shader uniforms change.

---

## Why Color Profiles Can Have More Than 16 Colors

**Decision:** The `xterm-x11` profile contains 256 colors (16 named + 216 cube + 24 grayscale), matching xterm's full 256-color table. Other profiles define only 16 colors but fall back to the xterm extended cube for indices 16–255.

**Rationale:**
- Many console applications use ANSI 256-color escape sequences (e.g., `\x1b[38;5;196m` for bright red at index 196).
- The 16-color portion of each profile defines the character and personality of that color scheme (DOS VGA brown vs Windows Campbell yellow, etc.).
- For indices 16–255, most profiles don't need custom values — the standard xterm 6×6×6 color cube and grayscale ramp are universally expected.
- `profileColor()` implements this fallback: `profile.colors[index] ?? xtermExtended[index - 16]`.
- The `xtermCube()` function pre-computes the 240 extended colors once at module load.

---

## Why `remapLegacyRgb` Exists

**Decision:** When a terminal cell contains an RGB color that exactly matches a Windows Legacy palette entry, it's remapped to the active profile's corresponding palette color.

**Rationale:**
- Windows console applications (e.g., PowerShell, cmd.exe prompt colors) often emit colors as explicit RGB values that happen to be the Windows Legacy palette (e.g., `#000080` for dark blue).
- Without remapping, switching to a DOS VGA or Solarized profile would show Windows Legacy blues mixed with the profile's own blue — a visual mismatch.
- `remapLegacyRgb()` detects these "legacy-shaped" RGB values and translates them through the active profile, so `#000080` becomes `#0000aa` (DOS VGA) or `#268bd2` (Solarized).
- Non-matching RGB values pass through unchanged, preserving true 24-bit color from applications that deliberately choose specific RGB values.

---

## Why Selections Are Rendered Manually

**Decision:** Text selection highlighting is implemented in `drawTerminal()` as a semi-transparent overlay, not via xterm's built-in DOM selection or any browser selection API.

**Rationale:**
- xterm is never attached to the DOM, so its built-in selection addon cannot function.
- The terminal content is rendered to an offscreen canvas, which is then processed by the CRT shader and displayed on a different (WebGL) canvas. Browser text selection cannot work across this pipeline.
- The custom selection draws directly in the source canvas's coordinate space, ensuring it is correctly processed by the CRT curvature and post-processing.

**Known caveats:**
- The `copyPoint()` function contains hardcoded offsets (`cell.row - 2`, `cell.col - 3`) that compensate for coordinate mapping discrepancies. These may need recalibration if padding, font metrics, or cell size calculations change.
- `cellAtPoint()` must stay synchronized with the shader's `curve()` formula so selection and terminal mouse input continue to map the curved display back to source-canvas coordinates.

---

## Why the CRT Module Is Framework-Free

**Decision:** `CRTFilter.ts` is a plain ES class with no React, no framework imports, and no DOM dependencies beyond the `HTMLCanvasElement` and `WebGLRenderingContext` it receives.

**Rationale:**
- The module originated in the Quest/Scanline game engine and is maintained as an independent, portable module.
- It can be integrated into any WebGL context — game engine, standalone demo, React app, or other framework.
- The `render()` method takes a `HTMLCanvasElement` source and a `CRTSettings` object — no coupling to React state, hooks, or lifecycle.

---

## Why the Bundled ConPTY DLLs

**Decision:** ConPTY DLLs are shipped in `src-tauri/resources/conpty/x64/` and resolved via `bundled_conpty_dir()`, rather than using the system's built-in ConPTY.

**Rationale (needs verification):**
- The bundled version likely supports specific features (Win32 Input Mode `?9001h`) that may not be available in older Windows builds.
- The `conpty-oxide` crate's `ConPtyBackend::from_dir()` API loads DLLs from a specified directory, enabling this override.
- This ensures consistent behavior regardless of the Windows version's built-in ConPTY capabilities.

> ⚠️ **Needs verification:** The exact ConPTY version bundled and the specific features it provides versus the system default should be confirmed by examining the DLL files in `resources/conpty/x64/`.

---

*[Next: Development →](./06-development.md)*
