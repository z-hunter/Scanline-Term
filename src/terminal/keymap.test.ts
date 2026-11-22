import { describe, expect, it } from 'vitest';
import { browserKeymap, commandForEvent, dispatchCommand, getActiveKeymap, matchingCommand, publishReloadKeymap, setActiveKeymap, shortcutHint, validateKeymap } from './keymap';

describe('keymap', () => {
  it('resolves default and remapped term combinations', () => {
    expect(matchingCommand(null, new Set(['ContextMenu', 'KeyS']), 'KeyS')).toBe('settings.toggle');
    const keymap = { term: 'RightCtrl+RightShift', bindings: {} };
    expect(matchingCommand(keymap, new Set(['ControlRight', 'ShiftRight', 'KeyS']), 'KeyS')).toBe('settings.toggle');
    expect(matchingCommand(keymap, new Set(['ControlLeft', 'ShiftRight', 'KeyS']), 'KeyS')).toBeNull();
  });

  it('honors removed and custom bindings', () => {
    const keymap = { term: 'Menu', bindings: { 'settings.toggle': 'LeftAlt+F10', 'terminal.copy_mode': false as const } };
    expect(matchingCommand(keymap, new Set(['AltLeft', 'F10']), 'F10')).toBe('settings.toggle');
    expect(matchingCommand(keymap, new Set(['ContextMenu', 'KeyC']), 'KeyC')).toBeNull();
  });

  it('matches a generic modifier alongside a specific modifier of the same kind', () => {
    const keymap = { term: 'RightShift', bindings: { 'settings.toggle': 'Shift+term+S' } };
    validateKeymap(keymap);
    expect(matchingCommand(keymap, new Set(['ShiftLeft', 'ShiftRight', 'KeyS']), 'KeyS')).toBe('settings.toggle');
  });

  it('formats a backslash binding in shortcut hints', () => {
    setActiveKeymap({ term: 'Menu', bindings: { 'settings.toggle': 'term+Backslash' } });
    expect(shortcutHint('settings.toggle')).toBe(' [menu-\\]');
    setActiveKeymap(null);
  });

  it('rejects malformed and conflicting user bindings', () => {
    expect(() => validateKeymap({ term: 'RightCtrl+RightShift', bindings: { 'settings.toggle': 'term+S' } })).not.toThrow();
    expect(() => validateKeymap({ term: 'Menu', bindings: { 'settings.toggle': 'term+S', 'ai.toggle': 'term+S' } })).toThrow(/Conflicting/);
    expect(() => validateKeymap({ term: 'Menu', bindings: { 'settings.toggle': 'term+Unknown' } })).toThrow(/Invalid key/);
  });

  it('formats current shortcuts and hides disabled bindings', () => {
    setActiveKeymap({ term: 'RightCtrl+RightShift', bindings: { 'settings.toggle': 'term+S', 'ai.toggle': false } });
    expect(shortcutHint('settings.toggle')).toBe(' [RightCtrl-RightShift-S]');
    expect(shortcutHint('ai.toggle')).toBe('');
    setActiveKeymap(null);
  });

  it('compiles side-specific term modifiers for native browser input', () => {
    const keymap = { term: 'RightCtrl+RightShift', bindings: { 'settings.toggle': 'term+S' } };
    expect(browserKeymap(keymap)).toContainEqual({ command: 'settings.toggle', key: 83, modifiers: [[0xa3], [0xa1]], repeat: false });
  });

  it('publishes the committed reload snapshot and preserves the old map on invalid candidates', () => {
    const previous = { term: 'Menu', bindings: { 'settings.toggle': 'term+S' } };
    const committed = { term: 'RightCtrl', bindings: { 'settings.toggle': 'term+F10' } };
    setActiveKeymap(previous);
    publishReloadKeymap(null, 'error');
    expect(getActiveKeymap()).toEqual(previous);
    publishReloadKeymap(committed, 'ready');
    expect(getActiveKeymap()).toEqual(committed);
    expect(browserKeymap(getActiveKeymap())).toContainEqual({ command: 'settings.toggle', key: 0x79, modifiers: [[0xa3]], repeat: false });
    setActiveKeymap(null);
  });

  it('delivers a native browser command to the shared event handlers', () => {
    const received: (string | null)[] = [];
    const listener = (event: KeyboardEvent) => received.push(commandForEvent(event));
    window.addEventListener('keydown', listener);
    dispatchCommand('settings.toggle');
    dispatchCommand('unknown.command');
    window.removeEventListener('keydown', listener);
    expect(received).toEqual(['settings.toggle']);
  });
});
