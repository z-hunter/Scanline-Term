import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalTab } from '../terminal/useTerminal';
import { buildGalleryLayout, galleryColumns, TabGallery } from './TabGallery';

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
  it('adds columns only after a readable 400px card fits', () => {
    expect(galleryColumns(1440, 10)).toBe(3);
    expect(galleryColumns(2560, 10)).toBe(5);
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
});
