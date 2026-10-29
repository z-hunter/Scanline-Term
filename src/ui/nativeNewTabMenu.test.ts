import { beforeEach, describe, expect, it, vi } from 'vitest';

type MenuItem = { id?: string; item?: string; text?: string; action?: () => void; items?: MenuItem[] };
type MenuSpec = { items: MenuItem[] };
const menus = vi.hoisted(() => ({ created: [] as MenuSpec[] }));
vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: async (options: MenuSpec) => { menus.created.push(options); return { popup: async () => undefined }; } },
  Submenu: { new: async (options: MenuItem) => options },
  PredefinedMenuItem: { new: async (options: { item: string }) => options },
}));

import { showNativeTabMenu } from './nativeNewTabMenu';

describe('native new tab menu', () => {
  beforeEach(() => { menus.created.length = 0; });

  it('places custom shells after the divider and forwards the full selected profile', async () => {
    const onNewShell = vi.fn();
    const profile = { id: 'lua:work', name: 'Work', command: 'pwsh.exe', args: ['-NoProfile'] };
    await showNativeTabMenu({ onNew: vi.fn(), onNewBrowser: vi.fn(), onNewShell, shells: [
      { name: 'PowerShell', command: 'powershell.exe' }, profile,
    ] });
    const items = menus.created[0].items;
    expect(items.map((item) => item.id ?? item.item)).toEqual([
      'scanline-new-terminal-tab', 'scanline-new-browser-tab', 'scanline-new-tab-shells', 'Separator', 'scanline-new-tab-user-shells',
    ]);
    items[4].items?.[0].action?.();
    expect(onNewShell).toHaveBeenCalledWith(profile);
  });
});
