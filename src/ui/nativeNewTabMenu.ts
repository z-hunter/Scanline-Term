import { shortcutHint } from '../terminal/keymap';
import { Menu, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import { splitShellCatalog, type ShellInfo } from '../terminal/shells';

type NewTabMenuActions = {
  onNew: () => void;
  onNewBrowser: (url?: string) => void;
  onNewShell: (shell: ShellInfo) => void;
  shells: ShellInfo[];
};

async function newTabItems({ onNew, onNewBrowser, onNewShell, shells }: NewTabMenuActions) {
  const { automatic, user } = splitShellCatalog(shells);
  const shellMenu = automatic.length > 0 ? await Submenu.new({
    id: 'scanline-new-tab-shells',
    text: 'Shells',
    items: automatic.map((shell, index) => ({ id: `scanline-shell-${index}`, text: shell.name, action: () => onNewShell(shell) })),
  }) : null;
  const userShellMenu = user.length > 0 ? await Submenu.new({
    id: 'scanline-new-tab-user-shells',
    text: 'Custom shells',
    items: user.map((shell, index) => ({ id: `scanline-user-shell-${index}`, text: shell.name, action: () => onNewShell(shell) })),
  }) : null;
  const separator = automatic.length && user.length ? await PredefinedMenuItem.new({ item: 'Separator' }) : null;
  return [
    { id: 'scanline-new-terminal-tab', text: `New Terminal tab${shortcutHint('tab.new_terminal')}`, action: () => onNew() },
    { id: 'scanline-new-browser-tab', text: `New Browser tab${shortcutHint('tab.new_browser')}`, action: () => onNewBrowser() },
    ...(shellMenu ? [shellMenu] : []),
    ...(separator ? [separator] : []),
    ...(userShellMenu ? [userShellMenu] : []),
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
    { id: 'scanline-find', text: `Find${shortcutHint('terminal.find')}`, action: onFind },
    { id: 'scanline-find-back', text: `Find back${shortcutHint('terminal.find_back')}`, action: onFindBack },
    { id: 'scanline-copy-by-mouse', text: `Select and copy by mouse${shortcutHint('terminal.copy_mode')}`, action: onCopyByMouse },
    separator,
    { id: 'scanline-toggle-tabs-bar', text: `Hide/show tab bar${shortcutHint('tabs.toggle_bar')}`, action: onToggleTabsBar },
    { id: 'scanline-open-preset-browser', text: `Presets selector${shortcutHint('presets.toggle_picker')}`, action: onOpenPresetPicker },
    { id: 'scanline-gallery', text: `Gallery${shortcutHint('gallery.toggle')}`, action: onToggleGallery },
  ] });
  await menu.popup();
}

export async function showNativeImageMenu({ onDelete }: { onDelete: () => void }) {
  const menu = await Menu.new({ items: [{ id: 'scanline-delete-image', text: 'Delete image', action: onDelete }] });
  await menu.popup();
}
