import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { BrowserTab, WorkspaceTab } from '../terminal/useTerminal';

export type GalleryFrame = {
  canvas: HTMLCanvasElement;
  aspectRatio: number;
  showBezel: boolean;
};

export type GalleryPosition = { row: number; column: number };

export type GalleryLayoutItem = {
  tab: WorkspaceTab;
  position: GalleryPosition;
};

export function galleryColumns(width: number, tabCount: number): number {
  const padding = 2 * Math.min(84, Math.max(24, width * 0.05));
  const possible = Math.max(1, Math.floor((width - padding + 28) / 428));
  const bounded = Math.min(possible, Math.max(1, tabCount * 2 - 1));
  return bounded % 2 === 0 ? Math.max(1, bounded - 1) : bounded;
}

function assignChunk(items: WorkspaceTab[], row: number, columns: number, align: 'start' | 'end', output: GalleryLayoutItem[]): void {
  const offset = align === 'end' ? columns - items.length : 0;
  items.forEach((tab, index) => output.push({ tab, position: { row, column: offset + index + 1 } }));
}

export function buildGalleryLayout(tabs: WorkspaceTab[], activeId: string | null, columns: number): GalleryLayoutItem[] {
  if (!tabs.length) return [];
  if (tabs.length <= columns) return tabs.map((tab, index) => ({ tab, position: { row: 0, column: index + 1 } }));
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));
  const side = Math.floor(columns / 2);
  const currentStart = Math.max(0, activeIndex - side);
  const currentEnd = Math.min(tabs.length, activeIndex + side + 1);
  const leftChunks: WorkspaceTab[][] = [];
  for (let end = currentStart; end > 0;) {
    const start = Math.max(0, end - columns);
    leftChunks.unshift(tabs.slice(start, end));
    end = start;
  }
  const rightChunks: WorkspaceTab[][] = [];
  for (let start = currentEnd; start < tabs.length;) {
    const end = Math.min(tabs.length, start + columns);
    rightChunks.push(tabs.slice(start, end));
    start = end;
  }
  const output: GalleryLayoutItem[] = [];
  leftChunks.forEach((chunk, index) => assignChunk(chunk, index, columns, 'end', output));
  const currentRow = leftChunks.length;
  tabs.slice(currentStart, currentEnd).forEach((tab, index) => output.push({
    tab,
    position: { row: currentRow, column: side + index - (activeIndex - currentStart) + 1 },
  }));
  rightChunks.forEach((chunk, index) => assignChunk(chunk, currentRow + index + 1, columns, 'start', output));
  return output;
}

function tabLabel(tab: WorkspaceTab): string {
  return tab.kind === 'browser' ? `${tab.title} — browser tab` : `${tab.title} — terminal tab`;
}

function frameCanvas(node: HTMLCanvasElement | null, frame: GalleryFrame | undefined): void {
  if (!node || !frame) return;
  node.width = frame.canvas.width;
  node.height = frame.canvas.height;
  const context = node.getContext('2d');
  if (!context) return;
  context.imageSmoothingEnabled = true;
  context.clearRect(0, 0, node.width, node.height);
  context.drawImage(frame.canvas, 0, 0);
}

function nearestInColumn(items: GalleryLayoutItem[], row: number, column: number, direction: -1 | 1): string | null {
  const rows = [...new Set(items.map((item) => item.position.row))].sort((a, b) => a - b);
  const nextRow = direction < 0 ? [...rows].reverse().find((value) => value < row) : rows.find((value) => value > row);
  if (nextRow === undefined) return null;
  const candidates = items.filter((item) => item.position.row === nextRow);
  return candidates.sort((a, b) => Math.abs(a.position.column - column) - Math.abs(b.position.column - column))[0]?.tab.id ?? null;
}

function isBrowser(tab: WorkspaceTab): tab is BrowserTab {
  return tab.kind === 'browser';
}

export function TabGallery({
  tabs,
  activeId,
  frames,
  originRect,
  onChoose,
  onCancel,
  closeRequested = false,
}: {
  tabs: WorkspaceTab[];
  activeId: string | null;
  frames: ReadonlyMap<string, GalleryFrame>;
  originRect: DOMRect | null;
  onChoose: (id: string) => void;
  onCancel: () => void;
  closeRequested?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const entryAnimation = useRef(false);
  const [columns, setColumns] = useState(() => galleryColumns(window.innerWidth, tabs.length));
  const [visible, setVisible] = useState(false);
  const [selectedId, setSelectedId] = useState(activeId ?? tabs[0]?.id ?? null);
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);
  const layout = buildGalleryLayout(tabs, activeId, columns);
  const resolvedSelectedId = selectedId && tabs.some((tab) => tab.id === selectedId) ? selectedId : activeId ?? tabs[0]?.id ?? null;

  useEffect(() => {
    const resize = () => setColumns(galleryColumns(window.innerWidth, tabs.length));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [tabs.length]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    if (entryAnimation.current) return;
    const card = resolvedSelectedId ? cardRefs.current.get(resolvedSelectedId) : null;
    if (!card) return;
    entryAnimation.current = true;
    if (!originRect || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const target = card.getBoundingClientRect();
    const x = originRect.left - target.left;
    const y = originRect.top - target.top;
    const sx = originRect.width / Math.max(1, target.width);
    const sy = originRect.height / Math.max(1, target.height);
    card.animate(
      [{ transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`, opacity: 0.92 }, { transform: 'translate(0, 0) scale(1)', opacity: 1 }],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    );
  }, [columns, originRect, resolvedSelectedId]);

  useEffect(() => {
    if (!resolvedSelectedId) return;
    const frame = window.requestAnimationFrame(() => cardRefs.current.get(resolvedSelectedId)?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedSelectedId]);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const finish = useCallback((callback: () => void, cardId = resolvedSelectedId) => {
    if (closing) return;
    setClosing(true);
    const card = cardId ? cardRefs.current.get(cardId) : null;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 0 : 180;
    card?.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.12)', opacity: 0 }], { duration, easing: 'cubic-bezier(.4,0,1,1)', fill: 'both' });
    timer.current = window.setTimeout(callback, duration);
  }, [closing, resolvedSelectedId]);

  const cancel = useCallback(() => finish(onCancel, activeId ?? resolvedSelectedId), [activeId, finish, onCancel, resolvedSelectedId]);

  useEffect(() => {
    if (closeRequested) cancel();
  }, [cancel, closeRequested]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (closing) return;
      if (event.code === 'Escape') { event.preventDefault(); cancel(); return; }
      const current = layout.find((item) => item.tab.id === resolvedSelectedId);
      if (!current) return;
      let next: string | null = null;
      if (event.code === 'ArrowLeft' || event.code === 'KeyH') next = tabs[tabs.findIndex((tab) => tab.id === resolvedSelectedId) - 1]?.id ?? null;
      else if (event.code === 'ArrowRight' || event.code === 'KeyL') next = tabs[tabs.findIndex((tab) => tab.id === resolvedSelectedId) + 1]?.id ?? null;
      else if (event.code === 'ArrowUp' || event.code === 'KeyK') next = nearestInColumn(layout, current.position.row, current.position.column, -1);
      else if (event.code === 'ArrowDown' || event.code === 'KeyJ') next = nearestInColumn(layout, current.position.row, current.position.column, 1);
      else if (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space') { event.preventDefault(); if (resolvedSelectedId) finish(() => onChoose(resolvedSelectedId)); return; }
      else if (/^Digit[0-9]$/.test(event.code)) {
        const ordinal = event.code === 'Digit0' ? 10 : Number(event.code.slice(-1));
        const id = tabs.find((tab) => tab.ordinal === ordinal)?.id;
        if (id) { event.preventDefault(); finish(() => onChoose(id), id); }
        return;
      }
      if (next) {
        event.preventDefault();
        setSelectedId(next);
        cardRefs.current.get(next)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        cardRefs.current.get(next)?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancel, closing, finish, layout, onChoose, resolvedSelectedId, tabs]);

  return <div ref={dialogRef} className={`tab-gallery${visible ? ' is-visible' : ''}${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-label="Tab gallery" onClick={(event) => { if (!(event.target as Element).closest('.tab-gallery-card')) cancel(); }}>
    <div className="tab-gallery-grid" style={{ '--gallery-columns': columns } as CSSProperties}>
      {layout.map(({ tab, position }) => {
        const frame = frames.get(tab.id);
        const isSelected = tab.id === resolvedSelectedId;
        return <button
          key={tab.id}
          ref={(node) => { if (node) cardRefs.current.set(tab.id, node); else cardRefs.current.delete(tab.id); }}
          type="button"
          className={`tab-gallery-card${isSelected ? ' is-selected' : ''}${isBrowser(tab) ? ' is-browser' : ''}${frame?.showBezel ? ' has-bezel' : ''}`}
          style={{ gridRow: position.row + 1, gridColumn: position.column, '--gallery-ratio': String(frame?.aspectRatio ?? 1.333333) } as CSSProperties}
          aria-label={tabLabel(tab)}
          aria-selected={isSelected}
          onClick={() => finish(() => onChoose(tab.id), tab.id)}
        >
          <span className="tab-gallery-preview">
            {frame ? <canvas ref={(node) => frameCanvas(node, frame)} aria-hidden="true" /> : <span className="tab-gallery-placeholder"><span aria-hidden="true">{isBrowser(tab) ? '◎' : '▣'}</span><small>{isBrowser(tab) ? 'Browser tab' : 'No frame yet'}</small></span>}
          </span>
          <span className="tab-gallery-title">{tab.title}</span>
        </button>;
      })}
    </div>
  </div>;
}
