-- Put this entry beside the executable, or use the app-config fallback shown
-- in the Lua guide. Its files are snapshotted at startup and on Reload config.
local sterm = require 'sterm'

-- scanline-term:managed-settings:begin
-- GUI settings are saved here; this inert template declares no overrides.
-- scanline-term:managed-settings:end

-- Register this user-authored ANSI palette without changing the active preset.
sterm.include('palettes/users.lua')

-- Register trusted source explicitly: require() can load these aliases and the
-- built-in 'sterm' API, never files from the runtime filesystem.
sterm.module('modal_editor', 'modules/modal_editor.lua')

-- Registering a module makes it available to attached scripts; it does not
-- activate the module or any editor behavior by itself.
--
-- To enable an editor example, uncomment its sterm.use block below. Each
-- attachment gets its own VM, module cache, and state per terminal tab. The
-- Neovim wrapper also matches Vim for compatibility.
--
-- Neovim / Vim: uncomment to enable cursor-based layout switching and the
-- opt-in Smart Caps tap-Esc / hold-Ctrl policy for these processes.
--[[
sterm.use('editors/nvim.lua', {
  when = { process = { 'vim.exe', 'nvim.exe' } },
})
]]

-- Helix: uncomment to enable its cursor-based layout and Smart Caps policy.
--[[
sterm.use('editors/hx.lua', {
  when = { process = { 'hx.exe' } },
})
]]

-- FAR Manager preset example: uncomment after confirming the configured FAR
-- preset exists. It remembers the tab's selected preset on entry and restores it
-- on exit. Each attachment keeps separate state per terminal tab.
--[[
sterm.use('scripts/far_preset.lua')
]]
