import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appGlobalsFromStored, loadStoredSettings } from '../crt/settings';

const mocked = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocked.invoke, isTauri: () => true }));
import { useManagedSettings } from './useManagedSettings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const defaults = loadStoredSettings(null);
const legacy = appGlobalsFromStored(defaults);
const settings = (overrides: Record<string, unknown> = {}) => ({
  browserFormFactor: null, tabPlacement: null, hideTabsBar: null, hideTabsBarOnlyIfSingleTab: null,
  globalHotkeyEnabled: null, slideFromTop: null, autoUpdateEnabled: null, settingsScale: null, showSettingsPanel: null,
  showAiPanel: null, aiAssistantDisabled: null, lastAiSelection: null, mcpEnabled: null, mcpKeepTabsOpen: null,
  defaultShell: null, explorerIntegrationEnabled: null, smoothScrollback: null, smoothTuiScrolling: null,
  rmbMenuInTerm: null, channelSwitchEffect: null, defaultPreset: null, restoreWindow: null, settingsVersion: null,
  ...overrides,
});
const loaded = (value: unknown, revision = 'r1', hasSettings = false) => ({ settings: value, revision, path: 'sterm.lua', hasSettings, palettes: [], shells: [] });

describe('useManagedSettings', () => {
  beforeEach(() => mocked.invoke.mockReset());

  it('loads legacy values and writes the complete migrated payload with revision and marker', async () => {
    mocked.invoke.mockImplementation(async (command: string) => command === 'load_managed_settings'
      ? loaded(settings({ tabPlacement: 'left' }))
      : loaded(settings({ settingsVersion: 1 }), 'r2', true));
    const onError = vi.fn();
    let hook!: ReturnType<typeof useManagedSettings>;
    function Probe() { const current = useManagedSettings({ ...legacy, smoothScrollback: false }, onError); useEffect(() => { hook = current; }, [current]); return null; }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe)); });
      let result!: Awaited<ReturnType<typeof hook.load>>;
      await act(async () => { result = await hook.load(); });
      expect(result.needsMigration).toBe(true);
      expect(result.values).toMatchObject({ tabPlacement: 'left', smoothScrollback: false });
      let saved!: boolean;
      await act(async () => { saved = await hook.save(result.values); });
      expect(saved).toBe(true);
      expect(mocked.invoke).toHaveBeenLastCalledWith('save_managed_settings', {
        settings: { ...result.values, lastAiSelection: null, settingsVersion: 1 }, revision: 'r1',
      });
      expect(hook.authoritative).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('does not reload the legacy backup after a marker version 1 load', async () => {
    let loads = 0;
    mocked.invoke.mockImplementation(async () => { loads += 1; return loaded(settings({ settingsVersion: loads === 1 ? 1 : null, ...(loads === 1 ? { tabPlacement: 'left' } : {}) })); });
    let hook!: ReturnType<typeof useManagedSettings>;
    function Probe() { const current = useManagedSettings({ ...legacy, tabPlacement: 'left' }, vi.fn()); useEffect(() => { hook = current; }, [current]); return null; }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe)); });
      await act(async () => { await hook.load(); });
      expect(hook.values.tabPlacement).toBe('left');
      await act(async () => { await hook.load(); });
      expect(hook.values.tabPlacement).toBe('top');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('coalesces queued edits and rolls back failed writes to the last native state', async () => {
    let failSave!: (reason: Error) => void;
    mocked.invoke.mockImplementation((command: string) => {
      if (command === 'save_managed_settings') return new Promise((_, reject) => { failSave = reject; });
      return Promise.resolve(loaded(settings({ settingsVersion: 1, tabPlacement: 'left' }), 'r2', true));
    });
    const onError = vi.fn();
    let hook!: ReturnType<typeof useManagedSettings>;
    function Probe() { const current = useManagedSettings(legacy, onError); useEffect(() => { hook = current; }, [current]); return null; }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe)); });
      await act(async () => { await hook.load(); });
      let first!: Promise<boolean>;
      let second!: Promise<boolean>;
      await act(async () => {
        first = hook.save({ tabPlacement: 'top' });
        second = hook.save({ hideTabsBar: true });
        await Promise.resolve();
      });
      expect(mocked.invoke.mock.calls.filter(([name]) => name === 'save_managed_settings')).toHaveLength(1);
      await act(async () => { failSave(new Error('stale revision')); await Promise.all([first, second]); });
      expect(hook.values).toMatchObject({ tabPlacement: 'left', hideTabsBar: false });
      expect(hook.writesEnabled).toBe(false);
      expect(onError).toHaveBeenCalledWith('Could not save managed settings: Error: stale revision');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('serializes a smooth-scroll edit with a concurrent global change without restoring the stale value', async () => {
    mocked.invoke.mockImplementation((command: string) => {
      if (command === 'load_managed_settings') return Promise.resolve(loaded(settings({ settingsVersion: 1, smoothScrollback: false }), 'r1', true));
      return Promise.resolve(loaded(settings({ settingsVersion: 1 }), 'r2', true));
    });
    let hook!: ReturnType<typeof useManagedSettings>;
    function Probe() { const current = useManagedSettings(legacy, vi.fn()); useEffect(() => { hook = current; }, [current]); return null; }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe)); });
      await act(async () => { await hook.load(); });
      let smooth!: Promise<boolean>;
      let tabs!: Promise<boolean>;
      await act(async () => {
        smooth = hook.save({ smoothScrollback: true });
        tabs = hook.save({ hideTabsBar: true });
        await Promise.all([smooth, tabs]);
      });
      const saves = mocked.invoke.mock.calls.filter(([name]) => name === 'save_managed_settings');
      expect(saves).toHaveLength(1);
      expect(saves[0][1]).toMatchObject({ settings: { smoothScrollback: true, hideTabsBar: true }, revision: 'r1' });
      expect(hook.values).toMatchObject({ smoothScrollback: true, hideTabsBar: true });
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
