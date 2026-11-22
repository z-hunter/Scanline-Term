import { defaultBindings, type Keymap } from './keymap';

const virtualKeys: Record<string, number> = {
  Backquote: 0xc0, Minus: 0xbd, Equal: 0xbb, Backslash: 0xdc, Slash: 0xbf,
  Quote: 0xde, Comma: 0xbc, Period: 0xbe, Space: 0x20, Tab: 0x09,
  Enter: 0x0d, Backspace: 0x08, Escape: 0x1b, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
};
const modifierBits: Record<string, number> = { Alt: 1, Ctrl: 2, Shift: 4, Win: 8 };

export function globalHotkeyBindings(keymap: Keymap | null, enabled: boolean) {
  if (!enabled) return [];
  return ['window.toggle_visibility', 'window.show_gallery'].flatMap((command) => {
    const binding = keymap?.bindings[command] ?? defaultBindings[command];
    const alternatives = typeof binding === 'string' ? [binding] : binding || [];
    return alternatives.map((shortcut) => {
      const parts = shortcut.split('+');
      const name = parts.pop() ?? '';
      let modifiers = 0;
      for (const part of parts) {
        if (!(part in modifierBits)) throw new Error(`Unsupported global hotkey ${shortcut}`);
        modifiers |= modifierBits[part];
      }
      const key = /^[A-Z0-9]$/.test(name) ? name.charCodeAt(0)
        : /^F([1-9]|1[0-9]|2[0-4])$/.test(name) ? 0x6f + Number(name.slice(1))
          : virtualKeys[name];
      if (!key) throw new Error(`Unsupported global hotkey ${shortcut}`);
      return { command, modifiers, key };
    });
  });
}
