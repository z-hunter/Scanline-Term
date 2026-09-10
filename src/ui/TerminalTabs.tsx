import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { TabPlacement } from '../crt/settings';
import type { ShellInfo, WorkspaceTab } from '../terminal/useTerminal';
import { showNativeNewTabMenu } from './nativeNewTabMenu';

export function TerminalTabs({
  tabs,
  activeId,
  placement,
  onSelect,
  onClose,
  onNew,
  onNewBrowser = () => undefined,
  onNewShell = () => undefined,
  shells = [],
  onToggleSettings,
  onToggleAi,
  settingsVisible = false,
  aiVisible = false,
  panelRef,
  hideTabList = false,
}: {
  tabs: WorkspaceTab[];
  activeId: string | null;
  placement: TabPlacement;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onNewBrowser?: () => void;
  onNewShell?: (command: string) => void;
  shells?: ShellInfo[];
  onToggleSettings: () => void;
  onToggleAi?: () => void;
  settingsVisible?: boolean;
  aiVisible?: boolean;
  panelRef?: Ref<HTMLDivElement>;
  hideTabList?: boolean;
}) {
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const newTabControlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newTabMenuOpen) return;
    const closeOnKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setNewTabMenuOpen(false); };
    const closeOnMouse = (event: globalThis.MouseEvent) => {
      if (!newTabControlRef.current?.contains(event.target as Node)) setNewTabMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnMouse);
    document.addEventListener('keydown', closeOnKey);
    return () => { document.removeEventListener('mousedown', closeOnMouse); document.removeEventListener('keydown', closeOnKey); };
  }, [newTabMenuOpen]);
  const openNativeNewTabMenu = () => void showNativeNewTabMenu({ onNew, onNewBrowser, onNewShell, shells }).catch(() => setNewTabMenuOpen(true));
  const selectByKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const previous = placement === 'top' ? 'ArrowLeft' : 'ArrowUp'; const next = placement === 'top' ? 'ArrowRight' : 'ArrowDown';
    let target = index;
    if (event.key === previous) target = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === next) target = (index + 1) % tabs.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = tabs.length - 1;
    else return;
    event.preventDefault(); onSelect(tabs[target].id); document.getElementById(`terminal-tab-${tabs[target].id}`)?.focus();
  };
  return <div ref={panelRef} className={`terminal-tabs terminal-tabs-${placement}`}>
    {!hideTabList && <div className="terminal-tab-list" role="tablist" aria-orientation={placement === 'top' ? 'horizontal' : 'vertical'}>{tabs.map((tab, index) => <div className={`terminal-tab terminal-tab-${tab.status}${tab.id === activeId ? ' active' : ''}`} key={tab.id} style={{ '--tab-background': tab.background, '--tab-foreground': tab.foreground } as CSSProperties} onMouseEnter={() => onSelect(tab.id)}>
      <button id={`terminal-tab-${tab.id}`} type="button" role="tab" aria-selected={tab.id === activeId} aria-controls="terminal-display" tabIndex={tab.id === activeId ? 0 : -1} onClick={() => onSelect(tab.id)} onKeyDown={(event) => selectByKey(event, index)}>{tab.title}</button>
      <button type="button" className="terminal-tab-close" aria-label={`Close ${tab.title}`} disabled={tab.status === 'starting' && tab.kind !== 'browser'} onClick={() => onClose(tab.id)}>×</button>
    </div>)}</div>}
    <div ref={newTabControlRef} className="new-tab-control">
      <button type="button" className="new-tab-button" aria-label="New terminal tab" aria-haspopup="menu" aria-expanded={newTabMenuOpen} onClick={() => { onNew(); setNewTabMenuOpen(false); }} onContextMenu={(event) => { event.preventDefault(); if (isTauri()) openNativeNewTabMenu(); else setNewTabMenuOpen(true); }}>+</button>
      {newTabMenuOpen && <div className="new-tab-menu" role="menu" aria-label="New tab options">
        <button type="button" role="menuitem" onClick={() => { onNew(); setNewTabMenuOpen(false); }}>New Terminal tab</button>
        <button type="button" role="menuitem" onClick={() => { onNewBrowser(); setNewTabMenuOpen(false); }}>New Browser tab</button>
        {shells.length > 0 && <>
          <div className="new-tab-menu-label">Shells</div>
          {shells.map((shell) => <button key={shell.command} type="button" role="menuitem" onClick={() => { onNewShell(shell.command); setNewTabMenuOpen(false); }}>{shell.name}</button>)}
        </>}
      </div>}
    </div>
    <div className="tabs-actions">
      <button
        type="button"
        className={`tabs-ai-button${aiVisible ? ' active' : ''}`}
        aria-label="Toggle AI assistant"
        title="Toggle AI assistant"
        aria-pressed={aiVisible}
        onClick={onToggleAi}
      >
        <span className="tabs-ai-icon" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`tabs-settings-button${settingsVisible ? ' active' : ''}`}
        aria-label="Toggle settings"
        title="Toggle settings"
        aria-pressed={settingsVisible}
        onClick={onToggleSettings}
      >
        ⚙
      </button>
    </div>
  </div>;
}
