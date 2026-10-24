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
