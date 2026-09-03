import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.hoisted(() => ({
  invoke: vi.fn(),
  mockCloseWindow: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: mocked.invoke,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: mocked.mockCloseWindow }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { mocked.handlers.set(name, handler); return () => mocked.handlers.delete(name); }),
}));

import { DEFAULT_CRT_SETTINGS, RESOLUTIONS } from '../crt/settings';
import { TerminalSession } from './TerminalSession';
import { adjacentTabId, tabIdAtOrdinal, useTerminal, type TerminalTab } from './useTerminal';

const tabs: TerminalTab[] = [
  { id: 'one', ordinal: 1, title: '1. cmd.exe', status: 'running', background: '#000000', foreground: '#ffffff' },
  { id: 'two', ordinal: 2, title: '2. cmd.exe', status: 'running', background: '#000000', foreground: '#ffffff' },
  { id: 'three', ordinal: 3, title: '3. cmd.exe', status: 'running', background: '#000000', foreground: '#ffffff' },
];

describe('adjacentTabId', () => {
  it('selects the right neighbor, then the left, when closing a tab', () => {
    expect(adjacentTabId(tabs, 'two')).toBe('three');
    expect(adjacentTabId(tabs, 'three')).toBe('two');
    expect(adjacentTabId([tabs[0]], 'one')).toBeNull();
  });
});

describe('tabIdAtOrdinal', () => {
  it('maps Menu+digit ordinals to tabs', () => {
    expect(tabIdAtOrdinal(tabs, 2)).toBe('two');
    expect(tabIdAtOrdinal([tabs[0], tabs[2]], 3)).toBe('three');
    expect(tabIdAtOrdinal(tabs, 9)).toBeNull();
  });
});

describe('terminal launch event', () => {
  it('starts a new session with the command and working directory from -T', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));
    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], onError, onToggleSettings });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { mocked.handlers.get('terminal-launch')!({ payload: { command: 'pwsh', cwd: 'C:\\Windows' } }); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(hookResult.tabs).toHaveLength(2);
    expect(mocked.invoke).toHaveBeenCalledWith('start_terminal', expect.objectContaining({ launch: { command: 'pwsh', cwd: 'C:\\Windows' } }));
    await act(async () => { root.unmount(); });
    container.remove(); vi.restoreAllMocks();
  });

  it('safely ignores DOM event arguments passed to openSession from onClick handlers', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));
    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], onError, onToggleSettings });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    const circular: Record<string, unknown> = { nativeEvent: {} };
    circular.self = circular;

    await act(async () => {
      hookResult.openSession(circular as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const startTerminalCalls = mocked.invoke.mock.calls.filter((call) => call[0] === 'start_terminal');
    expect(startTerminalCalls.length).toBe(2);
    expect(startTerminalCalls[1][1]).toEqual(expect.not.objectContaining({ launch: circular }));
    await act(async () => { root.unmount(); });
    container.remove(); vi.restoreAllMocks();
  });
});

describe('useTerminal closeSession concurrent closures', () => {
  it('serializes final-session decision when two tabs close before either session.close resolves', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    mocked.mockCloseWindow.mockReset();

    const closeResolvers: Array<() => void> = [];
    vi.spyOn(TerminalSession.prototype, 'close').mockImplementation(() => {
      return new Promise<void>((resolve) => {
        closeResolvers.push(resolve);
      });
    });

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => {
        hookResult = result;
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    // Wait for the initial openSession (scheduled via setTimeout)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Open a second session
    await act(async () => {
      hookResult.openSession();
    });

    // Wait for the second session.start promise to resolve so status becomes 'running'
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(hookResult.tabs.length).toBe(2);
    const tab1Id = hookResult.tabs[0].id;
    const tab2Id = hookResult.tabs[1].id;

    // Concurrently close both tabs before either session.close resolves
    let closePromise1!: Promise<void>;
    let closePromise2!: Promise<void>;
    await act(async () => {
      closePromise1 = hookResult.closeSession(tab1Id);
      closePromise2 = hookResult.closeSession(tab2Id);
    });

    expect(closeResolvers.length).toBe(2);
    expect(mocked.mockCloseWindow).not.toHaveBeenCalled();

    // Resolve the first session.close
    await act(async () => {
      closeResolvers[0]();
      await closePromise1;
    });

    // App should NOT close yet because tab 2 is still a managed session
    expect(mocked.mockCloseWindow).not.toHaveBeenCalled();

    // Resolve the second session.close
    await act(async () => {
      closeResolvers[1]();
      await closePromise2;
    });

    // Exactly one closure observed the final managed session and closed the window
    expect(mocked.mockCloseWindow).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('marks tab as failed and selects live replacement when session.close fails', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    mocked.mockCloseWindow.mockReset();

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => {
        hookResult = result;
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      hookResult.openSession();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(hookResult.tabs.length).toBe(2);
    const tab1Id = hookResult.tabs[0].id;
    const tab2Id = hookResult.tabs[1].id;

    // Make tab 2 close fail
    vi.spyOn(TerminalSession.prototype, 'close').mockRejectedValueOnce(new Error('Kill process failed'));

    await act(async () => {
      await hookResult.closeSession(tab2Id);
    });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Kill process failed'));
    expect(hookResult.tabs.find((t) => t.id === tab2Id)?.status).toBe('failed');
    expect(hookResult.activeSessionId).toBe(tab1Id);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('reports errors through teardown-safe sink when session.close rejects during unmount', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    mocked.mockCloseWindow.mockReset();

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    vi.spyOn(TerminalSession.prototype, 'close').mockRejectedValueOnce(new Error('Teardown close failed'));

    await act(async () => {
      root.unmount();
    });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Teardown close failed'));
    container.remove();
    vi.restoreAllMocks();
  });

  it('marks tab as exited and preserves session buffer when terminal-exit fires', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    mocked.mockCloseWindow.mockReset();
    mocked.handlers.clear();

    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => {
        hookResult = result;
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(hookResult.tabs.length).toBe(1);
    const sessionId = hookResult.tabs[0].id;
    const closeSpy = vi.spyOn(TerminalSession.prototype, 'close');

    await act(async () => {
      mocked.handlers.get('terminal-exit')!({ payload: { sessionId } });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(hookResult.tabs.length).toBe(1);
    expect(hookResult.tabs[0].status).toBe('exited');
    expect(closeSpy).not.toHaveBeenCalled();
    expect(hookResult.live).toBe(false);

    await act(async () => {
      await hookResult.closeSession(sessionId);
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('skips startup completion and error handling if initial launch effect cleanup runs first', async () => {
    let rejectLaunch!: (err: Error) => void;
    mocked.invoke.mockImplementation((command: string) => {
      if (command === 'initial_terminal_launch') {
        return new Promise((_, reject) => {
          rejectLaunch = reject;
        });
      }
      return Promise.resolve('cmd.exe');
    });

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    function TestComponent() {
      useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      root.unmount();
    });

    await act(async () => {
      rejectLaunch(new Error('Spawn failed after unmount'));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('Could not read startup arguments'));

    container.remove();
    vi.restoreAllMocks();
  });
});
