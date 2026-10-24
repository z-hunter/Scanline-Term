import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => mocked);

import { useLuaAutomationStatus } from './useLuaAutomationStatus';
import type { LuaAutomationStatus } from './lua-automation';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ onError, onStatus }: { onError: (message: string) => void; onStatus?: (status: LuaAutomationStatus) => void }) {
  const { status, reload } = useLuaAutomationStatus(onError);
  onStatus?.(status);
  return createElement('button', { onClick: () => void reload() }, status.state);
}

describe('useLuaAutomationStatus', () => {
  beforeEach(() => {
    mocked.invoke.mockReset();
    mocked.isTauri.mockReturnValue(true);
  });

  it('deduplicates typed errors, handles shrinking logs, and toasts a recurrence after clear', async () => {
    const callbackError = { level: 'error', message: 'modal-layout.lua (context-updated): callback failed' } as const;
    const layoutTrace = { level: 'info', message: 'Lua action modal-layout.lua (context-updated) requested layout 0x00000409' } as const;
    const initial: LuaAutomationStatus = { state: 'ready', configPath: 'C:\\test\\sterm.lua', error: null, diagnostics: [] };
    const failed: LuaAutomationStatus = { state: 'error', configPath: initial.configPath, error: callbackError.message, diagnostics: [layoutTrace, callbackError] };
    const shorter: LuaAutomationStatus = { ...failed, diagnostics: [callbackError] };
    const recurring: LuaAutomationStatus = { ...failed, diagnostics: [callbackError] };
    let statusCalls = 0;
    mocked.invoke.mockImplementation(async () => {
      statusCalls += 1;
      return statusCalls === 1 ? initial : statusCalls === 2 ? failed : statusCalls === 3 ? shorter : statusCalls === 4 ? initial : recurring;
    });
    const onError = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe, { onError })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(onError).toHaveBeenCalledExactlyOnceWith(`Lua: ${callbackError.message}`);
      expect(consoleError).toHaveBeenCalledWith(`[Lua] ${callbackError.message}`);
      expect(consoleInfo).toHaveBeenCalledWith(`[Lua] ${layoutTrace.message}`);

      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(onError).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError.mock.calls).toEqual([[`Lua: ${callbackError.message}`], [`Lua: ${callbackError.message}`]]);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      vi.useRealTimers();
      consoleError.mockRestore();
      consoleInfo.mockRestore();
    }
  });

  it('ignores a status response that resolves after the hook unmounts', async () => {
    let resolveStatus!: (status: LuaAutomationStatus) => void;
    mocked.invoke.mockReturnValueOnce(new Promise<LuaAutomationStatus>((resolve) => { resolveStatus = resolve; }));
    const onError = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe, { onError })); });
      await act(async () => { root.unmount(); });
      await act(async () => {
        resolveStatus({ state: 'error', configPath: null, error: 'late failure', diagnostics: [{ level: 'error', message: 'late failure' }] });
      });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      container.remove();
    }
  });

  it('retains existing configPath when status or reload invoke fails', async () => {
    const readyStatus: LuaAutomationStatus = { state: 'ready', configPath: 'C:\\test\\sterm.lua', error: null, diagnostics: [] };
    let currentStatus: LuaAutomationStatus | undefined;
    const onError = vi.fn();
    mocked.invoke.mockImplementation(async (command: string) => {
      if (command === 'lua_automation_status') {
        if (!currentStatus || currentStatus.configPath === null) {
          return readyStatus;
        }
        throw new Error('connection lost');
      }
      if (command === 'lua_automation_reload') {
        throw new Error('reload crash');
      }
      throw new Error(`unknown command ${command}`);
    });

    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Probe, { onError, onStatus: (s) => { currentStatus = s; } }));
      });
      expect(currentStatus?.state).toBe('ready');
      expect(currentStatus?.configPath).toBe('C:\\test\\sterm.lua');

      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(currentStatus?.state).toBe('error');
      expect(currentStatus?.configPath).toBe('C:\\test\\sterm.lua');
      expect(currentStatus?.error).toContain('Lua automation status failed: Error: connection lost');
      expect(currentStatus?.diagnostics).toEqual([]);

      const button = container.querySelector('button');
      await act(async () => { button?.click(); });
      expect(currentStatus?.state).toBe('error');
      expect(currentStatus?.configPath).toBe('C:\\test\\sterm.lua');
      expect(currentStatus?.error).toContain('Lua configuration reload failed: Error: reload crash');
      expect(currentStatus?.diagnostics).toEqual([]);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      vi.useRealTimers();
    }
  });
});
