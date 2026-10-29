# Lua automation (Windows V1 and release direction)

Scanline Term runs bounded Lua event scripts for terminal tabs. The Windows pilot adds a narrow managed-settings block for the saved default preset and smooth scrollback; other GUI settings remain on their existing persistence paths pending the broader release migration. The managed values are evaluated by the existing bounded Lua runtime, and GUI saves replace only the marked block while preserving user-authored bytes. This is an intermediate pilot, not the complete Lua settings migration or automation specification. Startup/reload seeds an absent profile config from a bundled inert template without overwriting existing user files. The portable packaging script places root `sterm.lua` and its `editors/`, `modules/`, `scripts/`, and `palettes/` support files beside the executable.

The engine is process-agnostic; the repository examples support Vim, Neovim, and Helix (`hx.exe`) through one shared cursor-layout module. Vim and Neovim share a binding, while Helix supplies its own cursor policy; the shared module handles reported cursor shape, layout capture, and restoration. This is an incremental implementation, not the complete Lua automation specification.

## Install and reload

For the portable ZIP, keep `sterm.lua`, `editors/`, `modules/`, `scripts/`, and `palettes/` beside the application executable. The portable entry takes precedence over `%APPDATA%\com.zhunter.scanlineterm\config.lua`; development builds use the isolated `%APPDATA%\com.zhunter.scanlineterm.dev\config.lua` path. The repository examples are [sterm.lua](../examples/lua/sterm.lua), [editors/nvim.lua](../examples/lua/editors/nvim.lua), [editors/hx.lua](../examples/lua/editors/hx.lua), [modules/modal_editor.lua](../examples/lua/modules/modal_editor.lua), [scripts/far_preset.lua](../examples/lua/scripts/far_preset.lua), and [palettes/users.lua](../examples/lua/palettes/users.lua). Editor attachments remain commented out, so they never activate automatically. The bundled user palette declaration is enabled in the entry and only adds a palette to the picker; it does not select a preset or change the active palette. Startup/reload seeds a missing profile config, while any existing profile or portable files are preserved.


The frontend starts its native context automatically when the app launches. Startup and **Reload config** seed an absent profile config from the bundled inert template, then load the selected portable or profile entry. Existing entries are never replaced. If seeding fails, Settings reports an error and **Reload config** retries; terminal tabs remain usable. The Lua Automation controls also provide **Edit config** to open the current entry file in the operating system's default editor. Load and runtime errors appear as error toasts; diagnostic messages are also written to the WebView console with a `[Lua]` prefix (`info` at info level, errors at error level). Reload creates fresh VMs and ordinary Lua locals for every tab. A valid retained attachment keeps only its `ctx.state` scalar values for the same tab and attachment identity; this state is in memory and does not survive tab close, app restart, explicit disable/removal, or a failed configuration reload. Removed attachments receive `sterm.on_unload(ctx)` once per script instance and tab before their state is cleared. A reload failure aborts the replacement and clears the old and candidate runtimes rather than resuming a VM whose unload callback may have run. A configuration or script load failure disables the current configuration rather than leaving a silently stale configuration running.

```lua
local sterm = require 'sterm'
sterm.module('modal_editor', 'modules/modal_editor.lua')
-- Uncomment the editor binding(s) you want to activate.
--[[
sterm.use('editors/nvim.lua', { when = { process = { 'vim.exe', 'nvim.exe' } } })
sterm.use('editors/hx.lua', { when = { process = { 'hx.exe' } } })
]]
```

`sterm.module(name, path)` adds one trusted local module to the entry file's manifest. Names are simple identifiers, paths are relative `.lua` files under the configuration directory, and `sterm` is reserved for the built-in API. Scripts may require only the built-in `sterm` module or a declared name. The loader captures every declared module with the config and attachment sources, counts unique file bytes against the existing source limits, and never gives Lua runtime filesystem access. Module values are cached per VM; cyclic and undeclared module requests fail validation. Reload reads a fresh snapshot.

`sterm.include(path)` executes a config fragment immediately in the same registration VM. Includes are relative `.lua` files, confined to the entry directory, snapshotted with the entry, and included in the same unique-source byte budget. Repeated includes are loaded once; active include cycles and nesting beyond 16 levels fail configuration. This API is for config declarations, not event scripts.

`sterm.ansi_palette(name, options)` declares a custom terminal palette from config or an included config fragment. It accepts a required label, foreground and background colors, an optional cursor color, and exactly 16 or 256 `#RRGGBB` entries. Names become stable `lua:<name>` IDs; duplicate IDs, unknown fields, malformed colors, and more than 64 declarations fail the config load. The shipped [User's palette](../examples/lua/palettes/users.lua) demonstrates the API.

`sterm.use(path, options)` accepts a relative `.lua` path confined to the entry file's directory, an optional `when.process` list of executable basenames, and optional JSON-like script options. The Neovim binding uses a visible block cursor for Normal mode. Helix also opts into `normal_when_cursor_hidden`: Helix's Normal block cursor can be painted into the text cell while its physical cursor is hidden, so shape alone may stay at the last physical shape (often a bar). This visibility policy is editor-specific and stays in the Helix binding.

For Helix, click inside the terminal canvas first so the editor receives focus. Its focused Normal block cursor is drawn in the buffer while the physical terminal cursor is hidden; `normal_when_cursor_hidden` handles that state without changing Helix configuration. The shared module checks active-tab and window focus before requesting a layout change.

Sources are read into a bounded snapshot at load; filesystem edits take effect on reload.

## Managed settings pilot

The entry file may declare the two pilot settings once, at top level:

```lua
require('sterm').settings({
  default_preset = 'DEC VT-100 (1978)',
  smooth_scrollback = true,
})
```

The bundled entry contains a GUI-owned block between `scanline-term:managed-settings:begin` and `scanline-term:managed-settings:end`. Settings saves splice that block into the full Lua source and evaluate the resulting file in the existing bounded registration VM; Scanline Term does not parse Lua syntax itself. `hasSettings` is true only when an actual `sterm.settings(...)` call ran, so the inert template and commented-out examples do not count as a declaration. Portable `sterm.lua` still takes precedence over the profile config. Saves check the loaded source revision, reject malformed or duplicate markers, and atomically replace the file; bytes outside the block, including a BOM, line endings, and a shebang, are retained.

`load_managed_settings` and `save_managed_settings` return `{ settings: { defaultPreset, smoothScrollback }, hasSettings, revision, path, palettes }`. The palette list is independently evaluated from the bounded Lua config, even when `hasSettings` is false. GUI saves still write only the managed settings block. Reload prepares palettes from the frozen candidate config and publishes them only after that reload commits; a failed candidate retains the previous catalog. If no settings declaration has run, the app keeps the existing JSON smooth-scrollback value for migration; after the first declaration, omitted pilot values use app defaults. The GUI selects a saved preset by name as the default for future implicit tabs. An explicit launch preset takes precedence. Lua has no font field or arbitrary font override; choose a saved preset to select its saved font and display settings.

An event script may request a saved preset for its active tab with `ctx.tab:apply_preset(name)`. In `context-updated`, a process-matched attachment can request a preset while its tab is active even when the terminal canvas is not focused; other callbacks still require the active, focused context. The host checks that the tab remains live and active and the action generation is current. It rejects a dirty preset state so unsaved edits are not lost, checking again after the preset file loads. Reload and context changes invalidate queued requests. This action selects an existing saved preset; it does not persist edits or expose individual font properties.

The optional [FAR Manager example](../examples/lua/scripts/far_preset.lua) switches to a configured saved preset while `far.exe` is the tab's observed local process, then restores the committed saved preset name captured on entry. `ctx.tab:preset_name()` returns that committed name, including the actual saved default selected for an implicit tab; unsaved edits do not change it. Uncomment the example's `sterm.use` block in the shipped `sterm.lua` template to enable it, and confirm the configured FAR preset exists first. It stores the original preset and last requested FAR preset in per-tab `ctx.state`, so a valid reload can apply a changed FAR target while keeping the original baseline. Ordinary local phase tracking resets with each VM. On exit or removal it requests restoration only if the committed preset still matches the remembered FAR target; dirty or missing-preset requests can be rejected, and the script has no success acknowledgement or retry. It clears its state after exit/removal cleanup. An unavailable process name is ignored. Select the desired saved preset manually if a request is rejected.

The pilot makes only these managed values canonical in Lua. It does not complete the broader future GUI-backed migration described in the specification below; remaining GUI settings still use their existing storage and interfaces.

### Live dev validation

The Windows dev smoke passed on 2026-10-29. GUI save/reload preserved bytes outside the managed block. A guarded runtime script applied `ctx.tab:apply_preset('DEC VT-100 (1978)')` to its owned command tab; the tab showed that preset at `800x600` while **Default preset for new tabs** remained `default`. That smoke clicked the owned terminal canvas because it predated the unfocused `context-updated` preset path; editor layout requests still require terminal focus.

## Script API

Scripts use the built-in `sterm` module and register callbacks:

```lua
local sterm = require 'sterm'
local options = ...

sterm.on('context-updated', function(ctx)
  local cursor = ctx.tab:cursor_style()
  if cursor.shape == 'block' and cursor.visible then
    ctx.input:set_layout(options.normal_layout)
  end
end)
```

An attachment may declare Smart Caps during initialization with `sterm.input.smart_caps()`. The declaration is static for that attachment and applies only while its process binding matches the active, focused terminal tab. Calling it from an event callback is an error and disables that script instance. When explicitly enabled by uncommenting an editor binding in the sample entry, the shared modal-editor module opts in; the fixed behavior maps a Caps tap to Escape and a hold of 180 ms or longer to Control. Native classifies the hold from physical keyboard-hook timestamps, so WebView frame-delivery latency does not set the threshold. Lua declares the policy; key edges stay in the native input path and never call back into Lua. The user reports manually enabling and testing the Neovim and Helix bindings in installed 0.6.0 and confirming they work. An earlier Windows development smoke verified Neovim Caps tap and Caps+H. In a packaged 0.6.0 smoke, the owned Neovim process/window was identified by PID, executable path, title, and HWND: a Caps tap produced `abc` in Normal mode, and holding Caps while pressing H from Insert mode produced `ab` in Insert mode; CapsLock remained off. Four event frames (two Caps key-down and two key-up), each containing 18 events (72 total), were injected only to the exact foreground HWND. MCP create/echo/observe/close and owned-tab/observer/sidecar cleanup passed. This focused smoke does not establish the full focus/tab/reload/error matrix. Automated tests and frontend build pass.

`sterm.on(name, callback)` supports `tab-created`, `tab-activated`, `tab-deactivated`, `tab-title-changed`, `local-process-changed`, `cursor-style-changed`, `context-updated`, `tab-focus-changed`, `window-focus-changed`, and `input-language-changed`. `context-updated` runs after regular lifecycle and delta events for each fresh context snapshot on the active tab. A process-matched attachment receives it even when the terminal canvas is unfocused; use it to reevaluate the latest state after an earlier event's intent may have gone stale. Only saved-preset requests from that context can proceed without input focus; layout actions still require active terminal focus. `sterm.on_activate(callback)` and `sterm.on_deactivate(callback)` register process-match/focus lifecycle callbacks. `sterm.on_unload(callback)` registers one removal callback; it also runs when a failed configuration load unloads all scripts, but not for an attachment retained by reload. Each callback receives `ctx`; event callbacks also receive an event table. Context data is read through `ctx.tab:id()`, `title()`, `local_process_name()`, `cursor_style()`, `is_active()`, and `is_focused()`. `cursor_style()` returns `shape`, `blink`, and `visible`; visibility defaults to true for older snapshots and remains independent of shape. `ctx.input:current_layout()` returns the observed Windows layout identifier; `ctx.input:set_layout(name)` queues a host intent. Input-language events expose `event.language`.

`local_process_name()` returns the observed local child process, or the launched executable when no child has been reported; it does not inspect the full process tree.

The host runs Lua on a dedicated bounded worker and applies only returned intents. Before requesting a Windows keyboard layout, it rechecks frontend instance, tab generation, active/focused state, and live terminal ownership. Preset requests recheck frontend instance, tab generation, active tab, and live terminal ownership without requiring terminal input focus. Layout names can be locale names such as `en-US` or an installed HKL identifier. A request is reported as observed only after the focused thread's layout matches it. Diagnostics identify the script and event, and layout traces include tab and generation.

Every attachment and tab has a separate Lua VM. `ctx.state:get(key)` and `ctx.state:set(key, value)` provide bounded scalar state that survives a valid reload only when the tab and attachment identity still match. Identity uses the canonical normalized absolute script path, normalized process filter, and occurrence number for otherwise identical duplicate attachments; portable and profile config roots have separate identities. Values may be booleans, finite numbers, or strings; `nil` deletes a key. Keys are limited to 64 UTF-8 bytes, strings to 4 KiB, each script/tab scope to 32 keys and 16 KiB, and all state across the app to 1 MiB. Writes made by a callback commit only if it completes successfully; an error rolls back that callback's writes and actions, while previously committed state remains available after a valid reload. Invalid values or limits fail the callback. State is memory-only and is cleared on removal, failed configuration unload, disable, tab close, or app restart. Ordinary Lua locals and module values are rebuilt with each VM. `on_unload` can request only saved-preset restoration; the host applies it only when the tab still has the expected committed preset and is not dirty, and skips a stale request. Unload cleanup may run for an inactive tab. The shared editor module does not check editor names; process filtering belongs in `sterm.use`, while each editor file passes its own cursor policy to the shared setup function. Unknown or absent cursor shapes do not trigger layout changes unless an enabled visibility policy identifies the cursor as hidden. The module captures the active layout when entering a normal cursor state, then restores that exact identifier on entering Insert. It keeps the configured `normal_layout` applied while normal and stops enforcing the restored layout once Windows reports it, so a manual layout choice in Insert is retained. The script reacts to reported terminal cursor metadata, not editor mode text or visual cell highlighting.

The Lua API has no per-key callback or general key transformation function. Cursor-based layout automation and the fixed Smart Caps policy are supported.

## Runtime limits

The current sandbox is a deliberately small Lua subset, not unrestricted Lua. Only the built-in `sterm` module and modules declared with `sterm.module` can be required. File loading, `io`, `os`, `debug`, `package`, FFI, coroutines, and protected calls (`pcall`/`xpcall`) are unavailable. Lua pattern search/replace functions and `string.dump` are also removed. Scripts use the ordinary table, math, UTF-8, basic string, and base functions that remain available.

The engine limits each config/script source to 256 KiB, total cached source to 2 MiB, attachments to 64, total live script instances to 64, each VM to 2 MiB, handlers per VM to 128, and queued layout intents per callback to 16. Initialization and each callback have a one-million-instruction hook budget and a 50 ms wall-time check. The time check runs after Lua returns; it is not an operating-system hard interrupt. The sandbox removes operations with expensive Lua-pattern matching and protected calls that could evade the hook. Callbacks that error or exceed a limit lose all intents from that invocation and disable that script instance until reload. Native Windows operations happen after the Lua callback returns and are separately checked by the controller.

For native lifecycle, event production, and implementation detail, see [Core systems](04-core-systems.md#lua-terminal-automation) and [Architecture](02-architecture.md#lua-terminal-automation).
