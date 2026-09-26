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

`package.json` pins SVS to the immutable `v2.1.0` Git tag. Do not replace it with a branch name or an unpinned commit during normal application work.

```json
"scanline-virtual-screen": "github:z-hunter/Scanline-Virtual-Screen#v2.1.0"
```

`npm ci` installs the exact package commit recorded in `package-lock.json`. The public repository no longer needs contributor SSH access merely to install the dependency.

## Scanline Term responsibilities

Scanline Term deliberately keeps application-specific state outside SVS:

- ConPTY, shell processes, tabs, native menus and Tauri commands;
- terminal image loading, object URLs, drag/scale/delete interaction and tab-local image state;
- profile storage, preset files, dirty state and confirmation dialogs;
- TUI scroll detection and diagnostics in `src/terminal/terminal-scroll-heuristic.ts`; ordinary scroll paths call `beginBufferScroll()`, detected host regions call `beginRegionScroll()`;
- the branded browser-preview mock and its `/icon.png` splash logo;
- `requestAnimationFrame`, `ResizeObserver`, screen resize, tab switching and error UI.

[`src/terminal/ScanlineTerminalRenderer.ts`](../src/terminal/ScanlineTerminalRenderer.ts) wraps the optional SVS xterm adapter and converts Scanline Term's normalized image state into SVS overlays. [`src/crt/useCRT.ts`](../src/crt/useCRT.ts) is the host-side rendering lifecycle adapter. Do not put any of the host responsibilities above into SVS.

`src/ui/SettingsPanel.tsx` composes SVS's controlled `DisplaySettingsSection`, `TerminalSettingsSection`, and `AdvancedCRTSettingsSection`, plus `scanline-virtual-screen/react/styles.css`. Scanline Term provides its mode list, installed fonts, current `ScreenProfile`, and the host-owned smooth-scrolling callbacks; preset persistence, diagnostics, UI, and system controls stay local.

Terminal search remains a Scanline Term feature. The host searches its xterm buffer and passes the resulting ranges to SVS `TerminalRenderer.setTextHighlights()`; SVS does not know about queries, navigation or search state. The JSON files under `src-tauri/resources/presets` are a deliberate Tauri packaging mirror of the built-in SVS presets.

## Updating SVS

1. Make and validate the change in the SVS repository: `npm test`, `npm run build`, `npm run lint`, then package inspection.
2. Publish an immutable SVS SemVer tag.
3. Update the dependency tag with `npm install git+https://github.com/z-hunter/Scanline-Virtual-Screen.git#vX.Y.Z`.
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

Build SVS after changing it, validate Scanline Term against that build, then restore the immutable tagged dependency before committing Scanline Term. Prefer a tagged package release for any shared or reproducible branch.

## Licensing

SVS is public under PolyForm Noncommercial 1.0.0. Commercial use needs a separate written license from its copyright holders. Scanline Term contributors must preserve SVS notices and must not assume the SVS license grants commercial redistribution rights.
