local sterm = require 'sterm'

sterm.use('scripts/modal-layout.lua', {
  when = { process = { 'vim.exe', 'nvim.exe' } },
  options = { normal_layout = 'en-US' },
})
