import type { CSSProperties, KeyboardEvent, Ref } from 'react';
import type { TabPlacement } from '../crt/settings';
import type { TerminalTab } from '../terminal/useTerminal';

export function TerminalTabs({ tabs, activeId, placement, onSelect, onClose, onNew, onToggleSettings, panelRef }: { tabs: TerminalTab[]; activeId: string | null; placement: TabPlacement; onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void; onToggleSettings: () => void; panelRef?: Ref<HTMLDivElement> }) {
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
    <div className="terminal-tab-list" role="tablist" aria-orientation={placement === 'top' ? 'horizontal' : 'vertical'}>{tabs.map((tab, index) => <div className={`terminal-tab terminal-tab-${tab.status}${tab.id === activeId ? ' active' : ''}`} key={tab.id} style={{ '--tab-background': tab.background, '--tab-foreground': tab.foreground } as CSSProperties} onMouseEnter={() => onSelect(tab.id)}>
      <button id={`terminal-tab-${tab.id}`} type="button" role="tab" aria-selected={tab.id === activeId} aria-controls="terminal-display" tabIndex={tab.id === activeId ? 0 : -1} onClick={() => onSelect(tab.id)} onKeyDown={(event) => selectByKey(event, index)}>{tab.title}</button>
      <button type="button" className="terminal-tab-close" aria-label={`Close ${tab.title}`} disabled={tab.status === 'starting'} onClick={() => onClose(tab.id)}>×</button>
    </div>)}</div>
    <button type="button" className="new-tab-button" aria-label="New terminal tab" onClick={() => onNew()}>+</button>
    <button type="button" className="tabs-settings-button" aria-label="Toggle settings" onClick={onToggleSettings}>⚙</button>
  </div>;
}
