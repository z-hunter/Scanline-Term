import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => mocked);

import { LuaAutomationPanel } from './LuaAutomationPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('LuaAutomationPanel', () => {
  it('shows native status and reloads only through the explicit command', async () => {
    let statusReads = 0;
    mocked.invoke.mockImplementation(async (command: string) => command === 'lua_automation_status'
      ? statusReads++ === 0
        ? { state: 'ready', configPath: 'C:\\test\\sterm.lua', error: null, diagnostics: [] }
        : { state: 'error', configPath: null, error: 'syntax error near line 2', diagnostics: ['reload failed'] }
      : { state: 'loading', configPath: 'C:\\test\\sterm.lua', error: null, diagnostics: [] });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(LuaAutomationPanel)); });
      expect(mocked.invoke).toHaveBeenCalledWith('lua_automation_status');
      expect(container.textContent).toContain('Lua automation: ready');
      expect(container.textContent).toContain('C:\\test\\sterm.lua');

      await act(async () => { container.querySelector('button')!.click(); });
      expect(mocked.invoke).toHaveBeenCalledWith('lua_automation_reload');
      expect(mocked.invoke).not.toHaveBeenCalledWith('lua_automation_start');
      expect(container.textContent).toContain('syntax error near line 2');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      mocked.invoke.mockReset();
    }
  });

  it('explains that Lua automation needs the Windows app and does not query native state in browser preview', async () => {
    mocked.isTauri.mockReturnValue(false);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(LuaAutomationPanel)); });
      expect(container.textContent).toContain('unavailable outside the Windows app');
      expect(mocked.invoke).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      mocked.invoke.mockReset();
      mocked.isTauri.mockReturnValue(true);
    }
  });

  it('shows native disabled state as disabled rather than browser unavailable', async () => {
    mocked.invoke.mockResolvedValue({ state: 'disabled', configPath: null, error: null, diagnostics: [] });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(LuaAutomationPanel)); });
      expect(container.textContent).toContain('Lua automation: disabled');
      expect(container.textContent).not.toContain('unavailable outside the Windows app');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      mocked.invoke.mockReset();
      mocked.isTauri.mockReturnValue(true);
    }
  });
});
