# 12 · Scanline Virtual Screen Integration

[← Codex Terminal Assistant](./10-ai-assistant.md) · [Index](./README.md)

Scanline Term consumes [Scanline Virtual Screen (SVS)](https://github.com/z-hunter/Scanline-Virtual-Screen), the public source-available module that owns the display profile contract, virtual-pixel composition, CRT/pass-through rendering, optional xterm canvas adapter and controlled React sections.

The SVS repository is the technical source of truth for its architecture, public API, profile schema, rendering lifecycle and licensing:

- [SVS README](https://github.com/z-hunter/Scanline-Virtual-Screen#readme)
- [SVS architecture](https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/docs/architecture.md)
- [SVS public API](https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/docs/api.md)
- [SVS host integration](https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/docs/integration.md)
- [SVS development and releases](https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/docs/development.md)

## Dependency

`package.json` pins SVS v2.1.9 to immutable commit `8f7fc6558389385ba78f866911d4a9d2775f53f9`. Do not replace it with a branch name or a mutable tag during normal application work.

```json
"scanline-virtual-screen": "https://codeload.github.com/z-hunter/Scanline-Virtual-Screen/tar.gz/8f7fc6558389385ba78f866911d4a9d2775f53f9"
```

`npm ci` installs the exact package commit recorded in `package-lock.json`. The public repository no longer needs contributor SSH access merely to install the dependency.

Both Vite development and production builds resolve this installed package. Development does not implicitly alias an adjacent SVS checkout, which can leave the app importing APIs missing from an older sibling build. For temporary SVS integration work, install the local package explicitly as described below.

## Scanline Term responsibilities

Scanline Term deliberately keeps application-specific state outside SVS:

- ConPTY, shell processes, tabs, native menus and Tauri commands;
- terminal image loading, object URLs, drag/scale/delete interaction and tab-local image state;
- profile storage, preset files, dirty state and confirmation dialogs;
- loading the validated Lua ANSI palette snapshot from the native runtime and registering it with SVS before presets are normalized; saved presets keep stable `lua:<name>` references, including when a palette is missing;
- TUI scroll detection and diagnostics in `src/terminal/terminal-scroll-heuristic.ts`; ordinary scroll paths call `beginBufferScroll()`, detected host regions call `beginRegionScroll()`;
- the branded browser-preview mock and its `/icon.png` splash logo;
- the temporary Gallery renderer, which uses bounded per-tab xterm adapters and one WebGL compositor with an asynchronous CRT shader-mask cache to render terminal thumbnails sequentially; logical source dimensions are capped at 2.1 megapixels and thumbnail rasters scale from 384 to 960 pixels on the long edge with the global 80–200% card size (480 pixels at 100%). Larger cards use more preview memory and rendering work. Previews disable persistence and breathing. Cached frames appear immediately and stay visible until a successful live paint; cards without a cache show a placeholder. The scheduler tolerates one cold preparation and the first capture exceeding 50 ms per Gallery visit, adapts its 100–500 ms interval when captures exceed 16 ms, and stops on repeated slow preparation, later captures over 50 ms, shader timeout, repeated foreground RAF lag, resource caps, context loss, or render errors. These are post-hoc JavaScript timing gates, not a preemptive GPU limit;
- `requestAnimationFrame`, `ResizeObserver`, screen resize, tab switching and error UI.

[`src/terminal/ScanlineTerminalRenderer.ts`](../src/terminal/ScanlineTerminalRenderer.ts) wraps the optional SVS xterm adapter and converts Scanline Term's normalized image state into SVS overlays. The browser CRT experiment adds its latest WebView2 JPEG frame as a full-screen runtime overlay through this same boundary. [`src/crt/useCRT.ts`](../src/crt/useCRT.ts) is the host-side rendering lifecycle adapter. Do not put any of the host responsibilities above into SVS.

For pointer mapping, `useCRT.ts` copies `VirtualScreenRenderer.rasterScale` to the terminal renderer after each rendered frame and capture. SVS exposes the centered scale used after bezel inset and curvature; `sourcePointAt()` and `cellAtPoint()` share it, so browser overlay points and terminal cells follow the visible raster. The scale uses the cached global GPU luma readback from the preceding source frame. That 1×1 synchronous readback is deferred to the next render and is skipped while CRT emulation or breathing is off. It can wait for queued GPU work, so measure performance on the target machine under continuous source updates.

SVS owns the custom palette registry and groups Lua palettes after built-ins in its controlled settings section. Scanline Term applies the full native snapshot before loading saved presets. A successful Lua reload applies the prepared candidate snapshot only after commit; failed loads retain the last good catalog. Missing `lua:` references remain saved, render with SVS's built-in fallback, and produce a warning. Catalog changes refresh the theme and tab colors of every live session without changing preset names or dirty state.

`src/ui/SettingsPanel.tsx` composes SVS's controlled `DisplaySettingsSection`, `TerminalSettingsSection`, and `AdvancedCRTSettingsSection`, plus `scanline-virtual-screen/react/styles.css`. Scanline Term provides its mode list, installed fonts, current `ScreenProfile`, and the host-owned smooth-scrolling callbacks; preset persistence, diagnostics, UI, and system controls stay local.

SVS owns the cursor profile defaults (style, brightness, and blink flag) and renders the current xterm cursor options first. Scanline Term maps an application's DECSCUSR sequence to those transient xterm options; the profile remains the reset fallback.

`pixelSmoothing` controls only source-texture sampling. `antiAliasedPixels` is an independent WebGL output resolve for virtual-pixel and CRT-raster conflicts, and applies with CRT enabled or disabled. The Canvas 2D fallback supports source smoothing only.

Terminal search remains a Scanline Term feature. The host searches its xterm buffer and passes the resulting ranges to SVS `TerminalRenderer.setTextHighlights()`; SVS does not know about queries, navigation or search state. The JSON files under `src-tauri/resources/presets` are a deliberate Tauri packaging mirror of the built-in SVS presets.

## Updating SVS

1. Make and validate the change in the SVS repository: `npm test`, `npm run build`, `npm run lint`, then package inspection.
2. Push the verified SVS commit.
3. Update the immutable dependency URL with `npm install https://codeload.github.com/z-hunter/Scanline-Virtual-Screen/tar.gz/<commit>`.
4. Commit the resulting `package.json` and `package-lock.json` changes.
5. Run `npm test`, `npm run build`, `npm run lint`, then the SVS-related `npm run tauri:dev` matrix: profiles/mode fallback, overlays, CRT on/off, resize, tab switching and disposal.

## Concurrent local development

Keep both repositories adjacent:

```text
C:\Dev.dir\projects.dat\
├── ScanlineTerm
└── Scanline-Virtual-Screen
```

For short-lived integration work, install the package directory without committing that local dependency:

```powershell
cd C:\Dev.dir\projects.dat\ScanlineTerm
npm install --no-save file:..\Scanline-Virtual-Screen
```

Build SVS after changing it, validate Scanline Term against that build, then restore the immutable commit dependency before committing Scanline Term.

## Licensing

SVS is public under PolyForm Noncommercial 1.0.0. Commercial use needs a separate written license from its copyright holders. Scanline Term contributors must preserve SVS notices and must not assume the SVS license grants commercial redistribution rights.
