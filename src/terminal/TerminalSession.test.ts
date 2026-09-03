import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocked.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { mocked.handlers.set(name, handler); return () => mocked.handlers.delete(name); }) }));

import { TerminalSession } from './TerminalSession';
import { initialProfile } from './TerminalSession';

describe('TerminalSession', () => {
  beforeEach(() => { mocked.invoke.mockReset(); mocked.handlers.clear(); mocked.invoke.mockResolvedValue('cmd.exe'); });

  it('routes events and commands by session id', async () => {
    const state = vi.fn(); const exited = vi.fn(); const session = new TerminalSession('5ed6dbb8-3ed9-459a-8aa3-3c7a9e6cb064', vi.fn(), state, exited);
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
});
