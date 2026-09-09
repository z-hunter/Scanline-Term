import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocked.invoke }));

import { HomeDashboard } from './HomeDashboard';

const config = {
  version: 1 as const,
  title: 'Test Home',
  categories: [{ title: 'Tools', links: [{ title: 'GitHub', url: 'https://github.com/', shortcut: 'g' }, { title: 'Docs', url: 'https://docs.example/' }] }],
};

let root: Root | undefined;
afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks(); });

async function renderHome(onNavigate = vi.fn()) {
  mocked.invoke.mockResolvedValue({ path: 'C:\\home.json', config });
  const tabId = `tab-${Date.now()}-${Math.random()}`;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(createElement(HomeDashboard, { tabId, onNavigate, onError: vi.fn() })); });
  return { host, onNavigate, tabId };
}

describe('HomeDashboard', () => {
  it('loads links and opens a selected URL', async () => {
    const { host, onNavigate, tabId } = await renderHome();
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes('GitHub'));
    expect(button).toBeDefined();
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onNavigate).toHaveBeenCalledWith(tabId, 'https://github.com/');
  });

  it('reloads the file when requested', async () => {
    const { host } = await renderHome();
    const reload = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Reload');
    await act(async () => { reload?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocked.invoke).toHaveBeenCalledWith('load_home_config');
    expect(mocked.invoke.mock.calls.filter(([name]) => name === 'load_home_config')).toHaveLength(2);
  });

  it('opens a link with its single-key shortcut', async () => {
    const { onNavigate, tabId } = await renderHome();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true })); });
    expect(onNavigate).toHaveBeenCalledWith(tabId, 'https://github.com/');
  });

  it('uses F hints for panel actions and suppresses F5 reload', async () => {
    const { host, onNavigate } = await renderHome();
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, right: 90, bottom: 40, width: 80, height: 30 } as DOMRect);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true })); });
    expect(host.querySelector('[data-hint-mode="active"]')).toBeTruthy();
    const actions = Array.from(host.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[role="button"]'));
    const githubIndex = actions.findIndex((element) => element.textContent?.includes('GitHub'));
    const githubHint = host.querySelectorAll<HTMLElement>('.browser-home-hint')[githubIndex]?.textContent ?? '';
    await act(async () => { for (const key of githubHint) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    expect(onNavigate).toHaveBeenCalledWith(expect.any(String), 'https://github.com/');
    const f5 = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true });
    expect(window.dispatchEvent(f5)).toBe(false);
    rectSpy.mockRestore();
  });
});
