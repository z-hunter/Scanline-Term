import type { TerminalColorProfile } from 'scanline-virtual-screen/core';
import { loadStoredSettings, type AppSettings, type StoredSettings } from './settings';
import type { ShellInfo } from '../terminal/shells';

export type ManagedSettings = Omit<AppSettings, 'version' | 'lastAiSelection'> & {
  lastAiSelection: AppSettings['lastAiSelection'] | null;
  defaultPreset: string;
  restoreWindow: boolean;
  settingsVersion: 1;
};

export type ManagedSettingsResponse = {
  settings: Record<keyof ManagedSettings, unknown>;
  revision: string;
  path: string;
  hasSettings: boolean;
  palettes: TerminalColorProfile[];
  shells: (ShellInfo & { id: string; args: string[] })[];
};

export type EffectiveManagedSettings = Omit<AppSettings, 'version'> & { defaultPreset: string; restoreWindow: boolean };

const empty = (): StoredSettings => loadStoredSettings(null);

export class LatestSettingsRequest {
  private generation = 0;
  begin(): number { return ++this.generation; }
  invalidate(): void { this.generation += 1; }
  isCurrent(request: number): boolean { return request === this.generation; }
}

export async function loadAndCommitLatest<T>(guard: LatestSettingsRequest, request: number, load: () => Promise<T>, commit: (value: T) => Promise<void> | void): Promise<boolean> {
  const value = await load();
  if (!guard.isCurrent(request)) return false;
  await commit(value);
  return guard.isCurrent(request);
}

export function normalizeManagedSettings(value: unknown): ManagedSettingsResponse {
  if (!value || typeof value !== 'object') throw new Error('invalid managed settings response');
  const response = value as Partial<ManagedSettingsResponse>;
  if (!response.settings || typeof response.settings !== 'object' || typeof response.revision !== 'string' || typeof response.path !== 'string' || typeof response.hasSettings !== 'boolean' || !Array.isArray(response.palettes) || !Array.isArray(response.shells)) throw new Error('invalid managed settings response');
  if (!response.shells.every((shell) => shell && typeof shell === 'object' && typeof shell.id === 'string' && shell.id.startsWith('lua:') && typeof shell.name === 'string' && typeof shell.command === 'string' && Array.isArray(shell.args) && shell.args.every((argument) => typeof argument === 'string'))) throw new Error('invalid managed settings response');
  return { settings: response.settings as Record<keyof ManagedSettings, unknown>, revision: response.revision, path: response.path, hasSettings: response.hasSettings, palettes: response.palettes as TerminalColorProfile[], shells: response.shells as ManagedSettingsResponse['shells'] };
}

export function effectiveManagedSettings(response: ManagedSettingsResponse, legacy: Omit<AppSettings, 'version'>): EffectiveManagedSettings {
  const defaults = empty();
  const candidates = Object.fromEntries(Object.entries(response.settings).filter(([, field]) => field !== null && field !== undefined));
  const base = response.settings.settingsVersion === 1 ? defaults : legacy;
  const normalized = loadStoredSettings(JSON.stringify({ ...base, ...candidates }));
  return {
    browserFormFactor: normalized.browserFormFactor,
    tabPlacement: normalized.tabPlacement,
    hideTabsBar: normalized.hideTabsBar,
    hideTabsBarOnlyIfSingleTab: normalized.hideTabsBarOnlyIfSingleTab,
    globalHotkeyEnabled: normalized.globalHotkeyEnabled,
    slideFromTop: normalized.slideFromTop,
    autoUpdateEnabled: normalized.autoUpdateEnabled,
    settingsScale: normalized.settingsScale,
    showSettingsPanel: normalized.showSettingsPanel,
    showAiPanel: normalized.showAiPanel,
    aiAssistantDisabled: normalized.aiAssistantDisabled,
    lastAiSelection: normalized.lastAiSelection,
    mcpEnabled: normalized.mcpEnabled,
    mcpKeepTabsOpen: normalized.mcpKeepTabsOpen,
    defaultShell: normalized.defaultShell,
    explorerIntegrationEnabled: normalized.explorerIntegrationEnabled,
    smoothScrollback: normalized.smoothScrollback,
    smoothTuiScrolling: normalized.smoothTuiScrolling,
    rmbMenuInTerm: normalized.rmbMenuInTerm,
    channelSwitchEffect: normalized.channelSwitchEffect,
    defaultPreset: typeof response.settings.defaultPreset === 'string' && response.settings.defaultPreset.length ? response.settings.defaultPreset : 'default',
    restoreWindow: typeof response.settings.restoreWindow === 'boolean' ? response.settings.restoreWindow : true,
  };
}
