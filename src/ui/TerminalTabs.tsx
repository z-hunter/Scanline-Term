import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type Ref } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { TabPlacement } from '../crt/settings';
import type { ShellInfo, WorkspaceTab } from '../terminal/useTerminal';
import { showNativeTabMenu } from './nativeNewTabMenu';

export function TerminalTabs({
  tabs,
  activeId,
  placement,
  onSelect,
  onMove = () => undefined,
  onClose,
  onNew,
  onNewBrowser = () => undefined,
  onNewShell = () => undefined,
  shells = [],
  onToggleSettings,
  onToggleAi,
  aiEnabled = true,
  settingsVisible = false,
  aiVisible = false,
  panelRef,
}: {
  tabs: WorkspaceTab[];
  activeId: string | null;
  placement: TabPlacement;
  onSelect: (id: string) => void;
  onMove?: (id: string, targetIndex: number) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onNewBrowser?: () => void;
  onNewShell?: (command: string) => void;
  shells?: ShellInfo[];
  onToggleSettings: () => void;
  onToggleAi?: () => void;
  aiEnabled?: boolean;
  settingsVisible?: boolean;
  aiVisible?: boolean;
  panelRef?: Ref<HTMLDivElement>;
}) {
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const newTabControlRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const hoveredTab = useRef<{ id: string; x: number; y: number } | null>(null);
  const mouseSelection = useRef<{ id: string; x: number; y: number } | null>(null);
  const layoutHoverBlocked = useRef<string | null>(null);
  const previousRects = useRef(new Map<string, DOMRect>());
  const [drag, setDrag] = useState<{ id: string; source: number; target: number; pointerId: number; start: number; delta: number; gaps: Record<string, number> } | null>(null);
  const axis = placement === 'top' ? 'x' : 'y';
  const orderKey = tabs.map((tab) => tab.id).join('|');
  const animateLayout = () => {
    const previous = previousRects.current;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduced) tabs.forEach((tab) => {
      const node = tabListRef.current?.querySelector<HTMLElement>(`[data-terminal-tab-id="${tab.id}"]`);
      const oldRect = previous.get(tab.id); const nextRect = node?.getBoundingClientRect();
      if (!node || !oldRect || !nextRect) return;
      const dx = oldRect.left - nextRect.left; const dy = oldRect.top - nextRect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
    previousRects.current = new Map(tabs.map((tab) => {
      const node = tabListRef.current?.querySelector<HTMLElement>(`[data-terminal-tab-id="${tab.id}"]`);
      return [tab.id, node?.getBoundingClientRect() ?? new DOMRect()] as const;
    }));
  };
  useLayoutEffect(animateLayout, [orderKey, tabs]);
  useLayoutEffect(() => {
    if (layoutHoverBlocked.current && !tabs.some((tab) => tab.id === layoutHoverBlocked.current)) {
      layoutHoverBlocked.current = null;
      hoveredTab.current = null;
      mouseSelection.current = null;
    }
  }, [tabs]);
  useLayoutEffect(() => {
    const selection = mouseSelection.current;
    if (!selection) return;
    const tab = document.elementFromPoint?.(selection.x, selection.y)?.closest<HTMLElement>('[data-terminal-tab-id]');
    if (tab?.dataset.terminalTabId !== selection.id) layoutHoverBlocked.current = tab?.dataset.terminalTabId ?? null;
  });
  useEffect(() => {
    const list = tabListRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const selection = mouseSelection.current;
      if (!selection) return;
      const tab = document.elementFromPoint?.(selection.x, selection.y)?.closest<HTMLElement>('[data-terminal-tab-id]');
      if (tab?.dataset.terminalTabId !== selection.id) layoutHoverBlocked.current = tab?.dataset.terminalTabId ?? null;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
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
  const openNativeNewTabMenu = () => void showNativeTabMenu({ onNew, onNewBrowser, onNewShell, shells }).catch(() => setNewTabMenuOpen(true));
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
  const openContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('.tabs-actions')) { event.preventDefault(); return; }
    event.preventDefault();
    if (isTauri()) openNativeNewTabMenu(); else setNewTabMenuOpen(true);
  };
  const selectByMouse = (event: MouseEvent<HTMLElement>, id: string) => {
    hoveredTab.current = { id, x: event.clientX, y: event.clientY };
    mouseSelection.current = { id, x: event.clientX, y: event.clientY };
    onSelect(id);
  };
  const selectByHover = (event: MouseEvent<HTMLDivElement>, id: string) => {
    if (layoutHoverBlocked.current === id) return;
    if (hoveredTab.current?.id === id) {
      mouseSelection.current = { id, x: event.clientX, y: event.clientY };
      return;
    }
    selectByMouse(event, id);
  };
  const clearHoverBlock = (id: string) => {
    if (hoveredTab.current?.id === id) hoveredTab.current = null;
    if (layoutHoverBlocked.current === id) {
      layoutHoverBlocked.current = null;
      hoveredTab.current = null;
      mouseSelection.current = null;
    }
  };
  const pointerValue = (event: PointerEvent<HTMLDivElement>) => axis === 'x' ? event.clientX : event.clientY;
  const pointerDown = (event: PointerEvent<HTMLDivElement>, id: string, index: number) => {
    if (event.button !== 0 || (event.target as Element).closest('.terminal-tab-close') || tabs.length < 2) return;
    onSelect(id);
    const value = pointerValue(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const center = axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    const gaps = Object.fromEntries(tabs.map((tab) => {
      const node = tabListRef.current?.querySelector<HTMLElement>(`[data-terminal-tab-id="${tab.id}"]`);
      const size = node ? (axis === 'x' ? node.getBoundingClientRect().width : node.getBoundingClientRect().height) : 0;
      return [tab.id, size + 4];
    }));
    const next = { id, source: index, target: index, pointerId: event.pointerId, start: value, delta: value - center, gaps };
    setDrag(next); event.preventDefault();
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag;
    if (!current || current.pointerId !== event.pointerId) return;
    const value = pointerValue(event); const remaining = tabs.filter((tab) => tab.id !== current.id);
    const target = remaining.findIndex((tab) => {
      const node = tabListRef.current?.querySelector<HTMLElement>(`[data-terminal-tab-id="${tab.id}"]`);
      if (!node) return false;
      const rect = node.getBoundingClientRect(); const middle = axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      return value < middle;
    });
    const nextTarget = target < 0 ? remaining.length : target;
    if (nextTarget !== current.target) setDrag({ ...current, target: nextTarget, delta: value - current.start });
    else setDrag({ ...current, delta: value - current.start });
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = drag;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
    if (!cancelled && current.target !== current.source) onMove(current.id, current.target);
  };
  const dragTransform = (index: number, id: string) => {
    if (!drag) return undefined;
    const distance = drag.delta;
    if (id === drag.id) return axis === 'x' ? `translateX(${distance}px)` : `translateY(${distance}px)`;
    const amount = drag.gaps[id] ?? 0;
    const shift = drag.target > drag.source && index > drag.source && index <= drag.target ? -amount : drag.target < drag.source && index >= drag.target && index < drag.source ? amount : 0;
    return shift ? (axis === 'x' ? `translateX(${shift}px)` : `translateY(${shift}px)`) : undefined;
  };
  return <div ref={panelRef} className={`terminal-tabs terminal-tabs-${placement}`} onContextMenu={openContextMenu}>
    <div ref={tabListRef} className="terminal-tab-list" role="tablist" aria-orientation={placement === 'top' ? 'horizontal' : 'vertical'}>{tabs.map((tab, index) => <div className={`terminal-tab terminal-tab-${tab.status}${tab.id === activeId ? ' active' : ''}`} key={tab.id} data-terminal-tab-id={tab.id} style={{ '--tab-background': tab.background, '--tab-foreground': tab.foreground, transform: dragTransform(index, tab.id) } as CSSProperties} onMouseMove={(event) => selectByHover(event, tab.id)} onMouseLeave={() => clearHoverBlock(tab.id)} onPointerDown={(event) => pointerDown(event, tab.id, index)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={(event) => pointerEnd(event, true)}>
      <button id={`terminal-tab-${tab.id}`} type="button" role="tab" aria-selected={tab.id === activeId} aria-controls="terminal-display" tabIndex={tab.id === activeId ? 0 : -1} onClick={(event) => selectByMouse(event, tab.id)} onKeyDown={(event) => selectByKey(event, index)}>{tab.title}</button>
      <button type="button" className="terminal-tab-close" aria-label={`Close ${tab.title}`} disabled={tab.status === 'starting' && tab.kind !== 'browser'} onClick={() => onClose(tab.id)}>×</button>
    </div>)}</div>
    <div ref={newTabControlRef} className="new-tab-control">
      <button type="button" className="new-tab-button" aria-label="New terminal tab" aria-haspopup="menu" aria-expanded={newTabMenuOpen} onClick={() => { onNew(); setNewTabMenuOpen(false); }}>+</button>
      {newTabMenuOpen && <div className="new-tab-menu" role="menu" aria-label="New tab options">
        <button type="button" role="menuitem" onClick={() => { onNew(); setNewTabMenuOpen(false); }}>New Terminal tab [menu-N]</button>
        <button type="button" role="menuitem" onClick={() => { onNewBrowser(); setNewTabMenuOpen(false); }}>New Browser tab [menu-B]</button>
        {shells.length > 0 && <>
          <div className="new-tab-menu-label">Shells</div>
          {shells.map((shell) => <button key={shell.command} type="button" role="menuitem" onClick={() => { onNewShell(shell.command); setNewTabMenuOpen(false); }}>{shell.name}</button>)}
        </>}
      </div>}
    </div>
    <div className="tabs-actions">
      {aiEnabled && <button
        type="button"
        className={`tabs-ai-button${aiVisible ? ' active' : ''}`}
        aria-label="Toggle AI assistant"
        title="Toggle AI Assistant [menu-A]"
        aria-pressed={aiVisible}
        onClick={onToggleAi}
      >
        <span className="tabs-ai-icon" aria-hidden="true" />
      </button>}
      <button
        type="button"
        className={`tabs-settings-button${settingsVisible ? ' active' : ''}`}
        aria-label="Toggle settings"
        title="Toggle Settings [menu-S]"
        aria-pressed={settingsVisible}
        onClick={onToggleSettings}
      >
        ⚙
      </button>
    </div>
  </div>;
}
