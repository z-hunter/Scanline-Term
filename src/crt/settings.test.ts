import { describe, expect, it } from 'vitest';
import { DEFAULT_CRT_SETTINGS, DEFAULT_RESOLUTION, loadStoredSettings } from './settings';

describe('CRT settings', () => {
  it('keeps Quest defaults without the removed hum setting', () => {
    expect(DEFAULT_CRT_SETTINGS.curvature).toBe(0.16);
    expect(DEFAULT_CRT_SETTINGS.scanlineCount).toBe(200);
    expect(DEFAULT_CRT_SETTINGS.persistenceIntensity).toBe(1);
    expect('humBar' in DEFAULT_CRT_SETTINGS).toBe(false);
  });

  it('rejects corrupt values and falls back to VGA', () => {
    const loaded = loadStoredSettings(
      JSON.stringify({ resolution: 'not-a-resolution', crt: { bloom: 9, persistenceIntensity: 0.35, curvature: 0.25 } }),
    );
    expect(loaded.resolution).toBe(DEFAULT_RESOLUTION);
    expect(loaded.crt.bloom).toBe(DEFAULT_CRT_SETTINGS.bloom);
    expect(loaded.crt.persistenceIntensity).toBe(0.35);
    expect(loaded.crt.curvature).toBe(0.25);
  });

  it('survives malformed JSON', () => {
    expect(loadStoredSettings('{broken').crt).toEqual(DEFAULT_CRT_SETTINGS);
  });
});
