-- Experimental Neovim fixture for Scanline Term's input-layout probe.
-- Set STERM_PROBE_OUTPUT to a writable path to record actual keys and buffer text.
local output_path = vim.env.STERM_PROBE_OUTPUT

local function record(kind, extra)
  if not output_path or output_path == "" then
    return
  end

  local mode = vim.api.nvim_get_mode().mode
  local event = {
    at = vim.uv.hrtime(),
    kind = kind,
    mode = mode,
    expectedCursorStyle = mode:match("^i") and "bar" or "block",
    buffer = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n"),
  }
  for key, value in pairs(extra or {}) do
    event[key] = value
  end
  local file = io.open(output_path, "a")
  if file then
    file:write(vim.json.encode(event), "\n")
    file:close()
  end
end

vim.opt.guicursor = "n:block,i:ver25"

local function emit_cursor_style(mode)
  local style = mode:match("^i") and "bar" or "block"
  io.stdout:write(style == "bar" and "\27[6 q" or "\27[2 q")
  io.stdout:flush()
end

vim.api.nvim_create_autocmd({ "ModeChanged", "TextChanged", "TextChangedI" }, {
  callback = function(event)
    if event.event == "ModeChanged" then
      local next_mode = event.match:match("^[^:]+:(.+)$") or vim.api.nvim_get_mode().mode
      emit_cursor_style(next_mode)
    end
    record(event.event, { match = event.match })
  end,
})

vim.on_key(function(key)
  record("key", { key = key })
end)

vim.schedule(function()
  emit_cursor_style(vim.api.nvim_get_mode().mode)
  record("ready")
end)
