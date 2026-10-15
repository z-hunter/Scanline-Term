import { Menu, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import type { ShellInfo } from '../terminal/useTerminal';

type NewTabMenuActions = {
  onNew: () => void;
  onNewBrowser: (url?: string) => void;
  onNewShell: (command: string) => void;
  shells: ShellInfo[];
};

async function newTabItems({ onNew, onNewBrowser, onNewShell, shells }: NewTabMenuActions) {
  const shellMenu = shells.length > 0 ? await Submenu.new({
    id: 'scanline-new-tab-shells',
    text: 'Shells',
    items: shells.map((shell, index) => ({ id: `scanline-shell-${index}`, text: shell.name, action: () => onNewShell(shell.command) })),
  }) : null;
  return [
    { id: 'scanline-new-terminal-tab', text: 'New Terminal tab [menu-N]', action: () => onNew() },
    { id: 'scanline-new-browser-tab', text: 'New Browser tab [menu-B]', action: () => onNewBrowser() },
    ...(shellMenu ? [shellMenu] : []),
  ];
}

export async function showNativeTabMenu(actions: NewTabMenuActions) {
  const menu = await Menu.new({ items: await newTabItems(actions) });
  await menu.popup();
}

export async function showNativeTerminalMenu({ onFind, onFindBack, onCopyByMouse, onNewBrowser, onToggleTabsBar, onOpenPresetPicker, onToggleGallery, ...actions }: NewTabMenuActions & {
  onFind: () => void;
  onFindBack: () => void;
  onCopyByMouse: () => void;
  onToggleTabsBar: () => void;
  onOpenPresetPicker: () => void;
  onToggleGallery: () => void;
}) {
  const separator = await PredefinedMenuItem.new({ item: 'Separator' });
  const menu = await Menu.new({ items: [
    ...(await newTabItems({ onNewBrowser, ...actions })),
    { id: 'scanline-find', text: 'Find [menu-/]', action: onFind },
    { id: 'scanline-find-back', text: 'Find back [menu-shift-/]', action: onFindBack },
    { id: 'scanline-copy-by-mouse', text: 'Select and copy by mouse [menu-C]', action: onCopyByMouse },
    separator,
    { id: 'scanline-toggle-tabs-bar', text: 'Hide/show tab bar [menu-Z]', action: onToggleTabsBar },
    { id: 'scanline-open-preset-browser', text: 'Open preset browser [menu-P]', action: onOpenPresetPicker },
    { id: 'scanline-gallery', text: 'Gallery [menu-backspace]', action: onToggleGallery },
  ] });
  await menu.popup();
}

export async function showNativeImageMenu({ onDelete }: { onDelete: () => void }) {
  const menu = await Menu.new({ items: [{ id: 'scanline-delete-image', text: 'Delete image', action: onDelete }] });
  await menu.popup();
}
