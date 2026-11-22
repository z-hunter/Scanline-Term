import { describe, expect, it } from 'vitest';
import { globalHotkeyBindings } from './global-hotkeys';

describe('globalHotkeyBindings', () => {
  it('uses the default summon shortcut and respects the global switch', () => {
    expect(globalHotkeyBindings(null, true)).toEqual([{ command: 'window.toggle_visibility', modifiers: 8, key: 0xc0 }]);
    expect(globalHotkeyBindings(null, false)).toEqual([]);
  });

  it('supports configured gallery shortcuts and reports unsupported modifiers', () => {
    expect(globalHotkeyBindings({ term: 'Menu', bindings: { 'window.toggle_visibility': false, 'window.show_gallery': 'Ctrl+Shift+F10' } }, true))
      .toEqual([{ command: 'window.show_gallery', modifiers: 6, key: 0x79 }]);
    expect(() => globalHotkeyBindings({ term: 'Menu', bindings: { 'window.show_gallery': 'term+G' } }, true)).toThrow();
  });

});
