import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalTab } from '../terminal/useTerminal';
import { buildGalleryLayout, galleryCanvasSize, galleryColumns, TabGallery } from './TabGallery';

const preview = vi.hoisted(() => ({
  prepare: vi.fn(() => false), render: vi.fn(), dispose: vi.fn(), stop: vi.fn(() => false),
}));
vi.mock('../terminal/gallery-renderer', () => ({
  GalleryRenderer: class { prepare = preview.prepare; render = preview.render; retainSources = vi.fn(); dispose = preview.dispose; },
  GALLERY_FRAME_LAG_MS: 120,
  GALLERY_RENDER_INTERVAL_MS: 100,
  GALLERY_RENDER_MAX_INTERVAL_MS: 500,
  GALLERY_THUMBNAIL_MAX_DIMENSION: 480,
  galleryFrameLagShouldStop: () => false,
  galleryInitializationShouldStop: () => false,
  galleryPreparationShouldStop: () => false,
  galleryPreparationTimedOut: (duration: number) => duration > 2_000,
  galleryRenderShouldStop: () => preview.stop(),
  nextGalleryRenderInterval: (interval: number, duration: number, fastSamples: number, slowSamples: number) => ({ interval: duration > 16 && slowSamples ? Math.min(500, interval * 2) : interval, fastSamples: duration <= 16 ? fastSamples + 1 : 0, slowSamples: duration > 16 ? (slowSamples ? 0 : 1) : 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tabs: TerminalTab[] = Array.from({ length: 7 }, (_, index) => ({
  id: `tab-${index + 1}`,
  ordinal: index + 1,
  title: `${index + 1}. shell-${index + 1}`,
  status: 'running',
  background: '#000000',
  foreground: '#ffffff',
}));

describe('TabGallery', () => {
  beforeEach(() => vi.clearAllMocks());
  it('adds columns only after a readable 400px card fits', () => {
    expect(galleryColumns(1440, 10)).toBe(3);
    expect(galleryColumns(2560, 10)).toBe(5);
  });

  it('bounds live preview backing dimensions while preserving source aspect ratio', () => {
    expect(galleryCanvasSize(1920, 1080)).toEqual({ width: 480, height: 270 });
    expect(galleryCanvasSize(800, 1200)).toEqual({ width: 320, height: 480 });
  });

  it('keeps live preview canvas dimensions across rerenders', () => {
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
    let dimensionWrites = 0;
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', { configurable: true, get: widthDescriptor?.get, set(value: number) { dimensionWrites++; widthDescriptor?.set?.call(this, value); } });
    Object.defineProperty(HTMLCanvasElement.prototype, 'height', { configurable: true, get: heightDescriptor?.get, set(value: number) { dimensionWrites++; heightDescriptor?.set?.call(this, value); } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const source = { id: 'tab-1', terminal: {}, settings: {}, images: [], width: 1920, height: 1080 } as never;
    const props = { tabs: tabs.slice(0, 1), activeId: 'tab-1', frames: new Map(), originRect: null, getRenderSources: () => [source], onChoose: vi.fn(), onCancel: vi.fn() };
    try {
      act(() => root.render(createElement(TabGallery, props)));
      const canvas = container.querySelector('canvas');
      expect(canvas && [canvas.width, canvas.height]).toEqual([480, 270]);
      const writesAfterMount = dimensionWrites;
      act(() => root.render(createElement(TabGallery, { ...props, tabs: [{ ...tabs[0], title: 'updated' }] })));
      expect(dimensionWrites).toBe(writesAfterMount);
      act(() => root.unmount());
    } finally {
      container.remove();
      if (widthDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, 'width', widthDescriptor); else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'width');
      if (heightDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, 'height', heightDescriptor); else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'height');
    }
  });

  it('shows the cached frame until the live renderer replaces it and leaves an empty live canvas when no frame exists', () => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const drawImage = vi.fn();
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({ clearRect: vi.fn(), drawImage, imageSmoothingEnabled: false }) });
    const cachedCanvas = document.createElement('canvas');
    cachedCanvas.width = 640;
    cachedCanvas.height = 480;
    const source = { id: 'tab-1', terminal: {}, settings: {}, images: [], width: 1920, height: 1080 } as never;
    const frames = new Map([['tab-1', { canvas: cachedCanvas, aspectRatio: 4 / 3, showBezel: false }]]);
    const props = { tabs: tabs.slice(0, 1), activeId: 'tab-1', frames, originRect: null, getRenderSources: () => [source], onChoose: vi.fn(), onCancel: vi.fn() };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(TabGallery, props)));
      const cardCanvas = container.querySelector('canvas');
      expect(cardCanvas).not.toBeNull();
      expect(drawImage).toHaveBeenCalledWith(cachedCanvas, 0, 0);
      act(() => root.render(createElement(TabGallery, { ...props, tabs: [{ ...tabs[0], title: 'updated' }] })));
      expect(drawImage).toHaveBeenCalledTimes(1);

      const noFrameProps = { ...props, tabs: tabs.slice(1, 2).map((tab) => ({ ...tab, id: 'tab-without-frame' })), activeId: 'tab-without-frame', frames: new Map(), getRenderSources: () => [{ id: 'tab-without-frame', terminal: {}, settings: {}, images: [], width: 1920, height: 1080 } as never] };
      act(() => root.render(createElement(TabGallery, noFrameProps)));
      expect(container.querySelector('canvas')).not.toBeNull();
      expect(container.querySelector('.tab-gallery-placeholder')).not.toBeNull();
      act(() => root.unmount());
    } finally {
      container.remove();
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: originalGetContext });
    }
  });

  it('places the active tab in the center row and overflows in tab order', () => {
    const layout = buildGalleryLayout(tabs, 'tab-4', 3);
    const position = new Map(layout.map((item) => [item.tab.id, item.position]));
    expect(position.get('tab-4')).toEqual({ row: 1, column: 2 });
    expect(position.get('tab-1')).toEqual({ row: 0, column: 2 });
    expect(position.get('tab-3')).toEqual({ row: 1, column: 1 });
    expect(position.get('tab-5')).toEqual({ row: 1, column: 3 });
    expect(position.get('tab-6')).toEqual({ row: 2, column: 1 });
  });

  it('keeps every tab in one row when they all fit', () => {
    const layout = buildGalleryLayout(tabs.slice(0, 3), 'tab-3', 3);
    expect(layout.map(({ tab, position }) => [tab.id, position])).toEqual([
      ['tab-1', { row: 0, column: 1 }],
      ['tab-2', { row: 0, column: 2 }],
      ['tab-3', { row: 0, column: 3 }],
    ]);
  });

  it('moves selection and commits it with Enter', () => {
    vi.useFakeTimers();
    const animate = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(TabGallery, { tabs, activeId: 'tab-4', frames: new Map(), originRect: null, onChoose, onCancel })));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', bubbles: true, cancelable: true })));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="3. shell-3 — terminal tab"]')?.getAttribute('aria-selected')).toBe('true');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true, cancelable: true })));
    act(() => vi.advanceTimersByTime(180));
    expect(onChoose).toHaveBeenCalledWith('tab-3');
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('walks tabs in ordinal order and opens a numbered tab immediately', () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const onChoose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(TabGallery, { tabs, activeId: 'tab-4', frames: new Map(), originRect: null, onChoose, onCancel: vi.fn() })));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true })));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="6. shell-6 — terminal tab"]')?.getAttribute('aria-selected')).toBe('true');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true, cancelable: true })));
    act(() => vi.advanceTimersByTime(180));
    expect(onChoose).toHaveBeenCalledWith('tab-2');
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('reorders the selected card one step with Menu+Shift', () => {
    const onMove = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(TabGallery, { tabs, activeId: 'tab-4', frames: new Map(), originRect: null, onChoose: vi.fn(), onMove, onCancel: vi.fn() })));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ContextMenu', bubbles: true, cancelable: true })));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true })));
    expect(onMove).toHaveBeenCalledWith('tab-4', 4);
    act(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ContextMenu', bubbles: true })));
    act(() => root.unmount());
    container.remove();
  });

  it('animates card reordering but ignores geometry changes from tab metadata updates', () => {
    const animate = vi.fn();
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
    let geometryOffset = 0;
    try {
      Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value(this: HTMLElement) {
          if (this.classList.contains('tab-gallery-card')) return new DOMRect(0, (Number(this.style.gridRow) - 1) * 328 + geometryOffset, 400, 300);
          return originalRect?.value.call(this) ?? new DOMRect();
        },
      });
      const galleryTabs = tabs.slice(0, 3);
      const props = { tabs: galleryTabs, activeId: 'tab-1', frames: new Map(), originRect: null, onChoose: vi.fn(), onCancel: vi.fn() };
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      act(() => root.render(createElement(TabGallery, props)));

      geometryOffset = 4;
      const updatedTabs = galleryTabs.map((tab) => tab.id === 'tab-1' ? { ...tab, background: '#111111' } : tab);
      act(() => root.render(createElement(TabGallery, { ...props, tabs: updatedTabs })));
      expect(animate).not.toHaveBeenCalled();

      const reorderedTabs = [updatedTabs[1], updatedTabs[0], updatedTabs[2]];
      act(() => root.render(createElement(TabGallery, { ...props, tabs: reorderedTabs })));
      expect(animate).toHaveBeenCalledTimes(2);

      act(() => root.unmount());
      container.remove();
    } finally {
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
      if (originalRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', originalRect);
      else Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect');
    }
  });

  it('does not replay the entry animation on a no-op rerender', () => {
    const animate = vi.fn();
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    try {
      Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
      const props = { tabs, activeId: 'tab-4', frames: new Map(), originRect: new DOMRect(10, 10, 100, 100), onChoose: vi.fn(), onCancel: vi.fn() };
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      act(() => root.render(createElement(TabGallery, props)));
      act(() => root.render(createElement(TabGallery, props)));
      expect(animate).toHaveBeenCalledOnce();
      act(() => root.unmount());
      container.remove();
    } finally {
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

  it('cancels from Escape or the gallery background', () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const onCancel = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(TabGallery, { tabs, activeId: 'tab-4', frames: new Map(), originRect: null, onChoose: vi.fn(), onCancel })));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true })));
    act(() => vi.advanceTimersByTime(180));
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    const secondRoot = createRoot(container);
    act(() => secondRoot.render(createElement(TabGallery, { tabs, activeId: 'tab-4', frames: new Map(), originRect: null, onChoose: vi.fn(), onCancel })));
    act(() => container.querySelector<HTMLElement>('[role="dialog"]')?.click());
    act(() => vi.advanceTimersByTime(180));
    expect(onCancel).toHaveBeenCalledTimes(2);
    act(() => secondRoot.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('closes when requested by its parent', () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn() });
    const onCancel = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = { tabs, activeId: 'tab-4', frames: new Map(), originRect: null, onChoose: vi.fn(), onCancel };
    act(() => root.render(createElement(TabGallery, props)));
    act(() => root.render(createElement(TabGallery, { ...props, closeRequested: true })));
    act(() => vi.runAllTimers());
    expect(onCancel).toHaveBeenCalledOnce();
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('keeps polling an async shader prepare, skips a source that disappears, and disposes on close', () => {
    const originalRaf = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    const originalCancelRaf = Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame');
    const originalFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    const callbacks: FrameRequestCallback[] = [];
    let requestId = 0;
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { callbacks.push(callback); return ++requestId; } });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: vi.fn() });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn() });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let sources: unknown[] = [{ id: 'tab-1', terminal: {}, settings: {}, images: [], width: 640, height: 480 }];
    const flush = (now: number) => {
      const current = callbacks.splice(0);
      act(() => current.forEach((callback) => callback(now)));
    };
    try {
      act(() => root.render(createElement(TabGallery, { tabs, activeId: 'tab-1', frames: new Map(), originRect: null, getRenderSources: () => sources as never, onChoose: vi.fn(), onCancel: vi.fn() })));
      flush(0);
      flush(100);
      expect(preview.prepare).toHaveBeenCalledOnce();
      expect(preview.render).not.toHaveBeenCalled();

      sources = [];
      flush(116);
      expect(preview.prepare).toHaveBeenCalledOnce();
      act(() => root.unmount());
      expect(preview.dispose).toHaveBeenCalledOnce();
    } finally {
      container.remove();
      if (originalRaf) Object.defineProperty(window, 'requestAnimationFrame', originalRaf); else Reflect.deleteProperty(window, 'requestAnimationFrame');
      if (originalCancelRaf) Object.defineProperty(window, 'cancelAnimationFrame', originalCancelRaf); else Reflect.deleteProperty(window, 'cancelAnimationFrame');
      if (originalFocus) Object.defineProperty(document, 'hasFocus', originalFocus); else Reflect.deleteProperty(document, 'hasFocus');
    }
  });

  it('shows static placeholders and disposes when async preparation times out', () => {
    const originalRaf = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    const originalCancelRaf = Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame');
    const originalFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    const callbacks: FrameRequestCallback[] = [];
    let requestId = 0;
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { callbacks.push(callback); return ++requestId; } });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: vi.fn() });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn() });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const flush = (now: number) => {
      const current = callbacks.splice(0);
      act(() => current.forEach((callback) => callback(now)));
    };
    try {
      act(() => root.render(createElement(TabGallery, { tabs, activeId: 'tab-1', frames: new Map(), originRect: null, getRenderSources: () => [{ id: 'tab-1', terminal: {}, settings: {}, images: [], width: 640, height: 480 }] as never, onChoose: vi.fn(), onCancel: vi.fn() })));
      flush(0);
      for (let now = 100; now <= 2200 && !preview.dispose.mock.calls.length; now += 100) flush(now);
      expect(preview.prepare).toHaveBeenCalled();
      expect(preview.prepare.mock.calls.length).toBeGreaterThan(10);
      expect(preview.render).not.toHaveBeenCalled();
      expect(container.querySelector('.tab-gallery-placeholder')).not.toBeNull();
      expect(preview.dispose).toHaveBeenCalledOnce();
      act(() => root.unmount());
      expect(preview.dispose).toHaveBeenCalledOnce();
    } finally {
      container.remove();
      if (originalRaf) Object.defineProperty(window, 'requestAnimationFrame', originalRaf); else Reflect.deleteProperty(window, 'requestAnimationFrame');
      if (originalCancelRaf) Object.defineProperty(window, 'cancelAnimationFrame', originalCancelRaf); else Reflect.deleteProperty(window, 'cancelAnimationFrame');
      if (originalFocus) Object.defineProperty(document, 'hasFocus', originalFocus); else Reflect.deleteProperty(document, 'hasFocus');
    }
  });
});
