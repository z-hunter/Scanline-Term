import { describe, expect, it } from 'vitest';
import { crtEffectMask, persistenceDecay } from './CRTFilter';
import { DEFAULT_CRT_SETTINGS, DEFAULT_RESOLUTION, loadStoredSettings } from './settings';

describe('CRT settings', () => {
  it('decays phosphor history by elapsed time rather than render frames', () => {
    expect(persistenceDecay(1, 1 / 60).decay).toBeCloseTo(0.9915);
    expect(persistenceDecay(1, 1).decay).toBeLessThan(0.61);
  });

  it('compiles only the enabled heavy CRT effects', () => {
    expect(crtEffectMask({ persistence: 0, bloom: 0, glow: 0 })).toBe(0);
    expect(crtEffectMask({ persistence: 1, bloom: 0, glow: 0 })).toBe(1);
    expect(crtEffectMask({ persistence: 0, bloom: 1, glow: 0 })).toBe(2);
    expect(crtEffectMask({ persistence: 0, bloom: 0, glow: 1 })).toBe(4);
    expect(crtEffectMask({ persistence: 1, bloom: 1, glow: 1 })).toBe(7);
  });

  it('keeps Quest defaults without the removed hum setting', () => {
    expect(DEFAULT_CRT_SETTINGS.curvature).toBe(0.16);
    expect(DEFAULT_CRT_SETTINGS.scanlineCount).toBe(200);
    expect(DEFAULT_CRT_SETTINGS.persistenceIntensity).toBe(1);
    expect(DEFAULT_CRT_SETTINGS.imageBrightness).toBe(1);
    expect(DEFAULT_CRT_SETTINGS.imageContrast).toBe(1);
    expect(DEFAULT_CRT_SETTINGS.backgroundDesaturation).toBe(0);
    expect(DEFAULT_CRT_SETTINGS.bloomAlgorithm).toBe('soft');
    expect(DEFAULT_CRT_SETTINGS.colorMode).toBe('color');
    expect(DEFAULT_CRT_SETTINGS.crtEmulation).toBe(true);
    expect('humBar' in DEFAULT_CRT_SETTINGS).toBe(false);
  });

  it('rejects corrupt values and falls back to VGA', () => {
    const loaded = loadStoredSettings(
      JSON.stringify({ resolution: 'not-a-resolution', crt: { bloom: 9, persistenceIntensity: 0.35, curvature: 0.25, colorMode: 'invalid', imageBrightness: 9 } }),
    );
    expect(loaded.resolution).toBe(DEFAULT_RESOLUTION);
    expect(loaded.crt.bloom).toBe(DEFAULT_CRT_SETTINGS.bloom);
    expect(loaded.crt.persistenceIntensity).toBe(0.35);
    expect(loaded.crt.curvature).toBe(0.25);
    expect(loaded.crt.colorMode).toBe(DEFAULT_CRT_SETTINGS.colorMode);
    expect(loaded.crt.imageBrightness).toBe(DEFAULT_CRT_SETTINGS.imageBrightness);
  });

  it('accepts the physical display resolution', () => {
    expect(loadStoredSettings(JSON.stringify({ resolution: 'physical' })).resolution).toBe('physical');
    expect(loadStoredSettings(JSON.stringify({ resolution: 'physical-4x3' })).resolution).toBe('physical-4x3');
    expect(loadStoredSettings(JSON.stringify({ resolution: 'physical-8x5' })).resolution).toBe('physical-8x5');
  });

  it('defaults tab placement to top and accepts only supported placements', () => {
    expect(loadStoredSettings(null).tabPlacement).toBe('top');
    expect(loadStoredSettings(JSON.stringify({ tabPlacement: 'left' })).tabPlacement).toBe('left');
    expect(loadStoredSettings(JSON.stringify({ tabPlacement: 'bottom' })).tabPlacement).toBe('top');
  });

  it('defaults and validates single-session tab visibility', () => {
    expect(loadStoredSettings(null).hideTabsWhenSingleSession).toBe(false);
    expect(loadStoredSettings(JSON.stringify({ hideTabsWhenSingleSession: true })).hideTabsWhenSingleSession).toBe(true);
    expect(loadStoredSettings(JSON.stringify({ hideTabsWhenSingleSession: 'yes' })).hideTabsWhenSingleSession).toBe(false);
  });

  it('defaults and validates the global hotkey switch', () => {
    expect(loadStoredSettings(null).globalHotkeyEnabled).toBe(false);
    expect(loadStoredSettings(JSON.stringify({ globalHotkeyEnabled: true })).globalHotkeyEnabled).toBe(true);
    expect(loadStoredSettings(JSON.stringify({ globalHotkeyEnabled: 'yes' })).globalHotkeyEnabled).toBe(false);
  });

  it('defaults and validates settings and AI panel visibility', () => {
    const initial = loadStoredSettings(null);
    expect(initial.showSettingsPanel).toBe(false);
    expect(initial.showAiPanel).toBe(false);

    const loaded = loadStoredSettings(
      JSON.stringify({ showSettingsPanel: true, showAiPanel: true }),
    );
    expect(loaded.showSettingsPanel).toBe(true);
    expect(loaded.showAiPanel).toBe(true);

    const invalid = loadStoredSettings(
      JSON.stringify({ showSettingsPanel: 'open', showAiPanel: 1 }),
    );
    expect(invalid.showSettingsPanel).toBe(false);
    expect(invalid.showAiPanel).toBe(false);
  });

  it('accepts virtual screens in all supported aspect ratios', () => {
    expect(loadStoredSettings(JSON.stringify({ resolution: '640x480' })).resolution).toBe('640x480');
    expect(loadStoredSettings(JSON.stringify({ resolution: '1280x800' })).resolution).toBe('1280x800');
  });

  it('survives malformed JSON', () => {
    expect(loadStoredSettings('{broken').crt).toEqual(DEFAULT_CRT_SETTINGS);
  });

  it('accepts the expanded trail intensity range', () => {
    const loaded = loadStoredSettings(JSON.stringify({ crt: { persistenceIntensity: 4 } }));
    expect(loaded.crt.persistenceIntensity).toBe(4);
  });

  it('accepts the expanded glow intensity range', () => {
    const loaded = loadStoredSettings(JSON.stringify({ crt: { glow: 2 } }));
    expect(loaded.crt.glow).toBe(2);
  });

  it('accepts a phosphor color mode', () => {
    expect(loadStoredSettings(JSON.stringify({ crt: { colorMode: 'amber' } })).crt.colorMode).toBe('amber');
  });

  it('accepts the legacy bloom algorithm', () => {
    expect(loadStoredSettings(JSON.stringify({ crt: { bloomAlgorithm: 'spiral' } })).crt.bloomAlgorithm).toBe('spiral');
  });

  it('accepts a color profile', () => {
    expect(loadStoredSettings(JSON.stringify({ crt: { colorProfile: 'solarized-dark' } })).crt.colorProfile).toBe('solarized-dark');
    expect(loadStoredSettings(JSON.stringify({ crt: { colorProfile: 'cyberpunk' } })).crt.colorProfile).toBe('cyberpunk');
    expect(loadStoredSettings(JSON.stringify({ crt: { colorProfile: 'retrowave' } })).crt.colorProfile).toBe('cyberpunk');
    expect(loadStoredSettings(JSON.stringify({ crt: { colorProfile: 'zx-spectrum' } })).crt.colorProfile).toBe('cyberpunk');
  });

  it('preserves a selected console font', () => {
    expect(loadStoredSettings(JSON.stringify({ crt: { consoleFont: 'Cascadia Mono' } })).crt.consoleFont).toBe('Cascadia Mono');
  });

  it('preserves a selected console font size', () => {
    expect(loadStoredSettings(JSON.stringify({ crt: { consoleFontSize: 14 } })).crt.consoleFontSize).toBe(14);
  });

  it('preserves the CRT emulation switch', () => {
    expect(loadStoredSettings(JSON.stringify({ crt: { crtEmulation: false } })).crt.crtEmulation).toBe(false);
  });

  it('sanitizes image-only final controls', () => {
    const loaded = loadStoredSettings(JSON.stringify({ crt: { imageBrightness: 1.25, imageContrast: 0.75, backgroundDesaturation: 0.6 } }));
    expect(loaded.crt.imageBrightness).toBe(1.25);
    expect(loaded.crt.imageContrast).toBe(0.75);
    expect(loaded.crt.backgroundDesaturation).toBe(0.6);
  });
});
