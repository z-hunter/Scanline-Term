import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ openPath: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => mocked);

import { LuaAutomationPanel } from './LuaAutomationPanel';
import type { LuaAutomationStatus } from '../terminal/lua-automation';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('LuaAutomationPanel', () => {
  it('keeps the resolved path and diagnostics out of Settings and exposes both controls in one row', async () => {
    const status: LuaAutomationStatus = {
      state: 'ready', configPath: 'C:\\test\\sterm.lua', error: 'load failed', diagnostics: [{ level: 'info', message: 'trace detail' }],
    };
    const reload = vi.fn(async () => undefined);
    const onError = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(LuaAutomationPanel, { status, reload, onError, available: true })); });
      expect(container.textContent).toContain('Lua automation: ready');
      expect(container.textContent).not.toContain(status.configPath);
      expect(container.textContent).not.toContain(status.error);
      expect(container.textContent).not.toContain(status.diagnostics[0].message);
      const actions = container.querySelector('.lua-automation-actions')!;
      expect(actions.querySelectorAll('button')).toHaveLength(2);
      expect([...actions.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Reload config', 'Edit config']);

      await act(async () => { actions.querySelector<HTMLButtonElement>('button')!.click(); });
      expect(reload).toHaveBeenCalledOnce();
      await act(async () => { actions.querySelectorAll<HTMLButtonElement>('button')[1].click(); });
      expect(mocked.openPath).toHaveBeenCalledWith(status.configPath);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      mocked.openPath.mockReset();
    }
  });

  it('routes opener failures through the existing error callback', async () => {
    mocked.openPath.mockRejectedValueOnce(new Error('editor unavailable'));
    const onError = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(LuaAutomationPanel, {
          status: { state: 'ready', configPath: 'C:\\test\\sterm.lua', error: null, diagnostics: [] },
          reload: vi.fn(async () => undefined), onError, available: true,
        }));
      });
      await act(async () => { container.querySelectorAll<HTMLButtonElement>('button')[1].click(); });
      expect(onError).toHaveBeenCalledWith('Could not open Lua configuration: Error: editor unavailable');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      mocked.openPath.mockReset();
    }
  });

  it('explains browser preview availability and reports a missing config when Edit is used', async () => {
    const onError = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(LuaAutomationPanel, {
          status: { state: 'disabled', configPath: null, error: null, diagnostics: [] },
          reload: vi.fn(async () => undefined), onError, available: false,
        }));
      });
      expect(container.textContent).toContain('unavailable outside the Windows app');
      expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
      await act(async () => { container.querySelectorAll<HTMLButtonElement>('button')[1].click(); });
      expect(onError).toHaveBeenCalledWith('No Lua configuration file is loaded.');
      expect(mocked.openPath).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
