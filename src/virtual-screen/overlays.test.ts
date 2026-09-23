import { describe, expect, it, vi } from 'vitest';
import { normalizedOverlay, OverlayCompositor } from './overlays';

describe('OverlayCompositor', () => {
  it('converts normalized coordinates to virtual pixels', () => {
    const source = {} as CanvasImageSource;
    const overlay = normalizedOverlay({ id: 'image', source, x: .25, y: .1, width: .5, height: .4 }, 640, 480, 2);
    expect(overlay).toMatchObject({ x: 160, y: 48, width: 320, height: 192, zIndex: 2 });
  });

  it('draws source and overlays in stable z-order with opacity', () => {
    const calls: unknown[][] = [];
    const context = { globalAlpha: 1, clearRect: vi.fn(), drawImage: vi.fn((...args: unknown[]) => calls.push(args)) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const compositor = new OverlayCompositor();
    const source = document.createElement('canvas'); source.width = 100; source.height = 80;
    const bottom = { id: 'bottom', source: {} as CanvasImageSource, x: 1, y: 2, width: 3, height: 4, zIndex: 0 };
    const top = { id: 'top', source: {} as CanvasImageSource, x: 5, y: 6, width: 7, height: 8, zIndex: 2, opacity: .5 };
    expect(compositor.compose(source, [top, bottom])).toBe(true);
    expect(calls[0]?.[0]).toBe(source);
    expect(calls[1]?.[0]).toBe(bottom.source);
    expect(calls[2]?.[0]).toBe(top.source);
    expect(context.globalAlpha).toBe(1);
  });
});
