-- Helix can draw its Normal block cursor in the cell and hide the physical
-- cursor. This binding opts into hidden-cursor detection without changing the
-- user's Helix configuration.
local configure_modal_editor = require 'modal_editor'

configure_modal_editor({
  smart_caps = true,
  normal_layout = 'en-US',
  normal_cursor_shapes = { 'block', 'underline' },
  normal_when_cursor_hidden = true,
})
