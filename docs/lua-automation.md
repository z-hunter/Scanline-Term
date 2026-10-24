# Lua automation (incremental Windows slice)

Scanline Term can run bounded Lua event scripts for terminal tabs. The engine is process-agnostic; the repository example binds Vim, Neovim, and Helix (`hx.exe`) to the same cursor-layout script. Each binding supplies its process name, `normal_layout`, and optional cursor policies; the shared script handles reported cursor shape and visibility. This is an incremental implementation, not the complete Lua automation specification.

## Install and reload

Place `sterm.lua` beside the application executable, with its referenced scripts under the same directory. The portable entry takes precedence over `%APPDATA%\com.zhunter.scanlineterm\config.lua` in release builds; development builds use the isolated `%APPDATA%\com.zhunter.scanlineterm.dev\config.lua` path. The repository examples are [sterm.lua](../examples/lua/sterm.lua) and [scripts/modal-layout.lua](../examples/lua/scripts/modal-layout.lua); they are not currently bundled with the installer. Copy both files and preserve their relative paths. The entry file binds processes and supplies options; the shared file contains cursor-mode behavior.

The frontend starts its native context automatically when the app launches. With no config file, status is disabled and terminal tabs work normally. With a config file, startup loads it and reports ready or an error in Settings. Use the Lua Automation controls there to inspect status and reload after editing files. A reload creates fresh script state for every tab. A configuration or script load failure disables the current configuration and reports diagnostics; it does not keep a silently stale configuration running. Closing a tab discards its Lua state.

```lua
local sterm = require 'sterm'

sterm.use('scripts/modal-layout.lua', {
  when = { process = { 'vim.exe', 'nvim.exe' } },
  options = { normal_layout = 'en-US' },
})

sterm.use('scripts/modal-layout.lua', {
  when = { process = { 'hx.exe' } },
  options = {
    normal_layout = 'en-US',
    normal_cursor_shapes = { 'block', 'underline' },
    normal_when_cursor_hidden = true,
  },
})
```

`sterm.use(path, options)` accepts a relative `.lua` path confined to the entry file's directory, an optional `when.process` list of executable basenames, and optional JSON-like script options. The same script path may be bound more than once with different process names or options. The example defaults `normal_cursor_shapes` to `{ 'block' }`; Helix also opts into `normal_when_cursor_hidden`. Helix's configured Normal block cursor is painted into the text cell while its physical cursor is hidden, so shape alone stays at the last physical shape (often a bar). The opt-in policy treats an explicitly hidden terminal cursor as Normal before checking shape. It remains a generic cursor-visibility rule; process matching and opting in stay in the entry file.

For Helix, click inside the terminal canvas first so the editor receives focus. Its focused Normal block cursor is drawn in the buffer while the physical terminal cursor is hidden; `normal_when_cursor_hidden` handles that state without changing Helix configuration. Keep the focus guards in the shared script so terminal focus changes cannot drive layout requests from a background tab.

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

Every attachment and tab has a separate Lua VM and script state. The generic shared script does not check editor names; process filtering belongs in `sterm.use`. Unknown or absent cursor shapes do not trigger layout changes unless an enabled visibility policy identifies the cursor as hidden. The example captures the active layout when entering a normal cursor state, then restores that exact identifier on entering Insert. It keeps the configured `normal_layout` applied while normal and stops enforcing the restored layout once Windows reports it, so a manual layout choice in Insert is retained. The script reacts to reported terminal cursor metadata, not editor mode text or visual cell highlighting.

## Runtime limits

The current sandbox is a deliberately small Lua subset, not unrestricted Lua. Only the built-in `sterm` module can be required. File loading, `io`, `os`, `debug`, `package`, FFI, coroutines, and protected calls (`pcall`/`xpcall`) are unavailable. Lua pattern search/replace functions and `string.dump` are also removed. Scripts use the ordinary table, math, UTF-8, basic string, and base functions that remain available.

The engine limits each config/script source to 256 KiB, total cached source to 2 MiB, attachments to 64, total live script instances to 64, each VM to 2 MiB, handlers per VM to 128, and queued layout intents per callback to 16. Initialization and each callback have a one-million-instruction hook budget and a 50 ms wall-time check. The time check runs after Lua returns; it is not an operating-system hard interrupt. The sandbox removes operations with expensive Lua-pattern matching and protected calls that could evade the hook. Callbacks that error or exceed a limit lose all intents from that invocation and disable that script instance until reload. Native Windows operations happen after the Lua callback returns and are separately checked by the controller.

For native lifecycle, event production, and implementation detail, see [Core systems](04-core-systems.md#lua-terminal-automation) and [Architecture](02-architecture.md#lua-terminal-automation).
