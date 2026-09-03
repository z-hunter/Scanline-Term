import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.hoisted(() => ({
  invoke: vi.fn(),
  mockCloseWindow: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: mocked.invoke,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: mocked.mockCloseWindow }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
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
});
