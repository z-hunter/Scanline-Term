import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export function QuickPresetPicker({ names, initialName, onPreview, onCommit, onCancel }: {
  names: string[];
  initialName: string;
  onPreview: (name: string) => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuHeld = useRef(false);
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => names.filter((name) => name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [filter, names]);
  const [selected, setSelected] = useState(() => names.includes(initialName) ? initialName : names[0] ?? '');
  const resolvedSelected = filtered.includes(selected) ? selected : filtered[0] ?? '';
  const choose = useCallback((name: string) => { setSelected(name); onPreview(name); }, [onPreview]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'ContextMenu') { menuHeld.current = true; return; }
      if (event.code === 'KeyP' && menuHeld.current) { event.preventDefault(); onCommit(resolvedSelected); return; }
      if (event.code === 'Escape') { event.preventDefault(); onCancel(); return; }
      if (event.code === 'Enter' || event.code === 'NumpadEnter') { event.preventDefault(); onCommit(resolvedSelected); return; }
      const index = filtered.indexOf(resolvedSelected);
      const direction = event.code === 'ArrowUp' ? -1 : event.code === 'ArrowDown' ? 1 : 0;
      if (direction && filtered.length) {
        event.preventDefault();
        const name = filtered[(Math.max(0, index) + direction + filtered.length) % filtered.length];
        choose(name); itemRefs.current.get(name)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', down, true);
    const up = (event: KeyboardEvent) => { if (event.code === 'ContextMenu') menuHeld.current = false; };
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [choose, filtered, onCancel, onCommit, resolvedSelected]);

  return <div className="quick-preset-picker" role="dialog" aria-modal="true" aria-label="Quick preset picker" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="quick-preset-picker-panel">
      <div className="quick-preset-filter">
        <input ref={inputRef} value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="Filter presets…" aria-label="Filter presets" spellCheck={false} autoComplete="off" />
        {filter && <button type="button" onClick={() => setFilter('')} aria-label="Clear preset filter">×</button>}
      </div>
      <div className="quick-preset-list" role="listbox" aria-label="Presets" onWheel={(event) => event.stopPropagation()}>
        {filtered.map((name) => <button key={name} ref={(node) => { if (node) itemRefs.current.set(name, node); else itemRefs.current.delete(name); }} type="button" role="option" aria-selected={name === resolvedSelected} className={name === resolvedSelected ? 'is-selected' : ''} onClick={() => choose(name)} onDoubleClick={() => onCommit(name)}>{name}</button>)}
        {!filtered.length && <p>No matching presets</p>}
      </div>
      <footer>enter or duble click to apply · esc to cancel</footer>
    </section>
  </div>;
}
