import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocked.invoke, isTauri: () => true }));
import { useManagedSettings } from './useManagedSettings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const loaded = (settings: unknown, revision = 'r1', hasSettings = false) => ({ settings, revision, path: 'sterm.lua', hasSettings });

describe('useManagedSettings', () => {
  beforeEach(() => mocked.invoke.mockReset());

  it('loads the legacy value and saves the full effective pair with the current revision', async () => {
    mocked.invoke.mockImplementation(async (command: string) => command === 'load_managed_settings'
      ? loaded({ defaultPreset: null, smoothScrollback: null })
      : loaded({ defaultPreset: 'default', smoothScrollback: false }, 'r2', true));
    const onError = vi.fn();
    let hook!: ReturnType<typeof useManagedSettings>;
    function Probe() { hook = useManagedSettings(false, onError); return null; }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe)); });
      let result!: Awaited<ReturnType<typeof hook.load>>;
      await act(async () => { result = await hook.load(false); });
      expect(result.values).toEqual({ defaultPreset: 'default', smoothScrollback: false });
      let saved!: boolean;
      await act(async () => { saved = await hook.save({ smoothScrollback: true }); });
      expect(saved).toBe(true);
      expect(mocked.invoke).toHaveBeenLastCalledWith('save_managed_settings', {
        settings: { defaultPreset: 'default', smoothScrollback: true },
        revision: 'r1',
      });
      expect(hook.authoritative).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('rolls back a failed save to the latest native state and cancels queued writes', async () => {
    let failSave!: (reason: Error) => void;
    mocked.invoke.mockImplementation((command: string) => {
      if (command === 'save_managed_settings') return new Promise((_, reject) => { failSave = reject; });
      return Promise.resolve(loaded({ defaultPreset: 'remote', smoothScrollback: true }, 'r2', true));
    });
    const onError = vi.fn();
    let hook!: ReturnType<typeof useManagedSettings>;
    function Probe() { hook = useManagedSettings(false, onError); return null; }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe)); });
      await act(async () => { await hook.load(false); });
      let first!: Promise<boolean>;
      let second!: Promise<boolean>;
      await act(async () => {
        first = hook.save({ smoothScrollback: false });
        second = hook.save({ defaultPreset: 'local' });
        await Promise.resolve();
      });
      await act(async () => { failSave(new Error('stale revision')); await Promise.all([first, second]); });
      expect(mocked.invoke.mock.calls.filter(([name]) => name === 'save_managed_settings')).toHaveLength(1);
      expect(hook.values).toEqual({ defaultPreset: 'remote', smoothScrollback: true });
      expect(hook.writesEnabled).toBe(false);
      expect(onError).toHaveBeenCalledWith('Could not save managed settings: Error: stale revision');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
