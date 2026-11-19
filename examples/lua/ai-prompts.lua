-- Uncomment one or both fields to customize Codex instructions.
-- Values are UTF-8 text, limited to 8 KiB per field.
-- base and developer replace their respective built-in prompt fields.
-- Omitted fields keep their built-in prompts; app safety rules remain active.
require('sterm').ai_prompts({
  -- base = [[Use my preferred concise response style.]],
  -- developer = [[When inspecting output, summarize errors before suggesting commands.]],
})
