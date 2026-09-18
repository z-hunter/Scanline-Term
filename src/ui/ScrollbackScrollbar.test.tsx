import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { isSlowScrollbarDrag, ScrollbackScrollbar, scrollbackMetrics } from './ScrollbackScrollbar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('scrollbackMetrics', () => {
  it('returns no thumb when there is no scrollback', () => {
    expect(scrollbackMetrics({ viewportY: 0, baseY: 0, rows: 24 }, 600)).toBeNull();
  });

  it('maps the top, middle and bottom of the buffer', () => {
    const top = scrollbackMetrics({ viewportY: 0, baseY: 976, rows: 24 }, 600)!;
    const middle = scrollbackMetrics({ viewportY: 488, baseY: 976, rows: 24 }, 600)!;
    const bottom = scrollbackMetrics({ viewportY: 976, baseY: 976, rows: 24 }, 600)!;
    expect(top.thumbTop).toBe(0);
    expect(middle.thumbTop).toBeCloseTo((600 - middle.thumbHeight) / 2);
    expect(bottom.thumbTop).toBeCloseTo(600 - bottom.thumbHeight);
  });

  it('enforces the minimum grab height and clamps positions', () => {
    const metrics = scrollbackMetrics({ viewportY: 9999, baseY: 999, rows: 1 }, 600);
    expect(metrics!.thumbHeight).toBe(24);
    expect(metrics!.thumbTop).toBe(576);
    expect(scrollbackMetrics({ viewportY: -10, baseY: 10, rows: 24 }, 600)!.thumbTop).toBe(0);
  });

  it('adjusts the thumb when the visible row count changes', () => {
    const short = scrollbackMetrics({ viewportY: 500, baseY: 1000, rows: 24 }, 600)!;
    const tall = scrollbackMetrics({ viewportY: 500, baseY: 1000, rows: 48 }, 600)!;
    expect(tall.thumbHeight).toBeGreaterThan(short.thumbHeight);
  });

  it('uses smooth scrolling only for a slow thumb drag', () => {
    expect(isSlowScrollbarDrag(50, 100)).toBe(true);
    expect(isSlowScrollbarDrag(200, 100)).toBe(false);
  });

  it('measures the track when it appears after the first user scroll', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const rect = { width: 12, height: 600, top: 0, left: 0, right: 12, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);

    await act(async () => { root.render(createElement(ScrollbackScrollbar, { state: null, onScrollTo: vi.fn() })); });
    await act(async () => { root.render(createElement(ScrollbackScrollbar, { state: { sessionId: 'one', viewportY: 500, baseY: 1000, rows: 24, activity: 1 }, onScrollTo: vi.fn() })); });

    expect(container.querySelector('.scrollback-scrollbar-thumb')?.getAttribute('style')).toContain('translateY(288px)');
    await act(async () => root.unmount());
    measure.mockRestore();
    container.remove();
  });
});
