local sterm = require 'sterm'
local options = ...
local insert_layout
local last_mode
local capture_insert_layout = false
local restore_pending = false
local normal_cursor_shapes = options.normal_cursor_shapes or { 'block' }

local function cursor_mode(cursor)
  if options.normal_when_cursor_hidden == true and cursor.visible == false then
    return 'normal'
  end
  local shape = cursor.shape
  if shape == 'bar' then return 'insert' end
  for _, normal_shape in ipairs(normal_cursor_shapes) do
    if shape == normal_shape then return 'normal' end
  end
end

local function apply_cursor_mode(ctx)
  if not ctx.tab:is_active() or not ctx.tab:is_focused() then
    return
  end

  local cursor = ctx.tab:cursor_style()
  local mode = cursor_mode(cursor)
  local current_layout = ctx.input:current_layout()
  if mode == 'normal' then
    if last_mode ~= 'normal' then capture_insert_layout = true end
    if capture_insert_layout and current_layout then
      insert_layout = current_layout
      capture_insert_layout = false
    end
    last_mode = mode
    restore_pending = false
    if insert_layout and not capture_insert_layout then
      ctx.input:set_layout(options.normal_layout)
    end
  elseif mode == 'insert' then
    if last_mode == nil then
      insert_layout = current_layout
    elseif last_mode == 'normal' then
      restore_pending = insert_layout ~= nil
    end
    last_mode = mode
    if restore_pending then
      if current_layout == insert_layout then
        restore_pending = false
      else
        ctx.input:set_layout(insert_layout)
      end
    elseif current_layout then
      insert_layout = current_layout
    end
  end
end

sterm.on_activate(apply_cursor_mode)
sterm.on('context-updated', apply_cursor_mode)

sterm.on('input-language-changed', function(ctx, event)
  if ctx.tab:is_active() and ctx.tab:is_focused()
      and cursor_mode(ctx.tab:cursor_style()) == 'insert' then
    if restore_pending then
      if event.language == insert_layout then restore_pending = false end
    else
      insert_layout = event.language
    end
  end
end)
