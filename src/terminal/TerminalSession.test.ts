import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocked.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { mocked.handlers.set(name, handler); return () => mocked.handlers.delete(name); }) }));

import { initialProfile, scrollToBottomOnKey, TerminalSession } from './TerminalSession';

describe('scrollToBottomOnKey', () => {
  it('keeps scrollback position for modifier and lock keys', () => {
    for (const key of ['Alt', 'AltGraph', 'CapsLock', 'Control', 'Fn', 'FnLock', 'Hyper', 'Meta', 'NumLock', 'OS', 'ScrollLock', 'Shift', 'Super', 'Symbol', 'SymbolLock']) {
      expect(scrollToBottomOnKey(key)).toBe(false);
    }
    expect(scrollToBottomOnKey('a')).toBe(true);
  });
});

describe('TerminalSession', () => {
  beforeEach(() => { mocked.invoke.mockReset(); mocked.handlers.clear(); mocked.invoke.mockResolvedValue('cmd.exe'); });

  it('routes events and commands by session id', async () => {
    const state = vi.fn(); const exited = vi.fn(); const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), state, exited, vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    expect(session.terminal!.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 17763 });
    session.setColorProfile({ id: 'lua:users', label: "User's", foreground: '#ffffff', background: '#000000', colors: ['#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa', '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff'] });
    expect(session.terminal!.options.theme).toMatchObject({ foreground: '#ffffff', background: '#000000', black: '#000000', brightWhite: '#ffffff' });
    expect(session.terminal!.options.theme?.extendedAnsi).toBeUndefined();
    const extendedColors = Array.from({ length: 240 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`);
    session.setColorProfile({ id: 'lua:colors256', label: '256 Colors', foreground: '#ffffff', background: '#000000', colors: [...Array(16).fill('#123456'), ...extendedColors] });
    expect(session.terminal!.options.theme?.extendedAnsi).toEqual(extendedColors);
    const write = vi.spyOn(session.terminal!, 'write');
    mocked.handlers.get('terminal-output')!({ payload: { sessionId: 'other', data: [65] } });
    mocked.handlers.get('terminal-output')!({ payload: { sessionId: session.id, data: [66] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(write).toHaveBeenCalledTimes(1);
    session.sendInput('dir\r'); session.resize({ cols: 81, rows: 24 });
    expect(mocked.invoke).toHaveBeenCalledWith('start_terminal', { sessionId: session.id, cols: 80, rows: 24 });
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: session.id, input: 'dir\r' });
    expect(mocked.invoke).toHaveBeenCalledWith('resize_terminal', { sessionId: session.id, cols: 81, rows: 24 });
    mocked.handlers.get('terminal-exit')!({ payload: { sessionId: 'other' } });
    expect(exited).not.toHaveBeenCalled();
    mocked.handlers.get('terminal-exit')!({ payload: { sessionId: session.id } });
    await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
    expect(session.live).toBe(false);
    session.dispose();
  });

  it('keeps input behind the native resize and coalesces pending sizes', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    mocked.invoke.mockClear();
    const resizeResolvers: (() => void)[] = [];
    mocked.invoke.mockImplementation((command: string) => command === 'resize_terminal'
      ? new Promise<void>((resolve) => resizeResolvers.push(resolve))
      : Promise.resolve('cmd.exe'));

    session.resize({ cols: 100, rows: 24 });
    session.resize({ cols: 120, rows: 24 });
    session.sendInput('echo keyboard\r');
    const input = session.sendAutomationInput({ kind: 'text', text: 'echo ready', submit: true });
    expect(mocked.invoke).toHaveBeenCalledWith('resize_terminal', { sessionId: session.id, cols: 100, rows: 24 });
    expect(mocked.invoke).not.toHaveBeenCalledWith('write_terminal', expect.anything());

    resizeResolvers[0]();
    await vi.waitFor(() => expect(resizeResolvers).toHaveLength(2));
    expect(mocked.invoke).not.toHaveBeenCalledWith('write_terminal', expect.anything());
    resizeResolvers[1]();
    await input;
    expect(mocked.invoke).toHaveBeenNthCalledWith(3, 'write_terminal', { sessionId: session.id, input: 'echo keyboard\r' });
    expect(mocked.invoke).toHaveBeenNthCalledWith(4, 'write_terminal', { sessionId: session.id, input: 'echo ready\r' });
    session.dispose();
  });

  it('normalizes automation key aliases and rejects unsupported names', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    mocked.invoke.mockClear();

    await session.sendAutomationInput({ kind: 'key', key: 'ESC' });
    await session.sendAutomationInput({ kind: 'key', key: 'UP' });
    expect(mocked.invoke).toHaveBeenNthCalledWith(1, 'write_terminal', { sessionId: session.id, input: '\x1b' });
    expect(mocked.invoke).toHaveBeenNthCalledWith(2, 'write_terminal', { sessionId: session.id, input: '\x1b[A' });

    session.win32InputMode = true;
    await session.sendAutomationInput({ kind: 'key', key: 'ARROW_UP' });
    expect(mocked.invoke).toHaveBeenNthCalledWith(3, 'write_terminal', { sessionId: session.id, input: '\x1b[38;72;0;1;0;1_\x1b[38;72;0;0;0;1_' });

    await expect(session.sendAutomationInput({ kind: 'key', key: 'F25' })).rejects.toThrow('unsupported terminal key: F25');
    expect(mocked.invoke).toHaveBeenCalledTimes(3);
    session.dispose();
  });

  it('queues repeated automation keys as one write', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    mocked.invoke.mockClear();

    await session.sendAutomationInput({ kind: 'key', key: 'ArrowDown', repeat: 3 });
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: session.id, input: '\x1b[B\x1b[B\x1b[B' });

    session.win32InputMode = true;
    await session.sendAutomationInput({ kind: 'key', key: 'ArrowUp', repeat: 2 });
    expect(mocked.invoke).toHaveBeenLastCalledWith('write_terminal', { sessionId: session.id, input: '\x1b[38;72;0;1;0;1_\x1b[38;72;0;0;0;1_\x1b[38;72;0;1;0;1_\x1b[38;72;0;0;0;1_' });

    await expect(session.sendAutomationInput({ kind: 'key', key: 'ArrowDown', repeat: 0 })).rejects.toThrow('terminal key repeat must be an integer from 1 to 100');
    session.dispose();
  });

  it('returns a readable live screen with separate style runs and opt-in scrollback', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 12, rows: 3 }, initialProfile('dos-vga'));
    await new Promise<void>((resolve) => session.terminal!.write('\x1b[1;31mRed\x1b[0m\r\nplain\r\nlast', resolve));

    const current = session.snapshot();
    expect(current.scrollback).toBeUndefined();
    expect(current.screen.lines.slice(0, 3)).toEqual(['Red', 'plain', 'last']);
    expect(current.screen.styles).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, startColumn: 0, endColumn: 3, bold: true, foreground: { mode: 'palette', index: 1 } }),
    ]));

    await new Promise<void>((resolve) => session.terminal!.write('\r\nolder\r\noldest\r\nnewest', resolve));
    const full = session.snapshot(true);
    expect(full.scrollback?.lines).toContain('oldest');
    expect(full.scrollback?.lines.slice(-3)).toEqual(['older', 'oldest', 'newest']);
    expect(full.screen.lines).toHaveLength(3);
    session.dispose();
  });

  it('encodes semantic TUI mouse actions and rejects disabled tracking', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    await expect(session.sendAutomationMouse({ action: 'press', button: 'primary', col: 2, row: 3 })).rejects.toThrow('mouse tracking is disabled');
    await new Promise<void>((resolve) => session.terminal!.write('\x1b[?1000h\x1b[?1006h', resolve));
    mocked.invoke.mockClear();
    await session.sendAutomationMouse({ action: 'click', button: 'primary', col: 2, row: 3 });
    await session.sendAutomationMouse({ action: 'wheel', direction: 'down', col: 2, row: 3, steps: 2 });
    expect(mocked.invoke).toHaveBeenNthCalledWith(1, 'write_terminal', { sessionId: session.id, input: '\x1b[<0;2;3M' });
    expect(mocked.invoke).toHaveBeenNthCalledWith(2, 'write_terminal', { sessionId: session.id, input: '\x1b[<0;2;3m' });
    expect(mocked.invoke).toHaveBeenNthCalledWith(3, 'write_terminal', { sessionId: session.id, input: '\x1b[<65;2;3M' });
    expect(mocked.invoke).toHaveBeenNthCalledWith(4, 'write_terminal', { sessionId: session.id, input: '\x1b[<65;2;3M' });
    session.dispose();
  });

  it('does not report a process lookup failure after the session exits', async () => {
    const onError = vi.fn();
    let rejectLookup!: (reason: Error) => void;
    mocked.invoke.mockImplementation((command: string) => command === 'active_terminal_process'
      ? new Promise((_, reject) => { rejectLookup = reject; })
      : Promise.resolve('cmd.exe'));
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', onError, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    mocked.handlers.get('terminal-exit')!({ payload: { sessionId: session.id } });
    rejectLookup(new Error('terminal is not running'));
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    session.dispose();
  });

  it('cleans up on start failure and allows retrying start', async () => {
    const onError = vi.fn();
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', onError, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    mocked.invoke.mockRejectedValueOnce(new Error('Spawn failed'));

    const firstResult = await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    expect(firstResult).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Spawn failed'));
    expect(session.terminal).toBeNull();
    expect(session.live).toBe(false);
    expect(mocked.handlers.size).toBe(0);

    // Subsequent start can retry and succeed
    mocked.invoke.mockResolvedValueOnce('cmd.exe');
    const secondResult = await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    expect(secondResult).toBe('cmd.exe');
    expect(session.terminal).not.toBeNull();
    expect(session.live).toBe(true);
    session.dispose();
  });

  it('runs dispose in finally on close and preserves invoke rejection', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    expect(session.terminal).not.toBeNull();

    const disposeSpy = vi.spyOn(session, 'dispose');
    mocked.invoke.mockRejectedValueOnce(new Error('Process kill failed'));

    await expect(session.close()).rejects.toThrow('Process kill failed');
    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(session.terminal).toBeNull();
    expect(session.live).toBe(false);
  });

  it('forwards OSC tab titles and shortens executable paths', async () => {
    const onTitle = vi.fn();
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), onTitle, vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    await new Promise<void>((resolve) => session.terminal!.write('\x1b]2;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile\x07', resolve));
    expect(onTitle).toHaveBeenCalledWith('powershell.exe');
    expect(session.title).toBe('powershell.exe');
    await new Promise<void>((resolve) => session.terminal!.write('\x1b]2;C:\\Projects | FAR Manager\x07', resolve));
    expect(onTitle).toHaveBeenLastCalledWith('C:\\Projects | FAR Manager');
    session.dispose();
  });

  it('uses DECSCUSR cursor appearance until reset restores the preset', async () => {
    const onCursorStyleOverrideChange = vi.fn();
    const onCursorStyleChange = vi.fn();
    const onAutomationStateChange = vi.fn();
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), onCursorStyleOverrideChange, onCursorStyleChange, onAutomationStateChange);
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    session.setCursorAppearance('underline', false);
    const write = (data: string) => new Promise<void>((resolve) => session.terminal!.write(data, resolve));

    await write('\x1b[5 q');
    expect(session.cursorStyleOverridden).toBe(true);
    expect(onCursorStyleOverrideChange).toHaveBeenLastCalledWith(true);
    expect(onCursorStyleChange).toHaveBeenLastCalledWith('bar');
    expect(session.applicationCursorState).toEqual({ shape: 'bar', blink: true, visible: true });
    expect(session.terminal!.options.cursorStyle).toBe('bar');
    expect(session.terminal!.options.cursorBlink).toBe(true);
    await write('\x1b[6 q');
    expect(session.terminal!.options.cursorBlink).toBe(false);
    expect(session.applicationCursorState).toEqual({ shape: 'bar', blink: false, visible: true });
    await write('\x1b[9 q');
    expect(session.applicationCursorState).toEqual({ shape: 'unknown', blink: null, visible: true });
    expect(session.terminal!.options.cursorStyle).toBe('bar');
    await write('\x1b[?25l\x1b[5 q\x1bc');
    expect(session.cursorStyleOverridden).toBe(false);
    expect(onCursorStyleOverrideChange).toHaveBeenLastCalledWith(false);
    expect(onCursorStyleChange).toHaveBeenLastCalledWith(null);
    expect(session.terminal!.options.cursorStyle).toBe('underline');
    expect(session.terminal!.options.cursorBlink).toBe(false);
    expect(session.applicationCursorState).toEqual({ shape: null, blink: null, visible: true });
    await write('\x1b[5 q');
    await write('\x1b[0 q');
    expect(session.cursorStyleOverridden).toBe(false);
    expect(session.terminal!.options.cursorStyle).toBe('underline');
    expect(session.terminal!.options.cursorBlink).toBe(false);
    expect(onCursorStyleChange).toHaveBeenLastCalledWith(null);
    expect(session.applicationCursorState).toEqual({ shape: null, blink: null, visible: true });
    expect(onAutomationStateChange).toHaveBeenCalled();
    session.dispose();
  });

  it('keeps unsupported DECSCUSR from hiding presets or replacing an effective application override', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    const write = (data: string) => new Promise<void>((resolve) => session.terminal!.write(data, resolve));

    await write('\x1b[9 q');
    expect(session.applicationCursorState).toEqual({ shape: 'unknown', blink: null, visible: true });
    expect(session.cursorStyleOverridden).toBe(false);
    session.setCursorAppearance('underline', false);
    expect(session.terminal!.options.cursorStyle).toBe('underline');
    expect(session.terminal!.options.cursorBlink).toBe(false);

    await write('\x1b[5 q');
    expect(session.cursorStyleOverridden).toBe(true);
    expect(session.terminal!.options.cursorStyle).toBe('bar');
    await write('\x1b[9 q');
    expect(session.applicationCursorState).toEqual({ shape: 'unknown', blink: null, visible: true });
    expect(session.cursorStyleOverridden).toBe(true);
    session.setCursorAppearance('underline', true);
    expect(session.terminal!.options.cursorStyle).toBe('bar');
    expect(session.terminal!.options.cursorBlink).toBe(true);
    session.dispose();
  });

  it('tracks DEC cursor visibility without consuming private-mode sequences', async () => {
    const onAutomationStateChange = vi.fn();
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), onAutomationStateChange);
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    session.setCursorAppearance('underline', false);
    const write = (data: string) => new Promise<void>((resolve) => session.terminal!.write(data, resolve));
    expect(session.applicationCursorState).toEqual({ shape: null, blink: null, visible: true });

    await write('\x1b[?1;25l');
    expect(session.applicationCursorState.visible).toBe(false);
    expect(session.sgrMouseMode).toBe(false);
    const afterHide = onAutomationStateChange.mock.calls.length;
    await write('\x1b[?25l');
    expect(onAutomationStateChange).toHaveBeenCalledTimes(afterHide);

    await write('\x1b[?1006h');
    expect(session.applicationCursorState.visible).toBe(false);
    expect(session.sgrMouseMode).toBe(true);
    await write('\x1b[?25;1006h');
    expect(session.applicationCursorState.visible).toBe(true);
    expect(session.sgrMouseMode).toBe(true);
    await write('\x1b[6 q\x1b[!p');
    expect(session.applicationCursorState).toEqual({ shape: null, blink: null, visible: true });
    expect(session.terminal!.options.cursorStyle).toBe('underline');
    expect(session.terminal!.options.cursorBlink).toBe(false);
    await write('\x1b[?1006l');
    expect(session.applicationCursorState.visible).toBe(true);
    expect(session.sgrMouseMode).toBe(false);
    session.dispose();
  });

  it('reports focus only when the application enables focus reporting', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    const write = (data: string) => new Promise<void>((resolve) => session.terminal!.write(data, resolve));
    mocked.invoke.mockClear();

    session.setTerminalFocused(true);
    expect(session.terminal!.modes.sendFocusMode).toBe(false);
    expect(mocked.invoke).not.toHaveBeenCalled();

    await write('\x1b[?1004h');
    expect(session.terminal!.modes.sendFocusMode).toBe(true);
    await vi.waitFor(() => expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: session.id, input: '\x1b[I' }));

    mocked.invoke.mockClear();
    session.setTerminalFocused(false);
    session.setTerminalFocused(false);
    expect(mocked.invoke).toHaveBeenCalledOnce();
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: session.id, input: '\x1b[O' });

    await write('\x1b[?1004l');
    mocked.invoke.mockClear();
    session.setTerminalFocused(true);
    expect(mocked.invoke).not.toHaveBeenCalled();
    await write('\x1b[?1004h');
    await vi.waitFor(() => expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: session.id, input: '\x1b[I' }));

    session.dispose();
  });

  it('reports the current focus if focus reporting is enabled during startup', async () => {
    let resolveStart!: (shellName: string) => void;
    mocked.invoke.mockImplementation((command: string) => command === 'start_terminal'
      ? new Promise<string>((resolve) => { resolveStart = resolve; })
      : Promise.resolve('cmd.exe'));
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    const start = session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
    session.setTerminalFocused(true);
    await new Promise<void>((resolve) => session.terminal!.write('\x1b[?1004h', resolve));
    await Promise.resolve();
    expect(mocked.invoke).not.toHaveBeenCalledWith('write_terminal', expect.anything());

    resolveStart('cmd.exe');
    await start;
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: session.id, input: '\x1b[I' });
    session.dispose();
  });

  it('replaces the startup shell title with the active child process', async () => {
    const onProcessName = vi.fn();
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), onProcessName);
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'active_terminal_process' ? null : 'cmd.exe'));
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    await new Promise<void>((resolve) => session.terminal!.write('\x1b]2;cmd.exe\x07', resolve));
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'active_terminal_process' ? 'pwsh.exe' : 'cmd.exe'));
    Reflect.get(session, 'pollProcess').call(session);
    await Promise.resolve();
    expect(onProcessName).toHaveBeenCalledWith('pwsh.exe');
    session.dispose();
  });

  it('uses the launched executable when no child is observable and restores it after a child exits', async () => {
    let activeProcess: string | null = null;
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(
      command === 'start_terminal' ? 'hx.exe' : command === 'active_terminal_process' ? activeProcess : undefined,
    ));
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    await vi.waitFor(() => expect(session.localProcessName).toBe('hx.exe'));

    activeProcess = 'nvim.exe';
    Reflect.get(session, 'pollProcess').call(session);
    await vi.waitFor(() => expect(session.localProcessName).toBe('nvim.exe'));

    activeProcess = null;
    Reflect.get(session, 'pollProcess').call(session);
    await vi.waitFor(() => expect(session.localProcessName).toBe('hx.exe'));
    session.dispose();
  });

  it('preserves custom OSC title when child process changes', async () => {
    const onProcessName = vi.fn();
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), onProcessName);
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'active_terminal_process' ? 'cmd.exe' : 'cmd.exe'));
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    await new Promise<void>((resolve) => session.terminal!.write('\x1b]2;Custom Work App\x07', resolve));
    expect(session.title).toBe('Custom Work App');
    onProcessName.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'active_terminal_process' ? 'pwsh.exe' : 'cmd.exe'));
    Reflect.get(session, 'pollProcess').call(session);
    await Promise.resolve();
    expect(session.title).toBe('Custom Work App');
    expect(onProcessName).not.toHaveBeenCalled();
    session.dispose();
  });

  it('normalizes non-finite quietMs and timeoutMs in waitForOutput', async () => {
    vi.useFakeTimers();
    try {
      const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
      await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));

      const waitPromise = session.waitForOutput(0, NaN, NaN);

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await waitPromise;
      expect(result.timedOut).toBe(true);
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves scrollback position and reports no autoscroll when output arrives while not at bottom', async () => {
    const onOutput = vi.fn();
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), onOutput, vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    const terminal = session.terminal!;
    expect(terminal.options.scrollback).toBe(10000);

    // Fill buffer with enough lines so there's scrollback
    await new Promise<void>((resolve) => terminal.write(Array.from({ length: 50 }, (_, i) => `line ${i}\r\n`).join(''), resolve));
    terminal.scrollToTop();
    const initialViewportY = terminal.buffer.active.viewportY;
    expect(initialViewportY).toBe(0);
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);

    const scrollToBottomSpy = vi.spyOn(terminal, 'scrollToBottom');
    onOutput.mockClear();

    mocked.handlers.get('terminal-output')!({
      payload: { sessionId: session.id, data: Array.from(new TextEncoder().encode('new background line\r\n')) },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(scrollToBottomSpy).not.toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(0);
    expect(onOutput).toHaveBeenCalledWith({
      fromViewportY: 0,
      toViewportY: 0,
      autoScroll: false,
    });
    session.dispose();
  });

  it('reports autoscroll when output arrives while at bottom and viewport advances', async () => {
    const onOutput = vi.fn();
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), onOutput, vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    const terminal = session.terminal!;

    // Ensure we are at bottom
    terminal.scrollToBottom();
    const fromViewportY = terminal.buffer.active.viewportY;
    onOutput.mockClear();

    mocked.handlers.get('terminal-output')!({
      payload: { sessionId: session.id, data: Array.from(new TextEncoder().encode(Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join(''))) },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(onOutput).toHaveBeenCalledWith({
      fromViewportY,
      toViewportY: expect.any(Number),
      autoScroll: true,
    });
    expect(onOutput.mock.calls[0][0].toViewportY).toBeGreaterThan(fromViewportY);
    session.dispose();
  });

  it('batches output and yields between 16 KiB writes', async () => {
    const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    const write = vi.spyOn(session.terminal!, 'write');
    const data = Array.from({ length: 20 * 1024 }, () => 0x78);

    mocked.handlers.get('terminal-output')!({ payload: { sessionId: session.id, data } });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));

    expect(write.mock.calls[0][0]).toHaveLength(16 * 1024);
    expect(write.mock.calls[1][0]).toHaveLength(4 * 1024);
    session.dispose();
  });
});
