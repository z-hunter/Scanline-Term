import { describe, expect, it } from 'vitest';
import { DEFAULT_CRT_SETTINGS } from '../crt/settings';
import { defaultScreenProfile, normalizeProfile, profileFromLegacyPreset, profileToJSON, profileToRenderSettings } from './profile';

describe('ScreenProfile', () => {
  it('normalizes the legacy preset into the canonical shape', () => {
    const profile = normalizeProfile({ version: 1, resolution: '640x480', crt: { ...DEFAULT_CRT_SETTINGS, consoleFont: 'Cascadia Mono' } }, defaultScreenProfile(), [{ id: '640x480' }]);
    expect(profile?.schemaVersion).toBe(1);
    expect(profile?.virtualScreen.modeId).toBe('640x480');
    expect(profile?.terminal.fontFamily).toBe('Cascadia Mono');
    expect(profile?.crt.curvature).toBe(DEFAULT_CRT_SETTINGS.curvature);
  });

  it('keeps the fallback mode when the saved mode is unavailable', () => {
    const fallback = defaultScreenProfile('1024x768');
    const profile = normalizeProfile({ schemaVersion: 1, virtualScreen: { modeId: 'missing' }, terminal: {}, crt: {} }, fallback, [{ id: '640x480' }]);
    expect(profile?.virtualScreen.modeId).toBe('640x480');
  });

  it('round-trips the canonical profile without losing render settings', () => {
    const original = profileFromLegacyPreset({ version: 1, resolution: '800x600', crt: { ...DEFAULT_CRT_SETTINGS, glow: 1.5 } });
    const normalized = normalizeProfile(JSON.parse(profileToJSON(original)), defaultScreenProfile(), [{ id: '800x600' }]);
    expect(normalized?.virtualScreen.modeId).toBe('800x600');
    expect(normalized?.crt.glow).toBe(1.5);
    expect(profileToRenderSettings(normalized!).consoleFont).toBe(DEFAULT_CRT_SETTINGS.consoleFont);
  });
});
