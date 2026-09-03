import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { TerminalTabs } from './TerminalTabs';
import type { TerminalTab } from '../terminal/useTerminal';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const testTabs: TerminalTab[] = [
  { id: 'tab-1', ordinal: 1, title: '1. cmd.exe', status: 'running', background: '#000000', foreground: '#ffffff' },
  { id: 'tab-2', ordinal: 2, title: '2. pwsh.exe', status: 'running', background: '#000000', foreground: '#ffffff' },
];

describe('TerminalTabs', () => {
  it('renders all tabs and controls when hideTabList is false', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onNew = vi.fn();
    const onToggleSettings = vi.fn();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(TerminalTabs, {
          tabs: testTabs,
          activeId: 'tab-1',
          placement: 'top',
          onSelect,
          onClose,
          onNew,
          onToggleSettings,
        }),
      );
    });

    expect(container.querySelector('.terminal-tab-list')).not.toBeNull();
    const tabButtons = container.querySelectorAll('.terminal-tab');
    expect(tabButtons.length).toBe(2);

    const newBtn = container.querySelector<HTMLButtonElement>('.new-tab-button');
    expect(newBtn).not.toBeNull();
    newBtn?.click();
    expect(onNew).toHaveBeenCalledOnce();

    const settingsBtn = container.querySelector<HTMLButtonElement>('.tabs-settings-button');
    expect(settingsBtn).not.toBeNull();
    settingsBtn?.click();
    expect(onToggleSettings).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('hides the tab list while preserving the new-tab and settings controls when hideTabList is true', async () => {
    const onNew = vi.fn();
    const onToggleSettings = vi.fn();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(TerminalTabs, {
          tabs: [testTabs[0]],
          activeId: 'tab-1',
          placement: 'top',
          hideTabList: true,
          onSelect: vi.fn(),
          onClose: vi.fn(),
          onNew,
          onToggleSettings,
        }),
      );
    });

    expect(container.querySelector('.terminal-tab-list')).toBeNull();
    expect(container.querySelectorAll('.terminal-tab').length).toBe(0);

    const newBtn = container.querySelector<HTMLButtonElement>('.new-tab-button');
    expect(newBtn).not.toBeNull();
    newBtn?.click();
    expect(onNew).toHaveBeenCalledOnce();

    const settingsBtn = container.querySelector<HTMLButtonElement>('.tabs-settings-button');
    expect(settingsBtn).not.toBeNull();
    settingsBtn?.click();
    expect(onToggleSettings).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
