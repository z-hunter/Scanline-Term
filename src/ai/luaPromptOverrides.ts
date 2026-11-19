export type LuaPromptOverrides = { base?: string; developer?: string };

export function normalizeLuaPromptOverrides(value: unknown): LuaPromptOverrides | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Lua AI prompt overrides');
  const entries = Object.entries(value);
  if (entries.some(([key, prompt]) => !['base', 'developer'].includes(key) || typeof prompt !== 'string')) throw new Error('invalid Lua AI prompt overrides');
  return value as LuaPromptOverrides;
}
