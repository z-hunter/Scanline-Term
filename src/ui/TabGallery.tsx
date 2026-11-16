import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BrowserTab, WorkspaceTab } from '../terminal/useTerminal';
import { GalleryRenderer, GALLERY_FRAME_LAG_MS, GALLERY_RENDER_INTERVAL_MS, GALLERY_THUMBNAIL_MAX_DIMENSION, galleryFrameLagShouldStop, galleryInitializationShouldStop, galleryPreparationShouldStop, galleryPreparationTimedOut, galleryRenderShouldStop, nextGalleryRenderInterval, type GalleryRenderSource } from '../terminal/gallery-renderer';

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

export function galleryCanvasSize(width: number, height: number): { width: number; height: number } {
  const scale = GALLERY_THUMBNAIL_MAX_DIMENSION / Math.max(width, height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
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

function frameCanvas(node: HTMLCanvasElement | null, frame: GalleryFrame | undefined, source?: GalleryRenderSource): void {
  if (!node || !frame) return;
  const size = source ? galleryCanvasSize(source.width, source.height) : { width: frame.canvas.width, height: frame.canvas.height };
  if (node.width !== size.width) node.width = size.width;
  if (node.height !== size.height) node.height = size.height;
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
  getRenderSources,
  originRect,
  onChoose,
  onMove = () => undefined,
  onCancel,
  closeRequested = false,
}: {
  tabs: WorkspaceTab[];
  activeId: string | null;
  frames: ReadonlyMap<string, GalleryFrame>;
  getRenderSources?: () => GalleryRenderSource[];
  originRect: DOMRect | null;
  onChoose: (id: string) => void;
  onMove?: (id: string, targetIndex: number) => void;
  onCancel: () => void;
  closeRequested?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousRects = useRef(new Map<string, DOMRect>());
  const menuHeld = useRef(false);
  const entryAnimation = useRef(false);
  const skipNextLayoutAnimation = useRef(false);
  const [columns, setColumns] = useState(() => galleryColumns(window.innerWidth, tabs.length));
  const [visible, setVisible] = useState(false);
  const [selectedId, setSelectedId] = useState(activeId ?? tabs[0]?.id ?? null);
  const [closing, setClosing] = useState(false);
  const [, setPreviewVersion] = useState(0);
  const renderedPreviewIds = useRef(new Set<string>());
  const staticFrameCanvases = useRef(new WeakSet<HTMLCanvasElement>());
  const timer = useRef<number | null>(null);
  const layout = useMemo(() => buildGalleryLayout(tabs, activeId, columns), [tabs, activeId, columns]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const layoutKey = layout.map(({ tab, position }) => `${tab.id}:${position.row},${position.column}`).join('|');
  const previousLayoutKey = useRef(layoutKey);
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
    const target = card.getBoundingClientRect();
    previousRects.current = new Map(layout.map(({ tab }) => [tab.id, cardRefs.current.get(tab.id)?.getBoundingClientRect() ?? new DOMRect()]));
    skipNextLayoutAnimation.current = true;
    if (!originRect || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const x = originRect.left - target.left;
    const y = originRect.top - target.top;
    const sx = originRect.width / Math.max(1, target.width);
    const sy = originRect.height / Math.max(1, target.height);
    card.animate(
      [{ transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`, opacity: 0.92 }, { transform: 'translate(0, 0) scale(1)', opacity: 1 }],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    );
  }, [layout, originRect, resolvedSelectedId]);

  useLayoutEffect(() => {
    if (skipNextLayoutAnimation.current) {
      skipNextLayoutAnimation.current = false;
      previousLayoutKey.current = layoutKey;
      return;
    }
    const layoutChanged = previousLayoutKey.current !== layoutKey;
    const currentLayout = layoutRef.current;
    const previous = previousRects.current;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const nextRects = new Map(currentLayout.map(({ tab }) => [tab.id, cardRefs.current.get(tab.id)?.getBoundingClientRect() ?? new DOMRect()]));
    if (layoutChanged && !reduced) currentLayout.forEach(({ tab }) => {
      const node = cardRefs.current.get(tab.id); const oldRect = previous.get(tab.id); const nextRect = nextRects.get(tab.id);
      if (!node || !oldRect || !nextRect) return;
      const dx = oldRect.left - nextRect.left; const dy = oldRect.top - nextRect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
    previousRects.current = nextRects;
    previousLayoutKey.current = layoutKey;
  });

  useEffect(() => {
    if (!resolvedSelectedId) return;
    const frame = window.requestAnimationFrame(() => cardRefs.current.get(resolvedSelectedId)?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedSelectedId]);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!getRenderSources || closing) return;
    let renderer: GalleryRenderer;
    let renderInterval = GALLERY_RENDER_INTERVAL_MS;
    let fastRenderSamples = 0;
    let slowRenderSamples = 0;
    const initializationStart = performance.now();
    try {
      renderer = new GalleryRenderer();
      const initializationDuration = performance.now() - initializationStart;
      if (galleryInitializationShouldStop(initializationDuration)) {
        renderer.dispose();
        return;
      }
    } catch {
      return;
    }
    let raf = 0;
    let lastFrame = 0;
    let lastCapture = 0;
    let slowFrameStreak = 0;
    let preparePollAfter = 0;
    let index = 0;
    let pendingTabId: string | null = null;
    let pendingSince = 0;
    let stopped = false;
    let disposed = false;
    const disposeRenderer = () => { if (!disposed) { disposed = true; renderer.dispose(); } };
    const stopUpdates = () => { stopped = true; disposeRenderer(); };
    const recordCaptureDuration = (duration: number) => {
      const next = nextGalleryRenderInterval(renderInterval, duration, fastRenderSamples, slowRenderSamples);
      renderInterval = next.interval;
      fastRenderSamples = next.fastSamples;
      slowRenderSamples = next.slowSamples;
    };
    const resetFrameBaseline = () => { lastFrame = 0; slowFrameStreak = 0; preparePollAfter = 0; if (pendingTabId) pendingSince = 0; };
    window.addEventListener('focus', resetFrameBaseline);
    window.addEventListener('blur', resetFrameBaseline);
    document.addEventListener('visibilitychange', resetFrameBaseline);
    const tick = (now: number) => {
      if (stopped) return;
      const visibleWindow = document.visibilityState === 'visible' && document.hasFocus();
      const frameLag = lastFrame ? now - lastFrame : 0;
      lastFrame = now;
      if (visibleWindow && frameLag > GALLERY_FRAME_LAG_MS) {
        if (galleryFrameLagShouldStop(frameLag, true, slowFrameStreak)) { stopUpdates(); return; }
        slowFrameStreak += 1;
        raf = window.requestAnimationFrame(tick);
        return;
      }
      if (visibleWindow) slowFrameStreak = 0;
      if (visibleWindow) {
        const sources = getRenderSources();
        renderer.retainSources(sources);
        if (pendingTabId && !sources.some(({ id }) => id === pendingTabId)) {
          pendingTabId = null;
          preparePollAfter = 0;
          index += 1;
        }
        if (!pendingTabId && now - lastCapture >= renderInterval && sources.length) {
          pendingTabId = sources[index % sources.length].id;
          pendingSince = now;
          preparePollAfter = 0;
        }
        const source = pendingTabId ? sources.find(({ id }) => id === pendingTabId) : undefined;
        if (pendingTabId && !pendingSince) pendingSince = now;
        const card = source ? cardRefs.current.get(source.id)?.querySelector<HTMLCanvasElement>('.tab-gallery-preview canvas') : null;
        if (source && pendingTabId && !card) { pendingTabId = null; index += 1; }
        if (source && pendingTabId && card && now >= preparePollAfter) {
          try {
            const prepareStarted = performance.now();
            const ready = renderer.prepare(source);
            const afterPrepare = performance.now();
            const foregroundAfterPrepare = document.visibilityState === 'visible' && document.hasFocus();
            if (galleryPreparationShouldStop(afterPrepare - prepareStarted, foregroundAfterPrepare)) { stopUpdates(); return; }
            preparePollAfter = 0;
            if (ready) {
              const renderStarted = performance.now();
              renderer.render(source, card);
              const renderDuration = performance.now() - renderStarted;
              if (!renderedPreviewIds.current.has(source.id)) {
                renderedPreviewIds.current.add(source.id);
                setPreviewVersion((version) => version + 1);
              }
              pendingTabId = null;
              index += 1;
              lastCapture = now;
              const foregroundAfterRender = document.visibilityState === 'visible' && document.hasFocus();
              if (galleryRenderShouldStop(renderDuration, frameLag, foregroundAfterRender)) { stopUpdates(); return; }
              if (foregroundAfterRender) recordCaptureDuration(renderDuration);
            } else if (galleryPreparationTimedOut(now - pendingSince)) {
              stopUpdates();
              return;
            }
          } catch {
            stopUpdates();
            return;
          }
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => { stopped = true; window.cancelAnimationFrame(raf); window.removeEventListener('focus', resetFrameBaseline); window.removeEventListener('blur', resetFrameBaseline); document.removeEventListener('visibilitychange', resetFrameBaseline); disposeRenderer(); };
  }, [closing, getRenderSources]);

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
    if (!closeRequested) return;
    const frame = window.requestAnimationFrame(cancel);
    return () => window.cancelAnimationFrame(frame);
  }, [cancel, closeRequested]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (closing) return;
      if (event.code === 'ContextMenu') { menuHeld.current = true; return; }
      if (menuHeld.current && event.shiftKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight' || event.code === 'ArrowUp' || event.code === 'ArrowDown' || event.code === 'KeyH' || event.code === 'KeyJ' || event.code === 'KeyK' || event.code === 'KeyL')) {
        const currentIndex = tabs.findIndex((tab) => tab.id === resolvedSelectedId);
        const current = layout.find((item) => item.tab.id === resolvedSelectedId);
        let targetId: string | null = null;
        if (event.code === 'ArrowLeft' || event.code === 'KeyH') targetId = tabs[currentIndex - 1]?.id ?? null;
        else if (event.code === 'ArrowRight' || event.code === 'KeyL') targetId = tabs[currentIndex + 1]?.id ?? null;
        else if (current) targetId = nearestInColumn(layout, current.position.row, current.position.column, event.code === 'ArrowUp' || event.code === 'KeyK' ? -1 : 1);
        const targetIndex = targetId ? tabs.findIndex((tab) => tab.id === targetId) : -1;
        if (resolvedSelectedId && targetIndex >= 0 && targetIndex !== currentIndex) onMove(resolvedSelectedId, targetIndex);
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
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
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'ContextMenu') menuHeld.current = false; };
    const onBlur = () => { menuHeld.current = false; };
    window.addEventListener('keyup', onKeyUp, true); window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('blur', onBlur); };
  }, [cancel, closing, finish, layout, onChoose, onMove, resolvedSelectedId, tabs]);

  const renderSources = getRenderSources?.() ?? [];
  const renderSourceById = new Map(renderSources.map((source) => [source.id, source]));

  return <div ref={dialogRef} className={`tab-gallery${visible ? ' is-visible' : ''}${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-label="Tab gallery" onClick={(event) => { if (!(event.target as Element).closest('.tab-gallery-card')) cancel(); }}>
    <div className="tab-gallery-grid" style={{ '--gallery-columns': columns } as CSSProperties}>
      {layout.map(({ tab, position }) => {
        const frame = frames.get(tab.id);
        const renderSource = tab.kind === 'browser' ? undefined : renderSourceById.get(tab.id);
        const showLivePreview = Boolean(renderSource && renderedPreviewIds.current.has(tab.id));
        const showFrame = !showLivePreview && Boolean(frame);
        const showPreviewCanvas = showLivePreview || showFrame || Boolean(renderSource);
        const showPlaceholder = !showLivePreview && !frame;
        const isSelected = tab.id === resolvedSelectedId;
        return <button
          key={tab.id}
          ref={(node) => { if (node) cardRefs.current.set(tab.id, node); else cardRefs.current.delete(tab.id); }}
          type="button"
          className={`tab-gallery-card${isSelected ? ' is-selected' : ''}${isBrowser(tab) ? ' is-browser' : ''}${(showLivePreview ? Boolean(renderSource?.settings.crtEmulation && renderSource.settings.showBezel) : Boolean(showFrame && frame?.showBezel)) ? ' has-bezel' : ''}`}
          style={{ gridRow: position.row + 1, gridColumn: position.column, '--gallery-ratio': String(showLivePreview && renderSource ? renderSource.width / renderSource.height : frame?.aspectRatio ?? 1.333333) } as CSSProperties}
          aria-label={tabLabel(tab)}
          aria-selected={isSelected}
          onClick={() => finish(() => onChoose(tab.id), tab.id)}
        >
          <span className="tab-gallery-preview">
            {showPreviewCanvas && <canvas ref={(node) => { if (!node || renderedPreviewIds.current.has(tab.id)) return; if (frame && !staticFrameCanvases.current.has(node)) { frameCanvas(node, frame, renderSource); staticFrameCanvases.current.add(node); } else if (!frame && renderSource) { const size = galleryCanvasSize(renderSource.width, renderSource.height); if (node.width !== size.width) node.width = size.width; if (node.height !== size.height) node.height = size.height; } }} aria-hidden="true" />}
            {showPlaceholder && <span className="tab-gallery-placeholder"><span aria-hidden="true">{isBrowser(tab) ? '◎' : '▣'}</span><small>{isBrowser(tab) ? 'Browser tab' : 'No frame yet'}</small></span>}
          </span>
          <span className="tab-gallery-title">{tab.title}</span>
        </button>;
      })}
    </div>
  </div>;
}
