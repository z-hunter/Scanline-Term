# Lua automation (incremental Windows slice)

Scanline Term can run bounded Lua event scripts for terminal tabs. The engine is process-agnostic; the repository example binds Vim, Neovim, and Helix (`hx.exe`) to one shared cursor-layout module. Vim and Neovim share a binding, while Helix supplies its own cursor policy; the shared module handles reported cursor shape, layout capture, and restoration. This is an incremental implementation, not the complete Lua automation specification.

## Install and reload

Place `sterm.lua` beside the application executable, with its declared editor and module files under the same directory. The portable entry takes precedence over `%APPDATA%\com.zhunter.scanlineterm\config.lua` in release builds; development builds use the isolated `%APPDATA%\com.zhunter.scanlineterm.dev\config.lua` path. The repository examples are [sterm.lua](../examples/lua/sterm.lua), [editors/nvim.lua](../examples/lua/editors/nvim.lua), [editors/hx.lua](../examples/lua/editors/hx.lua), and [modules/modal_editor.lua](../examples/lua/modules/modal_editor.lua); they are not currently bundled with the installer. Copy these files and preserve their relative paths. The entry file explicitly registers trusted modules and editor bindings.

The frontend starts its native context automatically when the app launches. With no config file, status is disabled and terminal tabs work normally. With a config file, startup loads it and reports its state in Settings. The Lua Automation controls provide **Reload config** to load a fresh snapshot and **Edit config** to open the entry file in the operating system's default editor. Load and runtime errors appear as error toasts; diagnostic messages are also written to the WebView console with a `[Lua]` prefix (`info` at info level, errors at error level). A reload creates fresh script state for every tab. A configuration or script load failure disables the current configuration rather than leaving a silently stale configuration running. Closing a tab discards its Lua state.

```lua
local sterm = require 'sterm'
sterm.module('modal_editor', 'modules/modal_editor.lua')
sterm.use('editors/nvim.lua', { when = { process = { 'vim.exe', 'nvim.exe' } } })
sterm.use('editors/hx.lua', { when = { process = { 'hx.exe' } } })
```

`sterm.module(name, path)` adds one trusted local module to the entry file's manifest. Names are simple identifiers, paths are relative `.lua` files under the configuration directory, and `sterm` is reserved for the built-in API. Scripts may require only the built-in `sterm` module or a declared name. The loader captures every declared module with the config and attachment sources, counts unique file bytes against the existing source limits, and never gives Lua runtime filesystem access. Module values are cached per VM; cyclic and undeclared module requests fail validation. Reload reads a fresh snapshot.

`sterm.use(path, options)` accepts a relative `.lua` path confined to the entry file's directory, an optional `when.process` list of executable basenames, and optional JSON-like script options. The Neovim binding uses a visible block cursor for Normal mode. Helix also opts into `normal_when_cursor_hidden`: Helix's Normal block cursor can be painted into the text cell while its physical cursor is hidden, so shape alone may stay at the last physical shape (often a bar). This visibility policy is editor-specific and stays in the Helix binding.

For Helix, click inside the terminal canvas first so the editor receives focus. Its focused Normal block cursor is drawn in the buffer while the physical terminal cursor is hidden; `normal_when_cursor_hidden` handles that state without changing Helix configuration. The shared module checks active-tab and window focus before requesting a layout change.

Sources are read into a bounded snapshot at load; filesystem edits take effect on reload.

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

`sterm.on(name, callback)` supports `tab-created`, `tab-activated`, `tab-deactivated`, `tab-title-changed`, `local-process-changed`, `cursor-style-changed`, `context-updated`, `tab-focus-changed`, `window-focus-changed`, and `input-language-changed`. `context-updated` runs after regular lifecycle and delta events for each fresh context snapshot while its tab is active and focused; use it to reevaluate the latest state after an earlier event's intent may have gone stale. `sterm.on_activate(callback)` and `sterm.on_deactivate(callback)` register process-match/focus lifecycle callbacks. Each callback receives `ctx`; event callbacks also receive an event table. Context data is read through `ctx.tab:id()`, `title()`, `local_process_name()`, `cursor_style()`, `is_active()`, and `is_focused()`. `cursor_style()` returns `shape`, `blink`, and `visible`; visibility defaults to true for older snapshots and remains independent of shape. `ctx.input:current_layout()` returns the observed Windows layout identifier; `ctx.input:set_layout(name)` queues a host intent. Input-language events expose `event.language`.

`local_process_name()` returns the observed local child process, or the launched executable when no child has been reported; it does not inspect the full process tree.

The host runs Lua on a dedicated bounded worker and applies only returned intents. It rechecks frontend instance, tab generation, active/focused state, and live terminal ownership before requesting a Windows keyboard layout. Layout names can be locale names such as `en-US` or an installed HKL identifier. A request is reported as observed only after the focused thread's layout matches it. Diagnostics identify the script and event, and layout traces include tab and generation.

Every attachment and tab has a separate Lua VM and script state, so module state is also isolated for every editor attachment and tab. The shared module does not check editor names; process filtering belongs in `sterm.use`, while each editor file passes its own cursor policy to the shared setup function. Unknown or absent cursor shapes do not trigger layout changes unless an enabled visibility policy identifies the cursor as hidden. The module captures the active layout when entering a normal cursor state, then restores that exact identifier on entering Insert. It keeps the configured `normal_layout` applied while normal and stops enforcing the restored layout once Windows reports it, so a manual layout choice in Insert is retained. The script reacts to reported terminal cursor metadata, not editor mode text or visual cell highlighting.

The current Lua API has no per-key callback or key transformation function. Cursor-based layout automation is supported; Caps-to-Esc/Ctrl remapping remains outside this API.

## Runtime limits

The current sandbox is a deliberately small Lua subset, not unrestricted Lua. Only the built-in `sterm` module and modules declared with `sterm.module` can be required. File loading, `io`, `os`, `debug`, `package`, FFI, coroutines, and protected calls (`pcall`/`xpcall`) are unavailable. Lua pattern search/replace functions and `string.dump` are also removed. Scripts use the ordinary table, math, UTF-8, basic string, and base functions that remain available.

The engine limits each config/script source to 256 KiB, total cached source to 2 MiB, attachments to 64, total live script instances to 64, each VM to 2 MiB, handlers per VM to 128, and queued layout intents per callback to 16. Initialization and each callback have a one-million-instruction hook budget and a 50 ms wall-time check. The time check runs after Lua returns; it is not an operating-system hard interrupt. The sandbox removes operations with expensive Lua-pattern matching and protected calls that could evade the hook. Callbacks that error or exceed a limit lose all intents from that invocation and disable that script instance until reload. Native Windows operations happen after the Lua callback returns and are separately checked by the controller.

For native lifecycle, event production, and implementation detail, see [Core systems](04-core-systems.md#lua-terminal-automation) and [Architecture](02-architecture.md#lua-terminal-automation).
