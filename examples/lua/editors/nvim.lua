-- With matching Vim/Neovim terminal settings, bar means Insert and block means
-- Normal. Keep those cursor conventions here so shared behavior stays generic.
local configure_modal_editor = require 'modal_editor'

configure_modal_editor({
  normal_layout = 'en-US',
  normal_cursor_shapes = { 'block' },
  normal_when_cursor_hidden = false,
})
