-- Put this entry beside the executable, or use the app-config fallback shown
-- in the Lua guide. Its files are snapshotted at startup and on Reload config.
local sterm = require 'sterm'

-- Register trusted source explicitly: require() can load these aliases and the
-- built-in 'sterm' API, never files from the runtime filesystem.
sterm.module('modal_editor', 'modules/modal_editor.lua')

-- Each attachment gets its own VM, module cache, and state per terminal tab.
-- Keep Vim compatibility alongside Neovim because both share this policy file.
sterm.use('editors/nvim.lua', {
  when = { process = { 'vim.exe', 'nvim.exe' } },
})

sterm.use('editors/hx.lua', {
  when = { process = { 'hx.exe' } },
})
