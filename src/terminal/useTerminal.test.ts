import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.hoisted(() => ({
  invoke: vi.fn(),
  mockCloseWindow: vi.fn(),
  mockSetFullscreen: vi.fn(),
  mockIsFullscreen: vi.fn().mockResolvedValue(false),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: mocked.invoke,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: mocked.mockCloseWindow,
    setFullscreen: mocked.mockSetFullscreen,
    isFullscreen: mocked.mockIsFullscreen,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { mocked.handlers.set(name, handler); return () => mocked.handlers.delete(name); }),
}));

import { DEFAULT_CRT_SETTINGS, RESOLUTIONS } from '../crt/settings';
import { terminalSession, TerminalSession } from './TerminalSession';
import { adjacentTabId, nextTabId, previousActiveTabId, previousTabId, renumberTabs, tabIdAtOrdinal, useTerminal, type TerminalTab } from './useTerminal';
import { win32InputKey } from '../win32-input';

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

describe('nextTabId', () => {
  it('cycles to the next tab and wraps around from last to first', () => {
    expect(nextTabId(tabs, 'one')).toBe('two');
    expect(nextTabId(tabs, 'two')).toBe('three');
    expect(nextTabId(tabs, 'three')).toBe('one');
  });

  it('returns null when there is only one tab or tabs are empty', () => {
    expect(nextTabId([tabs[0]], 'one')).toBeNull();
    expect(nextTabId([], 'one')).toBeNull();
  });

  it('returns null if active tab is not found', () => {
    expect(nextTabId(tabs, 'unknown')).toBeNull();
  });
});

describe('previousTabId', () => {
  it('cycles to the previous tab and wraps around from first to last', () => {
    expect(previousTabId(tabs, 'three')).toBe('two');
    expect(previousTabId(tabs, 'two')).toBe('one');
    expect(previousTabId(tabs, 'one')).toBe('three');
  });

  it('returns null when there is only one tab or tabs are empty', () => {
    expect(previousTabId([tabs[0]], 'one')).toBeNull();
    expect(previousTabId([], 'one')).toBeNull();
  });

  it('returns null if active tab is not found', () => {
    expect(previousTabId(tabs, 'unknown')).toBeNull();
  });
});

describe('previousActiveTabId', () => {
  it('returns the most recently used previous tab', () => {
    expect(previousActiveTabId(tabs, ['three', 'one', 'two'], 'three')).toBe('one');
    expect(previousActiveTabId(tabs, ['one', 'three', 'two'], 'one')).toBe('three');
  });

  it('skips tabs that are no longer in tabs list', () => {
    expect(previousActiveTabId([tabs[0], tabs[2]], ['three', 'two', 'one'], 'three')).toBe('one');
  });

  it('returns null if there is no previous tab in history', () => {
    expect(previousActiveTabId(tabs, ['one'], 'one')).toBeNull();
    expect(previousActiveTabId(tabs, [], 'one')).toBeNull();
  });
});

describe('tabIdAtOrdinal', () => {
  it('maps Menu+digit ordinals to tabs', () => {
    expect(tabIdAtOrdinal(tabs, 2)).toBe('two');
    expect(tabIdAtOrdinal([tabs[0], tabs[2]], 3)).toBe('three');
    expect(tabIdAtOrdinal(tabs, 9)).toBeNull();
  });
});

describe('renumberTabs', () => {
  it('reassigns ordinals and title prefixes after a tab is removed', () => {
    const remaining = renumberTabs([tabs[1], tabs[2]]);

    expect(remaining.map((tab) => ({ id: tab.id, ordinal: tab.ordinal, title: tab.title }))).toEqual([
      { id: 'two', ordinal: 1, title: '1. cmd.exe' },
      { id: 'three', ordinal: 2, title: '2. cmd.exe' },
    ]);
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
    await act(async () => { await hookResult.closeSession(hookResult.tabs[0].id); });
    expect(hookResult.tabs[0]).toMatchObject({ ordinal: 1, title: '1. cmd.exe' });
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
  it('removes the address modal when an unvisited browser tab closes', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], onError, onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { hookResult.openBrowser(); });
    const browserId = hookResult.activeTabId!;
    expect(hookResult.addressTabId).toBe(browserId);
    await act(async () => { hookResult.closeAddress(); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true })); });
    expect(hookResult.addressTabId).toBe(browserId);
    await act(async () => { await hookResult.closeSession(browserId); });
    expect(hookResult.addressTabId).toBeNull();
    expect(hookResult.tabs).toHaveLength(1);
    await act(async () => { root.unmount(); });
    container.remove(); vi.restoreAllMocks();
  });

  it('does not intercept KeyO in editable elements or host controls while allowing global F6', async () => {
    mocked.invoke.mockResolvedValue('cmd.exe');
    let hookResult!: ReturnType<typeof useTerminal>;
    const onError = vi.fn();
    function TestComponent() {
      const result = useTerminal({ settings: DEFAULT_CRT_SETTINGS, resolution: RESOLUTIONS[1], onError, onToggleSettings: vi.fn() });
      useEffect(() => { hookResult = result; });
      return null;
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { hookResult.openBrowser(); });
    const browserId = hookResult.activeTabId!;
    expect(hookResult.addressTabId).toBe(browserId);
    await act(async () => { hookResult.closeAddress(); });
    expect(hookResult.addressTabId).toBeNull();

    const input = document.createElement('input');
    container.appendChild(input);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true })); });
    expect(hookResult.addressTabId).toBeNull();

    const hostControl = document.createElement('div');
    hostControl.className = 'settings-panel';
    const hostButton = document.createElement('button');
    hostControl.appendChild(hostButton);
    container.appendChild(hostControl);
    await act(async () => { hostButton.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true })); });
    expect(hookResult.addressTabId).toBeNull();

    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true })); });
    expect(hookResult.addressTabId).toBe(browserId);

    await act(async () => { await hookResult.closeSession(browserId); });
    await act(async () => { root.unmount(); });
    container.remove(); vi.restoreAllMocks();
  });

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

  it('triggers onToggleAi on <menu-A> shortcut', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation(() => Promise.resolve('cmd.exe'));

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    const onToggleAi = vi.fn();

    function TestComponent() {
      useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
        onToggleAi,
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
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });

    expect(onToggleAi).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('switches between tabs on Menu+ArrowRight and Menu+ArrowLeft shortcuts', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation(() => Promise.resolve('cmd.exe'));

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    let hookResult!: ReturnType<typeof useTerminal>;

    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hookResult.tabs).toHaveLength(2);
    const tab1 = hookResult.tabs[0].id;
    const tab2 = hookResult.tabs[1].id;
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Period', key: '>', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Comma', key: '<', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('toggles between two tabs on Menu+Tab shortcut', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation(() => Promise.resolve('cmd.exe'));

    const onError = vi.fn();
    const onToggleSettings = vi.fn();
    let hookResult!: ReturnType<typeof useTerminal>;

    function TestComponent() {
      const result = useTerminal({
        settings: DEFAULT_CRT_SETTINGS,
        resolution: RESOLUTIONS[1],
        onError,
        onToggleSettings,
      });
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hookResult.tabs.length).toBeGreaterThanOrEqual(2);
    const tab1 = hookResult.tabs[0].id;
    const tab2 = hookResult.tabs[1].id;

    await act(async () => {
      hookResult.selectSession(tab1);
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      hookResult.selectSession(tab2);
    });
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab2);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
    });
    expect(hookResult.activeTabId).toBe(tab1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('resets fullscreen guard on window blur so later Enter keyup is not consumed', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));
    mocked.mockIsFullscreen.mockResolvedValue(false);
    mocked.mockSetFullscreen.mockResolvedValue(undefined);

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
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const activeId = hookResult.activeTabId!;
    const session = terminalSession(activeId);
    expect(session).toBeDefined();
    if (session) {
      session.win32InputMode = true;
    }

    const sendInputSpy = vi.spyOn(TerminalSession.prototype, 'sendInput');

    // Trigger Alt+Enter down to engage fullscreen guard; neither Alt event reaches Win32 input.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', altKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true }));
    });
    expect(mocked.mockSetFullscreen).toHaveBeenCalled();
    expect(sendInputSpy).not.toHaveBeenCalled();

    // Trigger blur without a preceding Enter keyup (e.g. focus transition on fullscreen toggle)
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    sendInputSpy.mockClear();

    // Later, an Enter keyup event is received in the terminal
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }));
    });

    // Fullscreen guard was cleared on blur, so the keyup event reaches the session instead of being consumed
    expect(sendInputSpy).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('sends matching Win32 Alt keyup on blur when replayed Alt was forwarded', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

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
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const activeId = hookResult.activeTabId!;
    const session = terminalSession(activeId);
    expect(session).toBeDefined();
    if (session) {
      session.win32InputMode = true;
    }

    const sendInputSpy = vi.spyOn(TerminalSession.prototype, 'sendInput');

    const altDown = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const keyA = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', altKey: true, bubbles: true, cancelable: true });

    // Press Alt (buffered), then press A (triggers replay of Alt, then forwards KeyA)
    await act(async () => {
      window.dispatchEvent(altDown);
      window.dispatchEvent(keyA);
    });

    const expectedAltDown = win32InputKey(altDown, true);
    expect(sendInputSpy).toHaveBeenCalledWith(expectedAltDown);

    sendInputSpy.mockClear();

    // Blur window before Alt keyup is received
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    const expectedAltUp = win32InputKey(altDown, false);
    expect(sendInputSpy).toHaveBeenCalledWith(expectedAltUp);

    // Subsequent blur does not send another keyup
    sendInputSpy.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(sendInputSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('does not suppress Alt when focus is on application controls or when no terminal session is active', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

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
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Create an application control (e.g. .settings-panel input)
    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'settings-panel';
    const settingsInput = document.createElement('input');
    settingsPanel.appendChild(settingsInput);
    container.appendChild(settingsPanel);
    settingsInput.focus();

    const altDown1 = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const altUp1 = new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });

    await act(async () => {
      settingsInput.dispatchEvent(altDown1);
      settingsInput.dispatchEvent(altUp1);
    });

    expect(altDown1.defaultPrevented).toBe(false);
    expect(altUp1.defaultPrevented).toBe(false);

    // Open browser tab so no terminal session is active
    await act(async () => {
      hookResult.openBrowser('https://example.com');
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Focus document body (terminal-eligible focus, but active tab is browser)
    document.body.focus();

    const altDown2 = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const altUp2 = new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(altDown2);
      window.dispatchEvent(altUp2);
    });

    expect(altDown2.defaultPrevented).toBe(false);
    expect(altUp2.defaultPrevented).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('sends Alt keyup to original session on keyup and blur even if focus or active tab has changed', async () => {
    mocked.handlers.clear();
    mocked.invoke.mockClear();
    mocked.invoke.mockImplementation((command: string) => Promise.resolve(command === 'initial_terminal_launch' ? {} : 'cmd.exe'));

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
      useEffect(() => { hookResult = result; });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(TestComponent));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      hookResult.openSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hookResult.tabs).toHaveLength(2);
    const tab1Id = hookResult.tabs[0].id;
    const tab2Id = hookResult.tabs[1].id;

    await act(async () => {
      hookResult.selectSession(tab1Id);
    });

    const session1 = terminalSession(tab1Id);
    const session2 = terminalSession(tab2Id);
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    if (session1) session1.win32InputMode = true;
    if (session2) session2.win32InputMode = true;

    const spy1 = vi.spyOn(session1!, 'sendInput');
    const spy2 = vi.spyOn(session2!, 'sendInput');

    const altDown = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const keyA = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', altKey: true, bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(altDown);
      window.dispatchEvent(keyA);
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altDown, true));
    spy1.mockClear();
    spy2.mockClear();

    await act(async () => {
      hookResult.selectSession(tab2Id);
    });

    const altUp = new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(altUp);
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altDown, false));
    expect(spy2).not.toHaveBeenCalledWith(win32InputKey(altDown, false));

    spy1.mockClear();
    spy2.mockClear();

    await act(async () => {
      hookResult.selectSession(tab1Id);
    });

    const altDown2 = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', bubbles: true, cancelable: true });
    const keyA2 = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', altKey: true, bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(altDown2);
      window.dispatchEvent(keyA2);
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altDown2, true));
    spy1.mockClear();
    spy2.mockClear();

    await act(async () => {
      hookResult.selectSession(tab2Id);
    });

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(spy1).toHaveBeenCalledWith(win32InputKey(altDown2, false));
    expect(spy2).not.toHaveBeenCalledWith(win32InputKey(altDown2, false));

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });
});
