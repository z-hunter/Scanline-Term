import { Menu, Submenu } from '@tauri-apps/api/menu';
import type { ShellInfo } from '../terminal/useTerminal';

export async function showNativeNewTabMenu({
  onNew,
  onNewBrowser,
  onNewShell,
  shells,
}: {
  onNew: () => void;
  onNewBrowser: () => void;
  onNewShell: (command: string) => void;
  shells: ShellInfo[];
}) {
  const shellMenu = shells.length > 0 ? await Submenu.new({
    id: 'scanline-new-tab-shells',
    text: 'Shells',
    items: shells.map((shell, index) => ({ id: `scanline-shell-${index}`, text: shell.name, action: () => onNewShell(shell.command) })),
  }) : null;
  const menu = await Menu.new({
    items: [
      { id: 'scanline-new-terminal-tab', text: 'New Terminal tab', action: () => onNew() },
      { id: 'scanline-new-browser-tab', text: 'New Browser tab', action: () => onNewBrowser() },
      ...(shellMenu ? [shellMenu] : []),
    ],
  });
  await menu.popup();
}
