import type { PresetSettings, TabPresetState } from '../crt/settings';
import type { LuaPresetRequest, LuaReloadCleanup } from './lua-automation';

export async function applyLuaPresetRequest(
  request: LuaPresetRequest,
  isCurrent: (request: LuaPresetRequest) => boolean,
  getPreset: (tabId: string) => TabPresetState | undefined,
  load: (name: string) => Promise<PresetSettings>,
  apply: (settings: PresetSettings, name: string, tabId: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  if (!request.name || !isCurrent(request)) return;
  if (getPreset(request.tabId)?.dirty) {
    onError(`Lua preset ${request.name} was not applied because the tab has unsaved preset changes.`);
    return;
  }
  try {
    const settings = await load(request.name);
    if (!isCurrent(request)) return;
    if (getPreset(request.tabId)?.dirty) {
      onError(`Lua preset ${request.name} was not applied because the tab has unsaved preset changes.`);
      return;
    }
    apply(settings, request.name, request.tabId);
  } catch (reason) {
    if (isCurrent(request)) onError(`Could not apply Lua preset ${request.name}: ${String(reason)}`);
  }
}

export async function applyLuaPresetCleanup(
  cleanup: LuaReloadCleanup,
  isCurrent: () => boolean,
  isLive: (tabId: string) => boolean,
  getPreset: (tabId: string) => TabPresetState | undefined,
  load: (name: string) => Promise<PresetSettings>,
  apply: (settings: PresetSettings, name: string, tabId: string) => void,
  onError: (message: string) => void,
): Promise<'handled' | 'stale'> {
  const canRestore = () => {
    const preset = getPreset(cleanup.tabId);
    return isLive(cleanup.tabId) && Boolean(preset && !preset.dirty && preset.name === cleanup.expectedCurrentPreset);
  };
  if (!isCurrent()) return 'stale';
  if (!canRestore()) {
    if (isLive(cleanup.tabId)) onError(`Lua preset restore for ${cleanup.tabId} was skipped because its preset changed or has unsaved edits.`);
    return 'handled';
  }
  try {
    const settings = await load(cleanup.name);
    if (!isCurrent()) return 'stale';
    if (!canRestore()) {
      if (isLive(cleanup.tabId)) onError(`Lua preset restore for ${cleanup.tabId} was skipped because its preset changed or has unsaved edits.`);
      return 'handled';
    }
    apply(settings, cleanup.name, cleanup.tabId);
  } catch (reason) {
    if (!isCurrent()) return 'stale';
    onError(`Could not restore Lua preset ${cleanup.name}: ${String(reason)}`);
  }
  return 'handled';
}
