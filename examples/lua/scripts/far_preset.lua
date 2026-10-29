-- Switch to a saved display preset while FAR Manager is running, then restore
-- the saved preset selected before FAR started. Preset requests are guarded by
-- the host so dirty tab edits are never overwritten.
local sterm = require 'sterm'

-- Replace this name with another saved preset if you prefer. The bundled
-- template ships with 'DEC VT-100 (1978)' as an example preset.
local far_preset = 'DEC VT-100 (1978)'
local baseline_key = 'far_preset.baseline'
local target_key = 'far_preset.target'
local far_was_running = false

local function restore(ctx)
  local baseline = ctx.state:get(baseline_key)
  local target = ctx.state:get(target_key)
  if baseline and target and ctx.tab:preset_name() == target then
    ctx.tab:apply_preset(baseline)
  end
  ctx.state:set(baseline_key, nil)
  ctx.state:set(target_key, nil)
end

local function update_far_preset(ctx)
  if not ctx.tab:is_active() then return end

  local process = ctx.tab:local_process_name()
  if process == nil then return end
  -- The host reports executable basenames; Windows may vary their case.
  local far_is_running = string.lower(process) == 'far.exe'

  if far_is_running then
    if far_was_running then return end
    -- Keep the original baseline across reloads, but let a fresh VM apply its
    -- current configured target once.
    if ctx.state:get(baseline_key) == nil then
      ctx.state:set(baseline_key, ctx.tab:preset_name())
    end
    ctx.state:set(target_key, far_preset)
    far_was_running = true
    ctx.tab:apply_preset(far_preset)
  else
    -- A persisted baseline also covers a FAR exit first observed after reload.
    if ctx.state:get(baseline_key) ~= nil then restore(ctx) end
    far_was_running = false
  end
end

-- Stay unfiltered so the FAR exit transition runs while the callback is active.
-- on_deactivate callbacks cannot apply a preset because the host rejects them.
sterm.on_activate(update_far_preset)
sterm.on('local-process-changed', update_far_preset)
sterm.on('context-updated', update_far_preset)
sterm.on_unload(restore)
