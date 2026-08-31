export type TerminalInputModes = {
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
};

type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

const functionKeys: Record<string, string> = {
  F1: 'OP', F2: 'OQ', F3: 'OR', F4: 'OS',
  F5: '[15~', F6: '[17~', F7: '[18~', F8: '[19~', F9: '[20~', F10: '[21~', F11: '[23~', F12: '[24~',
  F13: '[25~', F14: '[26~', F15: '[28~', F16: '[29~', F17: '[31~', F18: '[32~', F19: '[33~', F20: '[34~',
  F21: '[42~', F22: '[43~', F23: '[44~', F24: '[45~',
};

const keypadKeys: Record<string, string> = {
  Numpad0: 'p', Numpad1: 'q', Numpad2: 'r', Numpad3: 's', Numpad4: 't',
  Numpad5: 'u', Numpad6: 'v', Numpad7: 'w', Numpad8: 'x', Numpad9: 'y',
  NumpadDecimal: 'n', NumpadDivide: 'o', NumpadMultiply: 'j', NumpadSubtract: 'm', NumpadAdd: 'k', NumpadEnter: 'M',
};

function modifier(event: KeyEvent): number {
  return 1 + Number(event.shiftKey) + Number(event.altKey) * 2 + Number(event.ctrlKey) * 4;
}

function controlCharacter(event: KeyEvent): string | null {
  if (event.key === ' ' || event.code === 'Digit2') return '\0';
  if (event.key === '?') return '\x7f';
  if (event.key.length !== 1) return null;
  const code = event.key.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
}

export function terminalKey(event: KeyEvent, modes: TerminalInputModes): string | null {
  if (event.metaKey) return null;
  const mod = modifier(event);
  const functionKey = functionKeys[event.key];
  if (functionKey) {
    if (mod === 1) return `\x1b${functionKey}`;
    return functionKey.startsWith('O')
      ? `\x1b[1;${mod}${functionKey[1]}`
      : `\x1b[${functionKey.slice(1, -1)};${mod}~`;
  }
  if (modes.applicationKeypadMode && keypadKeys[event.code]) return `\x1bO${keypadKeys[event.code]}`;

  const cursorKey = ({ ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' } as Record<string, string | undefined>)[event.key];
  if (cursorKey) {
    if (mod === 1) return `\x1b${modes.applicationCursorKeysMode ? 'O' : '['}${cursorKey}`;
    return `\x1b[1;${mod}${cursorKey}`;
  }
  const tildeKey = ({ Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 } as Record<string, number | undefined>)[event.key];
  if (tildeKey) return `\x1b[${tildeKey}${mod === 1 ? '' : `;${mod}`}~`;

  if (event.key === 'Pause') return '\x1a';
  if (event.key === 'Escape') return '\x1b';
  if (event.key === 'Backspace') return '\x7f';
  if (event.key === 'Tab') return event.shiftKey ? '\x1b[Z' : '\t';
  if (event.key === 'Enter') return event.altKey ? '\x1b\r' : '\r';

  const character = event.ctrlKey ? controlCharacter(event) : event.key.length === 1 ? event.key : null;
  if (!character) return null;
  return event.altKey ? `\x1b${character}` : character;
}
