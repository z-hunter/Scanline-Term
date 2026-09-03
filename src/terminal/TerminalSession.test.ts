import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocked.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { mocked.handlers.set(name, handler); return () => mocked.handlers.delete(name); }) }));

import { TerminalSession } from './TerminalSession';
import { initialProfile } from './TerminalSession';

describe('TerminalSession', () => {
  beforeEach(() => { mocked.invoke.mockReset(); mocked.handlers.clear(); mocked.invoke.mockResolvedValue('cmd.exe'); });

  it('routes events and commands by session id', async () => {
    const state = vi.fn(); const exited = vi.fn(); const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), state, exited, vi.fn(), vi.fn(), vi.fn());
    await session.start({ cols: 80, rows: 24 }, initialProfile('dos-vga'));
    const write = vi.spyOn(session.terminal!, 'write');
    mocked.handlers.get('terminal-output')!({ payload: { sessionId: 'other', data: [65] } });
    mocked.handlers.get('terminal-output')!({ payload: { sessionId: session.id, data: [66] } });
    expect(write).toHaveBeenCalledTimes(1);
    session.sendInput('dir\r'); session.resize({ cols: 81, rows: 24 });
    expect(mocked.invoke).toHaveBeenCalledWith('start_terminal', { sessionId: session.id, cols: 80, rows: 24 });
    expect(mocked.invoke).toHaveBeenCalledWith('write_terminal', { sessionId: session.id, input: 'dir\r' });
    expect(mocked.invoke).toHaveBeenCalledWith('resize_terminal', { sessionId: session.id, cols: 81, rows: 24 });
    mocked.handlers.get('terminal-exit')!({ payload: { sessionId: 'other' } });
    expect(exited).not.toHaveBeenCalled();
    mocked.handlers.get('terminal-exit')!({ payload: { sessionId: session.id } });
    expect(exited).toHaveBeenCalledOnce();
    expect(session.live).toBe(false);
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
});
