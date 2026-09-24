# Quest → Scanline Virtual Screen: prompt for coding agent

> Temporary working brief. Do not add this file to the documentation index.

```text
You work in the Quest / Scanline Engine repository.

Context
=======

Until now, Quest's CRT video output was its own implementation. Its shader/pipeline was copied into Scanline Term, then extracted, generalized, and released as a separate public dependency: Scanline Virtual Screen (SVS).

Your task is to migrate Quest from the old local CRT/video-output pipeline to SVS and replace the old CRT/video-output settings in the Scanline Engine settings panel with SVS controlled settings sections.

SVS is the sole implementation source for the virtual screen and CRT. Do not copy its shader, compositor, or renderer back into Quest, and do not modify SVS itself as part of this task.

Known Quest context
===================

- Quest uses React 19, Vite, and TypeScript.
- `SceneRenderer` in `src/graphics/SceneRenderer.ts` produces the low-resolution Canvas2D game source.
- The base virtual game resolution is 320×200.
- `Game` in `src/core/Game.ts` owns the main game loop and the current CRT integration.
- Game entities, pre-CRT console lines, and the closed-console modal are drawn to the low-resolution source before CRT.
- The open console, editor UI, selection outlines, and other high-resolution UI remain above the final display canvas and must not receive CRT distortion.
- Legacy visual settings are stored through `game.settings` / `localStorage`; the Debug API uses dot notation, including `crt.enabled`.
- Existing Playwright/debug scenarios may disable the effect with `api.settings.setSetting('crt.enabled', false)`.
- Output-canvas resizing currently synchronizes to CSS size × `devicePixelRatio`; preserve this to avoid blur and a one-frame resize lag in Game ↔ Editor switching.

First inspect the current code
==============================

1. Read Quest's project instructions and documentation.
2. Find every current location responsible for:
   - the old CRT shader/filter/renderer;
   - the render loop and output-canvas resize;
   - the 320×200 source Canvas2D;
   - `crt.*` and video/display settings;
   - localStorage migration;
   - the `api.settings` Debug API;
   - the F9 settings panel;
   - relevant unit and Playwright tests.
3. Verify paths and all callers with `rg`; do not rely on assumed file names from this brief.

Dependency
==========

Install SVS from its public Git repository by immutable tag:

```json
"scanline-virtual-screen": "git+https://github.com/z-hunter/Scanline-Virtual-Screen.git#v2.0.2"
```

Commit both `package.json` and the lockfile. Do not use a branch name, a floating commit, or a local `file:` dependency in the final change.

Read before implementation:

- <https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/README.md>
- <https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/docs/api.md>
- <https://github.com/z-hunter/Scanline-Virtual-Screen/blob/main/docs/integration.md>

Target architecture
===================

Quest is a core-only SVS host:

```ts
import {
  VirtualScreenRenderer,
  defaultScreenProfile,
  normalizeProfile,
  profileToRenderSettings,
  type ScreenMode,
  type ScreenProfile,
} from 'scanline-virtual-screen/core';
```

Quest does not need to use `scanline-virtual-screen/terminal` (but may in the future).

Define one stable display mode (reuse an existing canonical name if Quest has one):

```ts
const QUEST_SCREEN_MODES: readonly ScreenMode[] = [
  { id: 'quest-320x200', label: '320 × 200', width: 320, height: 200 },
];
```

Profile rules:

- Persist canonical `ScreenProfile`.
- Persist only `virtualScreen.modeId`, never width, height, or aspect mode.
- Create defaults with `defaultScreenProfile(modeId)`.
- Load and validate with `normalizeProfile(input, fallbackProfile, QUEST_SCREEN_MODES)`.
- `profile.terminal` stays mandatory schema data but is ignored by Quest runtime.
- Do not add `terminal.enabled`.
- After migration, the canonical `ScreenProfile` is the only persisted source of truth for display/CRT state.

Rendering
=========

1. Keep `SceneRenderer` and the game Canvas2D source responsible for game rendering.
2. Create one `VirtualScreenRenderer` for the final output canvas.
3. Call SVS from the existing host render loop:

```ts
virtualScreen.render(
  gameSourceCanvas,
  profileToRenderSettings(screenProfile),
  [],
  sourceChanged,
);
```

1. Pass `true` only when the source was redrawn; preserve existing dirty-frame optimization where it exists. If Quest redraws the source every frame, `true` is valid.
2. Call `clearPersistence()` after a source-size or display-mode change.
3. Call `dispose()` when the display runtime closes or is replaced.
4. Do not recreate the renderer per frame, resize, or slider update.
5. Preserve synchronous output-canvas sizing from CSS size × DPR before rendering.
6. `profile.crt.crtEmulation === false` must produce SVS pass-through output; remove the old local shader path.
7. Preserve layering:
    - world, pre-CRT console, closed-console modal → source canvas → SVS;
    - open console, editor DOM, selection/UI overlays → after SVS, without CRT.

Settings and migration
======================

Use SVS's controlled React sections:

```ts
import {
  DisplaySettingsSection,
  CRTSettingsSection,
} from 'scanline-virtual-screen/react';

import 'scanline-virtual-screen/react/styles.css';
```

Integrate them in the existing Scanline Engine settings panel while preserving F9 behavior, host layout/navigation, and live preview.

Do not use `TerminalSettingsSection` or `PresetSettingsSection`: Quest has no xterm terminal and does not receive Scanline Term's preset workflow.

`DisplaySettingsSection` receives one mode and therefore hides its selector. This is expected; Quest needs no separate resolution selector.

Replace old controls that operated the removed CRT/video pipeline. Do not leave two control groups that change the same visual setting.

Add a minimal migration boundary for existing users:

- Read legacy `crt.*` and related video/display fields once and construct a `ScreenProfile`.
- Transfer values only where the old and SVS semantics actually match.
- For legacy values with no safe equivalent, use SVS defaults and document the choice.
- Do not overwrite a valid canonical profile with legacy data.
- Preserve all non-display user settings.

Debug API compatibility
========================

Do not break current automation unnecessarily. Preserve at least:

```ts
api.settings.setSetting('crt.enabled', false)
```

A thin compatibility adapter may map this key to `screenProfile.crt.crtEmulation`, but it must not create a second persisted CRT state.

Inspect all actually used `crt.*` Debug API keys. For each one, either map it to an equivalent canonical SVS field, keep an explicit limited compatibility alias, or update internal-only tests and documentation after verifying no external consumer depends on it.

Do not retain the old local renderer solely for API compatibility.

Removing old code
=================

After all callers use SVS, remove unused local CRT/video-output implementation files, shader sources, obsolete settings types, and dead imports. Check all callers first with `rg`.

Do not remove the game source Canvas2D pipeline, game/editor lifecycle, pre-/post-CRT layering, Debug API without replacement, or still-valid tests.

If old shader code is deleted, place that deletion in a separate, clearly named commit after the working SVS integration commit.

Tests and validation
====================

Add or adapt the smallest useful tests for:

1. Default Quest `ScreenProfile` using the single mode.
2. Canonical profile loading and unknown-`modeId` fallback.
3. Legacy Quest display-settings migration without losing non-display data.
4. `crt.enabled` compatibility mapping to `profile.crt.crtEmulation`.
5. SVS host renderer creation, resize, pass-through, and disposal without recreation during ordinary setting changes.
6. Controlled settings UI: CRT updates profile; mode selector is hidden for one available mode.
7. Pre-/post-CRT layering where existing project tools can verify it.

Run Quest's standard test, lint, and production-build commands.

Manually or with the existing Playwright setup verify:

- game launch;
- Game ↔ Editor switch;
- resize at different DPR values, without blur or a stale frame;
- CRT on/off and all exposed SVS CRT controls;
- canonical-profile reload;
- legacy-settings migration and reload;
- closed console modal is inside the CRT source;
- open console, editor UI, and selection outlines remain outside CRT;
- `api.settings.setSetting('crt.enabled', false)`;
- no WebGL errors, leaked RAF loops, or rendering after `dispose()`.

Documentation and final report
==============================

Update Quest documentation after a successful migration:

- SVS is the external display module; link its repository.
- Quest owns source canvas, host render loop, DPR resize, profile persistence, Game/Editor layering, and disposal.
- SVS owns composition, pass-through/CRT rendering, CRT schema, and controlled display/CRT sections.
- The legacy CRT pipeline is no longer part of Quest.
- Document migration and any retained compatibility aliases.

In the final report state:

1. Changed files and why.
2. The discovered legacy format and its migration.
3. Retained API aliases.
4. Removed local CRT files.
5. Test/lint/build/manual-check results.
6. Any differences between this brief and the actual Quest codebase.

Constraints
===========

- Do not modify SVS or release a new package version.
- Do not add dependencies for this migration.
- Do not add new modes, overlays, presets, scene graph, or visual effects.
- Keep the diff minimal and preserve Quest behavior outside the display boundary.

```
