import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchTerminalTool, normalizeTerminalInput, normalizeTerminalMouse } from './terminal-automation';

afterEach(() => vi.unstubAllGlobals());

describe('terminal automation dispatcher', () => {
  it('normalizes the existing flexible keyboard contract', () => {
    expect(normalizeTerminalInput({ type: 'key', key: 'ESC', repeat: 2 })).toEqual({ kind: 'key', key: 'ESC', repeat: 2, ctrl: undefined, alt: undefined, shift: undefined });
    expect(normalizeTerminalInput({ text: 'dir', submit: true })).toEqual({ kind: 'text', text: 'dir', submit: true });
  });

  it('validates semantic mouse actions', () => {
    expect(normalizeTerminalMouse({ action: 'wheel', direction: 'down', col: 4, row: 2, steps: 3 })).toEqual({ action: 'wheel', direction: 'down', col: 4, row: 2, steps: 3, ctrl: undefined, alt: undefined, shift: undefined });
    expect(() => normalizeTerminalMouse({ action: 'press', button: 'middle', col: 1, row: 1 })).toThrow('primary or secondary');
  });

  it('routes observe, keyboard and mouse calls through one session', async () => {
    const session = {
      snapshot: vi.fn(() => ({ sequence: 4 })),
      waitForOutput: vi.fn(async () => ({ snapshot: { sequence: 5 }, timedOut: false })),
      sendAutomationInput: vi.fn(async () => undefined),
      sendAutomationMouse: vi.fn(async () => undefined),
    };
    await dispatchTerminalTool(session as never, 'observe_terminal', { includeScrollback: true });
    await dispatchTerminalTool(session as never, 'send_terminal_input', { action: { kind: 'text', text: 'dir', submit: true } });
    await dispatchTerminalTool(session as never, 'send_terminal_mouse', { action: { action: 'click', button: 'primary', col: 2, row: 3 } });
    expect(session.snapshot).toHaveBeenCalledWith(true);
    expect(session.sendAutomationInput).toHaveBeenCalledWith({ kind: 'text', text: 'dir', submit: true });
    expect(session.sendAutomationMouse).toHaveBeenCalledWith(expect.objectContaining({ action: 'click', button: 'primary' }));
  });

  it('pastes clipboard text into only the routed session without returning it', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'first line\r\nsecond line\n') } });
    const session = { sendInput: vi.fn() };

    const result = await dispatchTerminalTool(session as never, 'paste_terminal_clipboard', {});

    expect(session.sendInput).toHaveBeenCalledWith('first line\r\nsecond line\n');
    expect(result).toBe('Clipboard text pasted.');
  });
});
