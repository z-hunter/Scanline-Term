import { describe, expect, it } from 'vitest';
import { DEFAULT_CRT_SETTINGS, DEFAULT_RESOLUTION, loadStoredSettings } from './settings';

describe('CRT settings', () => {
  it('keeps Quest defaults without the removed hum setting', () => {
    expect(DEFAULT_CRT_SETTINGS.curvature).toBe(0.16);
    expect(DEFAULT_CRT_SETTINGS.scanlineCount).toBe(200);
    expect(DEFAULT_CRT_SETTINGS.persistenceIntensity).toBe(1);
    expect(DEFAULT_CRT_SETTINGS.colorMode).toBe('color');
    expect('humBar' in DEFAULT_CRT_SETTINGS).toBe(false);
  });

  it('rejects corrupt values and falls back to VGA', () => {
    const loaded = loadStoredSettings(
      JSON.stringify({ resolution: 'not-a-resolution', crt: { bloom: 9, persistenceIntensity: 0.35, curvature: 0.25, colorMode: 'invalid' } }),
    );
    expect(loaded.resolution).toBe(DEFAULT_RESOLUTION);
    expect(loaded.crt.bloom).toBe(DEFAULT_CRT_SETTINGS.bloom);
    expect(loaded.crt.persistenceIntensity).toBe(0.35);
    expect(loaded.crt.curvature).toBe(0.25);
    expect(loaded.crt.colorMode).toBe(DEFAULT_CRT_SETTINGS.colorMode);
  });

  it('survives malformed JSON', () => {
    expect(loadStoredSettings('{broken').crt).toEqual(DEFAULT_CRT_SETTINGS);
  });

  it('accepts the expanded trail intensity range', () => {
    const loaded = loadStoredSettings(JSON.stringify({ crt: { persistenceIntensity: 4 } }));
    expect(loaded.crt.persistenceIntensity).toBe(4);
  });

  it('accepts a phosphor color mode', () => {
    expect(loadStoredSettings(JSON.stringify({ crt: { colorMode: 'amber' } })).crt.colorMode).toBe('amber');
  });
});
