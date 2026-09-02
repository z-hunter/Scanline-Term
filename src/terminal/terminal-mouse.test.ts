import { describe, expect, it } from 'vitest';
import { terminalMouse } from './terminal-mouse';

const event = { col: 10, row: 5, ctrlKey: false, altKey: false, shiftKey: false };

describe('terminal mouse encoding', () => {
  it('encodes SGR clicks, releases and wheel input', () => {
    expect(terminalMouse({ ...event, action: 'press', button: 0, sgr: true })).toBe('\x1b[<0;10;5M');
    expect(terminalMouse({ ...event, action: 'release', button: 2, sgr: true })).toBe('\x1b[<2;10;5m');
    expect(terminalMouse({ ...event, action: 'wheel-down', sgr: true, ctrlKey: true })).toBe('\x1b[<81;10;5M');
  });

  it('falls back to legacy X10 reporting', () => {
    expect(terminalMouse({ ...event, action: 'press', button: 2, sgr: false })).toBe('\x1b[M"*%');
  });

  it('uses no button for mouse movement without a pressed button', () => {
    expect(terminalMouse({ ...event, action: 'move', sgr: true })).toBe('\x1b[<35;10;5M');
  });
});
