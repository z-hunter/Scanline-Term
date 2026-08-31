import { describe, expect, it } from 'vitest';
import { colorProfile, profileColor, remapLegacyRgb } from './terminal-color-profiles';

describe('terminal color profiles', () => {
  it('keeps the historical 16-color palettes and xterm extended table', () => {
    expect(colorProfile('dos-vga').colors[3]).toBe('#aa5500');
    expect(colorProfile('windows-legacy').colors[4]).toBe('#000080');
    expect(colorProfile('ibm-3279').colors[13]).toBe('#ff00ff');
    expect(colorProfile('commodore-64').colors[11]).toBe('#b84104');
    expect(colorProfile('retrowave').colors[10]).toBe('#f949ff');
    expect(colorProfile('retrowave').colors[7]).toBe('#c0c0c0');
    expect(colorProfile('xterm-x11').colors).toHaveLength(256);
    expect(profileColor(colorProfile('solarized-dark'), 196)).toBe('rgb(255 0 0)');
  });

  it('maps legacy palette RGB emitted by Windows console applications', () => {
    expect(remapLegacyRgb(colorProfile('dos-vga'), '#0000ff')).toBe('#5555ff');
    expect(remapLegacyRgb(colorProfile('solarized-dark'), '#0000ff')).toBe('#839496');
    expect(remapLegacyRgb(colorProfile('dos-vga'), '#123456')).toBe('#123456');
  });
});
