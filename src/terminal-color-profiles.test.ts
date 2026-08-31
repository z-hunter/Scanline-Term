import { describe, expect, it } from 'vitest';
import { colorProfile, profileColor } from './terminal-color-profiles';

describe('terminal color profiles', () => {
  it('keeps the historical 16-color palettes and xterm extended table', () => {
    expect(colorProfile('dos-vga').colors[3]).toBe('#aa5500');
    expect(colorProfile('windows-legacy').colors[4]).toBe('#000080');
    expect(colorProfile('ibm-3279').colors[13]).toBe('#ff00ff');
    expect(colorProfile('xterm-x11').colors).toHaveLength(256);
    expect(profileColor(colorProfile('solarized-dark'), 196)).toBe('rgb(255 0 0)');
  });
});
