import { describe, expect, it, vi } from 'vitest';
import { effectiveManagedSettings, LatestSettingsRequest, loadAndCommitLatest, normalizeManagedSettings } from './managed-settings';

const response = (hasSettings: boolean, settings: { defaultPreset?: unknown; smoothScrollback?: unknown }) => normalizeManagedSettings({
  settings,
  revision: 'r1',
  path: 'sterm.lua',
  hasSettings,
  palettes: [],
});

describe('managed settings migration', () => {
  it('keeps the legacy smooth-scroll value until the first settings declaration', () => {
    expect(effectiveManagedSettings(response(false, {}), false)).toEqual({ defaultPreset: 'default', smoothScrollback: false });
  });

  it('uses app defaults when an explicit declaration omits pilot keys', () => {
    expect(effectiveManagedSettings(response(true, {}), false)).toEqual({ defaultPreset: 'default', smoothScrollback: true });
  });

  it('uses app defaults after the legacy value was migrated and the declaration is removed', () => {
    expect(effectiveManagedSettings(response(false, {}), false, false)).toEqual({ defaultPreset: 'default', smoothScrollback: true });
  });

  it('normalizes managed values and ignores malformed field types', () => {
    const loaded = response(true, { defaultPreset: 'DEC VT-100 (1978)', smoothScrollback: 'false' });
    expect(effectiveManagedSettings(loaded, false)).toEqual({ defaultPreset: 'DEC VT-100 (1978)', smoothScrollback: true });
  });

  it('preserves the complete palette snapshot supplied by native settings load', () => {
    const palettes = [{ id: 'lua:users', label: "User's", foreground: '#FFFFFF', background: '#000000', colors: Array(16).fill('#123456') }];
    expect(normalizeManagedSettings({ settings: {}, revision: 'r1', path: 'sterm.lua', hasSettings: false, palettes }).palettes).toEqual(palettes);
  });

  it('rejects malformed native responses', () => {
    expect(() => normalizeManagedSettings({ settings: {}, revision: 3, path: '', hasSettings: false })).toThrow('invalid managed settings response');
    expect(() => normalizeManagedSettings({ settings: {}, revision: 'r1', path: '', hasSettings: false })).toThrow('invalid managed settings response');
  });
});

describe('managed setting request invalidation', () => {
  it('does not save a default choice whose preset load completes after reload starts', async () => {
    const guard = new LatestSettingsRequest();
    const request = guard.begin();
    let finishLoad!: (value: string) => void;
    const save = vi.fn();
    let committed = '';
    const completion = loadAndCommitLatest(
      guard,
      request,
      () => new Promise<string>((resolve) => { finishLoad = resolve; }),
      async (value) => { save(); committed = value; },
    );

    guard.invalidate();
    finishLoad('loaded preset');
    expect(await completion).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(committed).toBe('');
  });
});
