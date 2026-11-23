export type Keymap = { term: string; bindings: Record<string, string | string[] | false> };

let activeKeymap: Keymap | null = null;
const pressedKeys = new Set<string>();
const dispatchedCommands = new WeakMap<KeyboardEvent, string>();
// Rust retains the last browser keymap generation across WebView reloads.
// Seed with an epoch-scale value so a refreshed frontend supersedes that snapshot.
let browserKeymapGeneration = Date.now() * 1000;

export function nextBrowserKeymapGeneration(): number {
  return ++browserKeymapGeneration;
}

export function dispatchCommand(command: string): void {
  if (!(command in defaultBindings)) return;
  const event = new KeyboardEvent('keydown', { code: 'F24', bubbles: true });
  dispatchedCommands.set(event, command);
  window.dispatchEvent(event);
}

export function setVirtualKeyState(code: string, down: boolean): void {
  if (down) pressedKeys.add(code);
  else pressedKeys.delete(code);
}

export function setActiveKeymap(keymap: Keymap | null): void {
  activeKeymap = keymap;
  pressedKeys.clear();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('keymap-changed'));
}

export function getActiveKeymap(): Keymap | null { return activeKeymap; }

export function publishReloadKeymap(keymap: Keymap | null, candidateStatus: string): void {
  if (candidateStatus !== 'error') setActiveKeymap(keymap);
}

export function shortcutHint(command: string): string {
  const binding = activeKeymap?.bindings[command] ?? defaultBindings[command];
  if (binding === false || !binding || binding.length === 0) return '';
  const first = typeof binding === 'string' ? binding : binding[0];
  const term = activeKeymap?.term ?? 'Menu';
  const display = first.replace(/^term(?=\+|$)/, term === 'Menu' ? 'menu' : term)
    .replace(/\+/g, '-').replace(/Backslash$/, '\\').replace(/Slash$/, '/').replace(/Quote$/, "'")
    .replace(/Digit([0-9])$/, '$1');
  return ` [${display}]`;
}

export function commandForEvent(event: KeyboardEvent): string | null {
  const dispatched = dispatchedCommands.get(event);
  if (dispatched) return dispatched;
  const pressed = new Set([...pressedKeys, event.code]);
  const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
  if (event.shiftKey && !pressed.has('ShiftLeft') && !pressed.has('ShiftRight')) pressed.add('ShiftLeft');
  if (altGraph) { pressed.delete('ControlLeft'); pressed.delete('ControlRight'); }
  else if (event.ctrlKey && !pressed.has('ControlLeft') && !pressed.has('ControlRight')) pressed.add('ControlLeft');
  if (event.altKey && !modifierCodes.Alt.some((code) => pressed.has(code))) pressed.add('AltLeft');
  if (event.metaKey && !pressed.has('MetaLeft') && !pressed.has('MetaRight')) pressed.add('MetaLeft');
  return matchingCommand(activeKeymap, pressed, event.code);
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    const code = event.key === 'ContextMenu' ? 'ContextMenu' : event.code;
    if (Object.values(modifierCodes).some((codes) => codes.includes(code))) pressedKeys.add(code);
  }, true);
  window.addEventListener('keyup', (event) => { pressedKeys.delete(event.key === 'ContextMenu' ? 'ContextMenu' : event.code); }, true);
  window.addEventListener('blur', () => pressedKeys.clear());
}

export const defaultBindings: Record<string, string[]> = {
  'settings.toggle': ['term+S', 'term+Backslash'],
  'tabs.toggle_bar': ['term+Z'],
  'presets.toggle_picker': ['term+P'],
  'gallery.toggle': ['term+Backspace'],
  'ai.toggle': ['term+A'],
  'ai.toggle_focus': ['term+Quote'],
  'tab.new_terminal': ['term+N'],
  'tab.new_browser': ['term+B'],
  'tab.close': ['term+W'],
  'tab.next': ['term+ArrowRight', 'term+Period', 'term+Shift+Period'],
  'tab.previous': ['term+ArrowLeft', 'term+Comma', 'term+Shift+Comma'],
  'tab.last_active': ['term+Tab'],
  'tab.move_left': ['term+Shift+ArrowLeft', 'term+Shift+H'],
  'tab.move_right': ['term+Shift+ArrowRight', 'term+Shift+L'],
  'gallery.move_up': ['term+Shift+ArrowUp', 'term+Shift+K'],
  'gallery.move_down': ['term+Shift+ArrowDown', 'term+Shift+J'],
  'terminal.paste': ['term+V'],
  'terminal.copy_mode': ['term+C'],
  'terminal.add_image': ['term+I'],
  'terminal.find': ['term+Slash'],
  'terminal.find_back': ['term+Shift+Slash'],
  'terminal.page_up': ['term+PageUp'],
  'terminal.page_down': ['term+PageDown'],
  'workspace.scroll_up': ['term+K'],
  'workspace.scroll_down': ['term+J'],
  'terminal.font_decrease': ['term+Minus', 'term+NumpadSubtract'],
  'terminal.font_increase': ['term+Equal', 'term+NumpadAdd'],
  'window.toggle_fullscreen': ['Alt+Enter', 'Alt+NumpadEnter'],
  'window.close': ['Alt+F4'],
  'window.toggle_visibility': ['Win+Backquote'],
  'window.show_gallery': [],
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`tab.select.${index + 1}`, [`term+${(index + 1) % 10}`]])),
};

const modifierCodes: Record<string, string[]> = {
  Ctrl: ['ControlLeft', 'ControlRight'], LeftCtrl: ['ControlLeft'], RightCtrl: ['ControlRight'],
  Shift: ['ShiftLeft', 'ShiftRight'], LeftShift: ['ShiftLeft'], RightShift: ['ShiftRight'],
  Alt: ['AltLeft', 'AltRight', 'Alt'], LeftAlt: ['AltLeft'], RightAlt: ['AltRight'],
  Win: ['MetaLeft', 'MetaRight'], LeftWin: ['MetaLeft'], RightWin: ['MetaRight'],
  Menu: ['ContextMenu'], CapsLock: ['CapsLock'],
};

function keyCode(key: string): string {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return modifierCodes[key]?.[0] ?? key;
}

const virtualKeys: Record<string, number> = {
  ContextMenu: 0x5d, CapsLock: 0x14, ControlLeft: 0xa2, ControlRight: 0xa3,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, Alt: 0x12, AltLeft: 0xa4, AltRight: 0xa5, MetaLeft: 0x5b, MetaRight: 0x5c,
  Escape: 0x1b, Backspace: 0x08, Tab: 0x09, Enter: 0x0d, NumpadEnter: 0x0d, Space: 0x20,
  Minus: 0xbd, Equal: 0xbb, Backslash: 0xdc, Quote: 0xde, Backquote: 0xc0, Comma: 0xbc, Period: 0xbe, Slash: 0xbf,
  Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27, NumpadAdd: 0x6b, NumpadSubtract: 0x6d,
};

function virtualKey(code: string): number {
  if (virtualKeys[code]) return virtualKeys[code];
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 0x60 + Number(code.slice(6));
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return 0x6f + Number(code.slice(1));
  throw new Error(`Unsupported browser key: ${code}`);
}

export function browserKeymap(keymap: Keymap | null): { command: string; key: number; modifiers: number[][]; repeat: boolean }[] {
  validateKeymap(keymap);
  const custom = Object.entries(keymap?.bindings ?? {});
  const inherited = Object.entries(defaultBindings).filter(([command]) => !(command in (keymap?.bindings ?? {})));
  const term = (keymap?.term ?? 'Menu').split('+');
  return [...custom, ...inherited].flatMap(([command, value]) => {
    if (command.startsWith('window.toggle_visibility') || command === 'window.show_gallery') return [];
    const bindings = typeof value === 'string' ? [value] : value || [];
    return bindings.map((binding) => {
      const parts = binding.split('+').flatMap((part) => part === 'term' ? term : [part]);
      const key = parts.pop()!;
      return { command, key: virtualKey(keyCode(key)), modifiers: parts.map((part) => modifierCodes[part].map(virtualKey)), repeat: command.startsWith('terminal.page_') || command.startsWith('workspace.scroll_') };
    });
  });
}

export function validateKeymap(keymap: Keymap | null): void {
  if (keymap === null) return;
  if (!keymap || typeof keymap.term !== 'string' || !keymap.bindings || typeof keymap.bindings !== 'object' || Array.isArray(keymap.bindings)) throw new Error('Invalid keymap');
  const term = keymap.term.split('+');
  if (!term.length || term.some((part) => !modifierCodes[part]) || new Set(term).size !== term.length) throw new Error('Invalid term modifier');
  const combinations = new Map<string, string>();
  const bindings = Object.entries(keymap.bindings);
  const inherited = Object.entries(defaultBindings).filter(([command]) => !(command in keymap.bindings));
  for (const [command, value] of [...bindings, ...inherited]) {
    if (!(command in defaultBindings)) throw new Error(`Unknown command: ${command}`);
    if (value === false) continue;
    const bindings = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(bindings) || bindings.some((binding) => typeof binding !== 'string')) throw new Error(`Invalid bindings for ${command}`);
    if (bindings.length === 0) continue;
    for (const binding of bindings) {
      const tokens = binding.split('+');
      const key = tokens.pop();
      if (!key || !/^(?:[A-Z0-9]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Arrow(?:Left|Right|Up|Down)|PageUp|PageDown|Home|End|Insert|Delete|Backspace|Tab|Enter|Escape|Space|Slash|Backslash|Quote|Comma|Period|Minus|Equal|Backquote|Numpad(?:Enter|Add|Subtract|[0-9]))$/.test(key)) throw new Error(`Invalid key in ${binding}`);
      const modifiers = tokens.flatMap((token) => token === 'term' ? term : [token]);
      if (modifiers.some((modifier) => !modifierCodes[modifier])) throw new Error(`Invalid modifier in ${binding}`);
      let expanded: string[][] = [[]];
      for (const modifier of modifiers) expanded = expanded.flatMap((parts) => modifierCodes[modifier].filter((code) => !parts.includes(code)).map((code) => [...parts, code]));
      if (!expanded.length) throw new Error(`Duplicate modifier in ${binding}`);
      for (const parts of expanded) {
        const signature = [...parts.sort(), keyCode(key)].join('+');
        const existing = combinations.get(signature);
        if (existing && existing !== command) throw new Error(`Conflicting bindings for ${existing} and ${command}`);
        combinations.set(signature, command);
      }
    }
  }
}

export function matchingCommand(keymap: Keymap | null, pressed: ReadonlySet<string>, code: string): string | null {
  const term = (keymap?.term ?? 'Menu').split('+');
  const custom = Object.entries(keymap?.bindings ?? {});
  const inherited = Object.entries(defaultBindings).filter(([command]) => !(command in (keymap?.bindings ?? {})));
  for (const [command, binding] of [...custom, ...inherited]) {
    const alternatives = typeof binding === 'string' ? [binding] : binding || [];
    for (const alternative of alternatives) {
      const parts = alternative.split('+').flatMap((part) => part === 'term' ? term : [part]);
      const last = parts.pop();
      if (!last || keyCode(last) !== code) continue;
      let matches: Set<string>[] = [new Set([code])];
      for (const part of parts) {
        matches = matches.flatMap((used) => (modifierCodes[part] ?? [keyCode(part)])
          .filter((candidate) => pressed.has(candidate) && !used.has(candidate))
          .map((candidate) => new Set([...used, candidate])));
      }
      if (matches.some((used) => [...pressed].every((key) => used.has(key)))) return command;
    }
  }
  return null;
}
