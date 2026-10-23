local sterm = require 'sterm'
local options = ...
local insert_layout
local normal_cursor_shapes = options.normal_cursor_shapes or { 'block' }

local function apply_cursor_mode(ctx)
  if not ctx.tab:is_active() or not ctx.tab:is_focused() then
    return
  end

  local shape = ctx.tab:cursor_style().shape
  if shape == 'bar' then
    insert_layout = insert_layout or ctx.input:current_layout()
    if insert_layout then ctx.input:set_layout(insert_layout) end
  else
    for _, normal_shape in ipairs(normal_cursor_shapes) do
      if shape == normal_shape then
        ctx.input:set_layout(options.normal_layout)
        break
      end
    end
  end
end

sterm.on_activate(apply_cursor_mode)
sterm.on('context-updated', apply_cursor_mode)

sterm.on('input-language-changed', function(ctx, event)
  if ctx.tab:is_active() and ctx.tab:is_focused()
      and ctx.tab:cursor_style().shape == 'bar' then
    insert_layout = event.language
  end
end)
