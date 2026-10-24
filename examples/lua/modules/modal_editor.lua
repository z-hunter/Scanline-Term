-- Shared cursor-driven input-layout policy for modal editors. Each attachment
-- and terminal tab gets a separate VM; all locals below belong to one setup.
-- smart_caps is a static opt-in; key handling stays in the native input path.
local sterm = require 'sterm'

return function(options)
  if options.smart_caps == true then sterm.input.smart_caps() end

  -- Preserve the observed HKL exactly; it may not be a locale name.
  local normal_cursor_shapes = options.normal_cursor_shapes or { 'block' }
  local insert_layout
  local last_mode
  local capture_insert_layout = false
  local restore_pending = false

  local function cursor_mode(cursor)
    if options.normal_when_cursor_hidden == true and cursor.visible == false then
      return 'normal'
    end
    if cursor.shape == 'bar' then return 'insert' end
    for _, shape in ipairs(normal_cursor_shapes) do
      if cursor.shape == shape then return 'normal' end
    end
    -- Unknown/absent cursor shapes provide no reliable mode evidence.
  end

  local function apply_cursor_mode(ctx)
    -- A layout request changes the focused Windows thread's input layout.
    if not ctx.tab:is_active() or not ctx.tab:is_focused() then return end

    local mode = cursor_mode(ctx.tab:cursor_style())
    local current_layout = ctx.input:current_layout()
    if mode == 'normal' then
      -- Capture once on entry to Normal, before requesting English. Keep the
      -- flag set if no layout is observable yet; steady Normal snapshots must
      -- never recapture the English layout after it has been applied.
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
        -- set_layout queues a host intent. Retry on fresh snapshots until the
        -- host reports the saved layout; an older intent may expire by then.
        if current_layout == insert_layout then
          restore_pending = false
        else
          ctx.input:set_layout(insert_layout)
        end
      elseif current_layout then
        -- Once restoration settles, remember observed Insert-mode changes so
        -- the latest deliberate language choice is restored next time.
        insert_layout = current_layout
      end
    end
  end

  -- Run this once per VM, then reconcile latest observable mode after each
  -- activation/context snapshot rather than polling terminal state.
  sterm.on_activate(apply_cursor_mode)
  sterm.on('context-updated', apply_cursor_mode)

  -- While restore is pending, ignore the delayed Normal-layout acknowledgement
  -- and clear pending only when the saved Insert layout is observed.
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
end
