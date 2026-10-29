import { describe, expect, it, vi } from 'vitest';
import { effectiveManagedSettings, LatestSettingsRequest, loadAndCommitLatest, normalizeManagedSettings } from './managed-settings';
import { loadStoredSettings } from './settings';

const legacy = loadStoredSettings(null);
const wire = (overrides: Record<string, unknown> = {}) => ({
  version: null, browserFormFactor: null, tabPlacement: null, hideTabsBar: null, hideTabsBarOnlyIfSingleTab: null,
  globalHotkeyEnabled: null, slideFromTop: null, autoUpdateEnabled: null, settingsScale: null, showSettingsPanel: null,
  showAiPanel: null, aiAssistantDisabled: null, lastAiSelection: null, mcpEnabled: null, mcpKeepTabsOpen: null,
  defaultShell: null, explorerIntegrationEnabled: null, smoothScrollback: null, smoothTuiScrolling: null,
  rmbMenuInTerm: null, channelSwitchEffect: null, defaultPreset: null, restoreWindow: null, settingsVersion: null,
  ...overrides,
});
const response = (settings: Record<string, unknown>) => normalizeManagedSettings({ settings, revision: 'r1', path: 'sterm.lua', hasSettings: true, palettes: [], shells: [] });

describe('managed settings migration', () => {
  it('merges evaluated Lua fields over the captured legacy settings until migration', () => {
    const old = { ...legacy, browserFormFactor: '4:3' as const, smoothScrollback: false, defaultShell: 'legacy-shell' };
    expect(effectiveManagedSettings(response(wire({ tabPlacement: 'left', smoothScrollback: true })), old)).toMatchObject({ browserFormFactor: '4:3', tabPlacement: 'left', smoothScrollback: true, defaultShell: 'legacy-shell' });
  });

  it('does not resurrect legacy values for omitted fields after marker version 1', () => {
    const old = { ...legacy, browserFormFactor: '4:3' as const, smoothScrollback: false, defaultShell: 'legacy-shell' };
    expect(effectiveManagedSettings(response(wire({ settingsVersion: 1 })), old)).toMatchObject({ browserFormFactor: 'physical', smoothScrollback: true, defaultShell: '', defaultPreset: 'default', restoreWindow: true });
  });

  it('validates native response envelopes and preserves palette and shell snapshots', () => {
    const palettes = [{ id: 'lua:users', label: 'Users', foreground: '#FFFFFF', background: '#000000', colors: Array(16).fill('#123456') }];
    const shells = [{ id: 'lua:pwsh', name: 'pwsh', command: 'pwsh.exe', args: ['-NoLogo'] }];
    expect(normalizeManagedSettings({ settings: wire(), revision: 'r1', path: 'sterm.lua', hasSettings: false, palettes, shells })).toMatchObject({ palettes, shells });
    expect(() => normalizeManagedSettings({ settings: {}, revision: 3, path: '', hasSettings: false, palettes: [], shells: [] })).toThrow('invalid managed settings response');
  });
});

describe('managed setting request invalidation', () => {
  it('does not commit a value whose load completes after reload starts', async () => {
    const guard = new LatestSettingsRequest();
    const request = guard.begin();
    let finishLoad!: (value: string) => void;
    const commit = vi.fn();
    const completion = loadAndCommitLatest(guard, request, () => new Promise<string>((resolve) => { finishLoad = resolve; }), commit);
    guard.invalidate();
    finishLoad('stale');
    expect(await completion).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
});
