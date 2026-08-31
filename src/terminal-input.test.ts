import { describe, expect, it } from 'vitest';
import { terminalKey, type TerminalInputModes } from './terminal-input';

const normal: TerminalInputModes = { applicationCursorKeysMode: false, applicationKeypadMode: false };
const key = (keyName: string, overrides: Partial<KeyboardEvent> = {}) => ({ key: keyName, code: keyName, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides } as KeyboardEvent);

describe('terminal keyboard encoding', () => {
  it('encodes function keys and modifiers as VT sequences', () => {
    expect(terminalKey(key('F1'), normal)).toBe('\x1bOP');
    expect(terminalKey(key('F12', { ctrlKey: true }), normal)).toBe('\x1b[24;5~');
    expect(terminalKey(key('F24', { shiftKey: true, altKey: true }), normal)).toBe('\x1b[45;4~');
  });

  it('encodes console controls and navigation modes', () => {
    expect(terminalKey(key('c', { ctrlKey: true, code: 'KeyC' }), normal)).toBe('\x03');
    expect(terminalKey(key('ArrowUp', { ctrlKey: true }), normal)).toBe('\x1b[1;5A');
    expect(terminalKey(key('ArrowLeft'), { applicationCursorKeysMode: true, applicationKeypadMode: false })).toBe('\x1bOD');
    expect(terminalKey(key('1', { code: 'Numpad1' }), { applicationCursorKeysMode: false, applicationKeypadMode: true })).toBe('\x1bOq');
  });
});
