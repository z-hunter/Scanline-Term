import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchTerminalTool, normalizeTerminalInput, normalizeTerminalMouse } from './terminal-automation';

afterEach(() => vi.unstubAllGlobals());

describe('terminal automation dispatcher', () => {
  it('captures bounded timed frames and returns partial results on timeout', async () => {
    vi.useFakeTimers();
    try {
      let sequence = 0;
      const session = { snapshot: vi.fn(() => ({ status: 'running', sequence: sequence++ })) };
      const capture = dispatchTerminalTool(session as never, 'capture_terminal_frames', { count: 3, intervalMs: 100, timeoutMs: 150 });
      await vi.advanceTimersByTimeAsync(150);
      expect(await capture).toMatchObject({ status: 'timeout', collected: 2, frames: [{ snapshot: { sequence: 0 } }, { snapshot: { sequence: 1 } }] });
      await expect(dispatchTerminalTool(session as never, 'capture_terminal_frames', { count: 21, intervalMs: 100, timeoutMs: 500 })).rejects.toThrow('count');
    } finally { vi.useRealTimers(); }
  });
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
      waitForOutput: vi.fn(async () => ({ snapshot: { sequence: 5 }, status: 'updated', timedOut: false })),
      sendAutomationInput: vi.fn(async () => ({ status: 'queued', kind: 'text', bytesQueued: 4 })),
      sendAutomationMouse: vi.fn(async () => undefined),
    };
    await dispatchTerminalTool(session as never, 'observe_terminal', { includeScrollback: true });
    expect(await dispatchTerminalTool(session as never, 'observe_terminal', { includeScrollback: true })).toMatchObject({ status: 'snapshot', timedOut: false });
    expect(await dispatchTerminalTool(session as never, 'send_terminal_input', { action: { kind: 'text', text: 'dir', submit: true } })).toMatchObject({ result: { status: 'queued', kind: 'text', bytesQueued: 4 }, observation: { status: 'updated' } });
    await dispatchTerminalTool(session as never, 'send_terminal_mouse', { action: { action: 'click', button: 'primary', col: 2, row: 3 } });
    expect(session.snapshot).toHaveBeenCalledWith({});
    expect(session.sendAutomationInput).toHaveBeenCalledWith({ kind: 'text', text: 'dir', submit: true });
    expect(session.sendAutomationMouse).toHaveBeenCalledWith(expect.objectContaining({ action: 'click', button: 'primary' }));
  });

  it('pastes clipboard text into only the routed session without returning it', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'first line\r\nsecond line\n') } });
    const session = { snapshot: vi.fn(() => ({ sequence: 0 })), waitForOutput: vi.fn(async () => ({ snapshot: { sequence: 1 }, status: 'updated', timedOut: false })), sendAutomationInput: vi.fn(async () => ({ status: 'queued', kind: 'text', bytesQueued: 6 })) };

    const result = await dispatchTerminalTool(session as never, 'paste_terminal_clipboard', {});

    expect(session.sendAutomationInput).toHaveBeenCalledWith({ kind: 'text', text: 'first line\r\nsecond line\n' });
    expect(result).toMatchObject({ result: 'Clipboard text pasted.', observation: { status: 'updated' } });
  });

  it('routes text and key aliases through structured input receipts', async () => {
    const session = { snapshot: vi.fn(() => ({ sequence: 0 })), waitForOutput: vi.fn(async () => ({ snapshot: { sequence: 0 }, status: 'timeout', timedOut: true })), sendAutomationInput: vi.fn(async (action) => ({ status: action.kind === 'text' && !action.text ? 'no_input' : 'queued', kind: action.kind, bytesQueued: action.text?.length ?? 3 })) };
    expect(await dispatchTerminalTool(session as never, 'send_text', { text: 'hi', submit: true })).toMatchObject({ result: { status: 'queued', kind: 'text', bytesQueued: 2 }, observation: { status: 'timeout', timedOut: true } });
    expect(await dispatchTerminalTool(session as never, 'press_key', { key: 'ENTER' })).toMatchObject({ result: { status: 'queued', kind: 'key', bytesQueued: 3 } });
  });

  it('uses bracketed paste only when the terminal mode is active', async () => {
    const session = {
      terminal: { modes: { bracketedPasteMode: true } },
      win32InputMode: false,
      snapshot: vi.fn(() => ({ sequence: 0 })),
      waitForOutput: vi.fn(async () => ({ snapshot: { sequence: 1 }, status: 'updated', timedOut: false })),
      sendAutomationInput: vi.fn(async () => ({ status: 'queued', kind: 'paste', bytesQueued: 11 })),
    };
    const result = await dispatchTerminalTool(session as never, 'paste_text', { text: 'hello' });
    expect(session.sendAutomationInput).toHaveBeenCalledWith({ kind: 'paste', text: 'hello' });
    expect(result).toMatchObject({ result: { status: 'queued', kind: 'paste', bytesQueued: 11 }, observation: { status: 'updated' } });
    expect(await dispatchTerminalTool(session as never, 'paste_text', { text: '' })).toMatchObject({ result: { status: 'no_input', kind: 'paste', bytesQueued: 0 } });
    for (const text of ['x\x1b[201~', 'x\x9b201~', 'x\x00']) {
      await expect(dispatchTerminalTool(session as never, 'paste_text', { text })).rejects.toThrow('unsupported control characters');
    }
    expect(await dispatchTerminalTool(session as never, 'paste_text', { text: 'first\r\nsecond\nthird' })).toMatchObject({ result: { status: 'queued', kind: 'paste', bytesQueued: 11 } });
    expect(session.sendAutomationInput).toHaveBeenLastCalledWith({ kind: 'paste', text: 'first\rsecond\rthird' });
    session.terminal.modes.bracketedPasteMode = false;
    await expect(dispatchTerminalTool(session as never, 'paste_text', { text: 'hello' })).rejects.toThrow('bracketed paste mode is disabled');
  });
});
