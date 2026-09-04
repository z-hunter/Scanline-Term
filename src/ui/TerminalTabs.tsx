import type { CSSProperties, KeyboardEvent, Ref } from 'react';
import type { TabPlacement } from '../crt/settings';
import type { TerminalTab } from '../terminal/useTerminal';

export function TerminalTabs({
  tabs,
  activeId,
  placement,
  onSelect,
  onClose,
  onNew,
  onToggleSettings,
  onToggleAi,
  settingsVisible = false,
  aiVisible = false,
  panelRef,
  hideTabList = false,
}: {
  tabs: TerminalTab[];
  activeId: string | null;
  placement: TabPlacement;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onToggleSettings: () => void;
  onToggleAi?: () => void;
  settingsVisible?: boolean;
  aiVisible?: boolean;
  panelRef?: Ref<HTMLDivElement>;
  hideTabList?: boolean;
}) {
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
      <button type="button" className="terminal-tab-close" aria-label={`Close ${tab.title}`} disabled={tab.status === 'starting'} onClick={() => onClose(tab.id)}>×</button>
    </div>)}</div>}
    <button type="button" className="new-tab-button" aria-label="New terminal tab" onClick={() => onNew()}>+</button>
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
