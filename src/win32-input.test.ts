import { describe, expect, it } from 'vitest';
import { win32InputKey } from './win32-input';

const key = (code: string, overrides: Partial<KeyboardEvent> = {}) => ({ key: code, code, altKey: false, ctrlKey: false, shiftKey: false, repeat: false, ...overrides } as KeyboardEvent);

describe('Win32 Input Mode encoding', () => {
  it('preserves modifier-only down/up events and standard virtual keys', () => {
    expect(win32InputKey(key('ControlLeft', { key: 'Control', ctrlKey: true }), true)).toBe('\x1b[17;29;0;1;8;1_');
    expect(win32InputKey(key('ControlLeft', { key: 'Control' }), false)).toBe('\x1b[17;29;0;0;0;1_');
    expect(win32InputKey(key('ContextMenu', { key: 'ContextMenu' }), true)).toBe('\x1b[93;93;0;1;0;1_');
    expect(win32InputKey(key('KeyC', { key: 'c', ctrlKey: true }), true)).toBe('\x1b[67;46;3;1;8;1_');
  });
});
