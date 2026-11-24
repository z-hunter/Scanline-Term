import { describe, expect, it } from 'vitest';
import { browserKeymap, commandForEvent, dispatchCommand, getActiveKeymap, getPressedVirtualModifiers, matchingCommand, nextBrowserKeymapGeneration, publishReloadKeymap, setActiveKeymap, setVirtualKeyState, shortcutHint, syncVirtualModifiers, validateKeymap } from './keymap';

describe('keymap', () => {
  it('uses epoch-based generations so a reloaded frontend supersedes native browser keymaps', () => {
    const first = nextBrowserKeymapGeneration();
    expect(first).toBeGreaterThan(Date.now());
    expect(nextBrowserKeymapGeneration()).toBe(first + 1);
  });

  it('resolves default and remapped term combinations', () => {
    expect(matchingCommand(null, new Set(['ContextMenu', 'KeyS']), 'KeyS')).toBe('settings.toggle');
    expect(matchingCommand(null, new Set(['Alt', 'Enter']), 'Enter')).toBe('window.toggle_fullscreen');
    const keymap = { term: 'RightCtrl+RightShift', bindings: {} };
    expect(matchingCommand(keymap, new Set(['ControlRight', 'ShiftRight', 'KeyS']), 'KeyS')).toBe('settings.toggle');
    expect(matchingCommand(keymap, new Set(['ControlLeft', 'ShiftRight', 'KeyS']), 'KeyS')).toBeNull();
  });

  it('treats AltGr as Alt rather than Ctrl+Alt for application shortcuts', () => {
    setVirtualKeyState('AltRight', true);
    const event = new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', altKey: true, ctrlKey: true });
    Object.defineProperty(event, 'getModifierState', { value: (key: string) => key === 'AltGraph' });
    expect(commandForEvent(event)).toBe('window.toggle_fullscreen');
    setVirtualKeyState('AltRight', false);
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

  it('keeps Menu held through ContextMenu events with an unidentified code', () => {
    const keymap = { term: 'Menu', bindings: {} };
    setActiveKeymap(keymap);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', code: 'Unidentified' }));
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace' }))).toBe('gallery.toggle');
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', code: 'Unidentified' }));
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace' }))).toBeNull();
    setActiveKeymap(null);
  });

  it('synchronizes held modifiers across the native browser handoff', () => {
    setActiveKeymap({ term: 'Menu', bindings: {} });
    setVirtualKeyState('ContextMenu', true);
    expect(getPressedVirtualModifiers()).toContain(0x5d);
    setActiveKeymap({ term: 'Menu', bindings: {} });
    syncVirtualModifiers([0x5d]);
    window.dispatchEvent(new Event('blur'));
    expect(getPressedVirtualModifiers()).toContain(0x5d);
    expect(commandForEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }))).toBe('tab.next');
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', code: 'Unidentified' }));
    expect(commandForEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }))).toBeNull();
    setActiveKeymap(null);
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

  it('compiles a generic Alt binding for native browser input', () => {
    expect(browserKeymap(null)).toContainEqual({ command: 'window.toggle_fullscreen', key: 0x0d, modifiers: [[0xa4, 0xa5, 0x12]], repeat: false });
  });

  it('routes Alt+F4 from native browser input to the application window', () => {
    expect(browserKeymap(null)).toContainEqual({ command: 'window.close', key: 0x73, modifiers: [[0xa4, 0xa5, 0x12]], repeat: false });
    expect(matchingCommand(null, new Set(['AltLeft', 'F4']), 'F4')).toBe('window.close');
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
    dispatchCommand('window.close');
    dispatchCommand('unknown.command');
    window.removeEventListener('keydown', listener);
    expect(received).toEqual(['settings.toggle', 'window.close']);
  });
});
