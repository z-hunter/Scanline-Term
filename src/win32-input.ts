type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'shiftKey'> & Partial<Pick<KeyboardEvent, 'getModifierState' | 'keyCode'>>;

type Win32Key = readonly [virtualKey: number, scanCode: number];

const keys: Record<string, Win32Key> = {
  Escape: [0x1b, 0x01], Backspace: [0x08, 0x0e], Tab: [0x09, 0x0f], Enter: [0x0d, 0x1c], Space: [0x20, 0x39],
  Minus: [0xbd, 0x0c], Equal: [0xbb, 0x0d], BracketLeft: [0xdb, 0x1a], BracketRight: [0xdd, 0x1b], Backslash: [0xdc, 0x2b],
  Semicolon: [0xba, 0x27], Quote: [0xde, 0x28], Backquote: [0xc0, 0x29], Comma: [0xbc, 0x33], Period: [0xbe, 0x34], Slash: [0xbf, 0x35], IntlBackslash: [0xe2, 0x56],
  CapsLock: [0x14, 0x3a], NumLock: [0x90, 0x45], ScrollLock: [0x91, 0x46], PrintScreen: [0x2c, 0x37], Pause: [0x13, 0x45],
  Insert: [0x2d, 0x52], Delete: [0x2e, 0x53], Home: [0x24, 0x47], End: [0x23, 0x4f], PageUp: [0x21, 0x49], PageDown: [0x22, 0x51],
  ArrowUp: [0x26, 0x48], ArrowDown: [0x28, 0x50], ArrowLeft: [0x25, 0x4b], ArrowRight: [0x27, 0x4d],
  ShiftLeft: [0x10, 0x2a], ShiftRight: [0x10, 0x36], ControlLeft: [0x11, 0x1d], ControlRight: [0x11, 0x1d], AltLeft: [0x12, 0x38], AltRight: [0x12, 0x38],
  MetaLeft: [0x5b, 0x5b], MetaRight: [0x5c, 0x5c], ContextMenu: [0x5d, 0x5d],
  Numpad0: [0x60, 0x52], Numpad1: [0x61, 0x4f], Numpad2: [0x62, 0x50], Numpad3: [0x63, 0x51], Numpad4: [0x64, 0x4b],
  Numpad5: [0x65, 0x4c], Numpad6: [0x66, 0x4d], Numpad7: [0x67, 0x47], Numpad8: [0x68, 0x48], Numpad9: [0x69, 0x49],
  NumpadMultiply: [0x6a, 0x37], NumpadAdd: [0x6b, 0x4e], NumpadSubtract: [0x6d, 0x4a], NumpadDecimal: [0x6e, 0x53], NumpadDivide: [0x6f, 0x35], NumpadEnter: [0x0d, 0x1c],
};

const letterScans = [0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c];
const digitScans = [0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a];
const functionScans = [0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76];

function keyInfo(event: KeyEvent): Win32Key {
  const named = keys[event.code];
  if (named) return named;
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter) {
    const index = letter[1].charCodeAt(0) - 65;
    return [0x41 + index, letterScans[index]];
  }
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) return [0x30 + Number(digit[1]), digitScans[Number(digit[1])]];
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.code);
  if (functionKey) {
    const index = Number(functionKey[1]) - 1;
    return [0x70 + index, functionScans[index]];
  }
  return [event.keyCode ?? 0, 0];
}

function controlState(event: KeyEvent): number {
  let state = 0;
  if (event.ctrlKey) state |= event.code === 'ControlRight' ? 0x04 : 0x08;
  if (event.altKey) state |= event.code === 'AltRight' ? 0x01 : 0x02;
  if (event.shiftKey) state |= 0x10;
  if (event.getModifierState?.('CapsLock')) state |= 0x80;
  if (event.getModifierState?.('NumLock')) state |= 0x20;
  if (event.getModifierState?.('ScrollLock')) state |= 0x40;
  return state;
}

function unicodeCharacter(event: KeyEvent): number {
  const control = ({ Enter: 0x0d, NumpadEnter: 0x0d, Tab: 0x09, Backspace: 0x08, Escape: 0x1b } as Record<string, number | undefined>)[event.code];
  if (control !== undefined) return control;
  if (event.ctrlKey && event.key.length === 1) {
    const key = event.key.toUpperCase();
    if (key === ' ' || event.code === 'Digit2') return 0;
    if (key === '?') return 0x7f;
    const code = key.charCodeAt(0);
    return code >= 64 && code <= 95 ? code - 64 : code;
  }
  return event.key.length === 1 ? event.key.charCodeAt(0) : 0;
}

/** Encodes the Win32 Input Mode wire format expected by ConPTY. */
export function win32InputKey(event: KeyEvent, keyDown: boolean): string {
  const [virtualKey, scanCode] = keyInfo(event);
  return `\x1b[${virtualKey};${scanCode};${unicodeCharacter(event)};${Number(keyDown)};${controlState(event)};1_`;
}
