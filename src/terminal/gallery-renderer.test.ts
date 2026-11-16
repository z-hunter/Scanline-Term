import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fontCellSize, terminalPadding } from 'scanline-virtual-screen/terminal';
import type { CRTSettings } from 'scanline-virtual-screen/core';

const state = vi.hoisted(() => ({
  screenCreations: 0,
  terminalRendererCreations: 0,
  prepare: vi.fn(() => true), clearPersistence: vi.fn(), render: vi.fn(), disposeScreen: vi.fn(),
  bindTerminal: vi.fn(), cancelScroll: vi.fn(), resizeSource: vi.fn(), setFocused: vi.fn(), markDirty: vi.fn(), draw: vi.fn(), disposeTerminal: vi.fn(),
}));

vi.mock('scanline-virtual-screen/core', () => ({
  VirtualScreenRenderer: class {
    constructor() { state.screenCreations += 1; }
    prepare = state.prepare;
    clearPersistence = state.clearPersistence;
    render = state.render;
    dispose = state.disposeScreen;
  },
}));

vi.mock('scanline-virtual-screen/terminal', () => ({
  fontCellSize: (fontSize: number, _family: string, _context?: unknown, widthAdjustment = 0, heightAdjustment = 0) => ({ width: Math.max(1, Math.ceil(fontSize * 0.6) + widthAdjustment), height: Math.max(1, Math.ceil(fontSize * 1.2) + heightAdjustment) }),
  terminalPadding: (width: number, height: number) => Math.max(2, Math.floor(Math.min(width, height) * 0.01)),
  TerminalRenderer: class {
    constructor() { state.terminalRendererCreations += 1; }
    compositedCanvas = {};
    sourceCanvas = { width: 300, height: 150 };
    bindTerminal = state.bindTerminal;
    cancelScroll = state.cancelScroll;
    resizeSource = (width: number, height: number) => { state.resizeSource(width, height); state.markDirty(); this.sourceCanvas.width = width; this.sourceCanvas.height = height; };
    setFocused = state.setFocused;
    markDirty = state.markDirty;
    draw = state.draw;
    dispose = state.disposeTerminal;
  },
}));

import {
  galleryInitializationShouldStop,
  fitGalleryRasterSettings,
  galleryFrameLagShouldStop,
  galleryPreparationShouldStop,
  galleryPreparationTimedOut,
  galleryRenderShouldStop,
  GalleryRenderer,
  GALLERY_MAX_SOURCE_PIXELS,
  GALLERY_MAX_TERMINAL_RENDERERS,
  GALLERY_PREPARE_TIMEOUT_MS,
  GALLERY_RENDER_INTERVAL_MS,
  GALLERY_RENDER_MAX_INTERVAL_MS,
  nextGalleryRenderInterval,
} from './gallery-renderer';

beforeEach(() => { vi.clearAllMocks(); state.screenCreations = 0; state.terminalRendererCreations = 0; });

describe('gallery renderer budgets', () => {
  it('stops on slow captures or foreground RAF lag, but not background timing', () => {
    expect(galleryRenderShouldStop(50, 16, true)).toBe(false);
    expect(galleryRenderShouldStop(50.1, 16, true)).toBe(true);
    expect(galleryRenderShouldStop(2, 121, true)).toBe(false);
    expect(galleryRenderShouldStop(30, 1000, false)).toBe(false);
    expect(galleryFrameLagShouldStop(121, true, 0)).toBe(false);
    expect(galleryFrameLagShouldStop(121, true, 1)).toBe(true);
    expect(galleryFrameLagShouldStop(1000, false, 1)).toBe(false);
    expect(GALLERY_RENDER_INTERVAL_MS).toBe(100);
  });

  it('does not slow for a routine capture above 6ms, backs off after two captures over 16ms, and recovers after ten fast captures', () => {
    expect(nextGalleryRenderInterval(100, 6.7, 0, 0)).toEqual({ interval: 100, fastSamples: 1, slowSamples: 0 });
    expect(nextGalleryRenderInterval(100, 17, 0, 0)).toEqual({ interval: 100, fastSamples: 0, slowSamples: 1 });
    expect(nextGalleryRenderInterval(100, 17, 0, 1)).toEqual({ interval: 200, fastSamples: 0, slowSamples: 0 });
    let state = { interval: 500, fastSamples: 0, slowSamples: 0 };
    for (let i = 0; i < 9; i++) state = nextGalleryRenderInterval(state.interval, 10, state.fastSamples, state.slowSamples);
    expect(state).toEqual({ interval: 500, fastSamples: 9, slowSamples: 0 });
    state = nextGalleryRenderInterval(state.interval, 10, state.fastSamples, state.slowSamples);
    expect(state).toEqual({ interval: 250, fastSamples: 0, slowSamples: 0 });
    expect(nextGalleryRenderInterval(GALLERY_RENDER_MAX_INTERVAL_MS, 17, 0, 1)).toEqual({ interval: GALLERY_RENDER_MAX_INTERVAL_MS, fastSamples: 0, slowSamples: 0 });
    let slow = { interval: GALLERY_RENDER_INTERVAL_MS, fastSamples: 0, slowSamples: 0 };
    for (let i = 0; i < 20; i++) slow = nextGalleryRenderInterval(slow.interval, 17, slow.fastSamples, slow.slowSamples);
    expect(slow).toEqual({ interval: GALLERY_RENDER_MAX_INTERVAL_MS, fastSamples: 0, slowSamples: 0 });
    let base = { interval: GALLERY_RENDER_INTERVAL_MS, fastSamples: 0, slowSamples: 0 };
    for (let i = 0; i < 30; i++) base = nextGalleryRenderInterval(base.interval, 5, base.fastSamples, base.slowSamples);
    expect(base.interval).toBe(GALLERY_RENDER_INTERVAL_MS);
  });

  it('bounds nonblocking prepare polling separately from synchronous work', () => {
    expect(galleryPreparationShouldStop(50, true)).toBe(false);
    expect(galleryPreparationShouldStop(50.1, true)).toBe(true);
    expect(galleryPreparationShouldStop(30, false)).toBe(false);
    expect(galleryPreparationTimedOut(GALLERY_PREPARE_TIMEOUT_MS)).toBe(false);
    expect(galleryPreparationTimedOut(GALLERY_PREPARE_TIMEOUT_MS + 1)).toBe(true);
    expect(galleryInitializationShouldStop(50)).toBe(false);
    expect(galleryInitializationShouldStop(50.1)).toBe(true);
  });

  it('fits the complete xterm grid into landscape, portrait and DPR-scaled thumbnail rasters', () => {
    const base = { consoleFont: 'Consolas', fallbackFont: '', consoleFontSize: 16, cellWidthAdjustment: 2, cellHeightAdjustment: 1 } as CRTSettings;
    for (const [cols, rows, width, height, scale] of [[100, 30, 480, 270, 0.46875], [30, 100, 270, 480, 0.46875], [126, 35, 480, 360, 0.46875]] as const) {
      const fit = fitGalleryRasterSettings(base, cols, rows, width, height, scale);
      expect(fit).not.toBeNull();
      expect(fit!.consoleFontSize).toBeLessThanOrEqual(base.consoleFontSize * scale);
      const cell = fontCellSize(fit!.consoleFontSize, fit!.consoleFont, undefined, fit!.cellWidthAdjustment, fit!.cellHeightAdjustment, fit!.fallbackFont);
      expect(cols * cell.width).toBeLessThanOrEqual(width - terminalPadding(width, height) * 2);
      expect(rows * cell.height).toBeLessThanOrEqual(height - terminalPadding(width, height) * 2);
    }
  });

  it('continues scaling large cell adjustments when font size must shrink further', () => {
    const base = { consoleFont: 'Consolas', fallbackFont: '', consoleFontSize: 16, cellWidthAdjustment: 16, cellHeightAdjustment: 16 } as CRTSettings;
    const fit = fitGalleryRasterSettings(base, 100, 30, 480, 270, 0.25);
    expect(fit).not.toBeNull();
    expect(fit!.cellWidthAdjustment).toBeLessThan(4);
    expect(fit!.cellHeightAdjustment).toBeLessThan(4);
    const cell = fontCellSize(fit!.consoleFontSize, fit!.consoleFont, undefined, fit!.cellWidthAdjustment, fit!.cellHeightAdjustment, fit!.fallbackFont);
    expect(100 * cell.width).toBeLessThanOrEqual(480 - terminalPadding(480, 270) * 2);
    expect(30 * cell.height).toBeLessThanOrEqual(270 - terminalPadding(480, 270) * 2);
  });
});

describe('GalleryRenderer', () => {
  const source = (id: string, settings: Record<string, unknown> = {}, width = 640, height = 480) => ({ id, terminal: { cols: 100, rows: 30 } as never, settings: { consoleFontSize: 16, consoleFont: 'Consolas', cellWidthAdjustment: 0, cellHeightAdjustment: 0, ...settings } as never, images: [{ id: 'image', image: { complete: true, naturalWidth: 16 }, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] as never, width, height });
  const target = () => ({ width: 720, height: 540, getContext: vi.fn(() => ({ clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: false })) }) as unknown as HTMLCanvasElement;

  it('keeps one isolated compositor, prepares tab settings, and renders that tab’s images', () => {
    const gallery = new GalleryRenderer();
    const current = source('one', { persistence: 0.7, persistenceEnergy: 0.2, persistenceIntensity: 1, breathing: 0.8, crtEmulation: true } as never);
    state.prepare.mockReturnValueOnce(false).mockReturnValueOnce(true);

    expect(gallery.prepare(current)).toBe(false);
    expect(state.render).not.toHaveBeenCalled();
    expect(gallery.prepare(current)).toBe(true);
    gallery.render(current, target());

    expect(state.prepare).toHaveBeenCalledWith(expect.objectContaining({ persistence: 0, persistenceEnergy: 0, persistenceIntensity: 0, breathing: 0, channelSwitchEffect: false }));
    expect(state.bindTerminal).toHaveBeenCalledWith(current.terminal);
    expect(state.resizeSource).toHaveBeenCalledWith(480, 360);
    expect(state.setFocused).toHaveBeenCalledWith(false);
    expect(state.draw.mock.calls[0][1]).toMatchObject({ persistence: 0, breathing: 0 });
    expect(state.render).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ breathing: 0, persistence: 0 }), [expect.objectContaining({ id: 'image', x: 48, y: 72, width: 144, height: 144, zIndex: 1, opacity: 1 })], true);
    expect(state.clearPersistence).toHaveBeenCalledTimes(2);
    expect(state.screenCreations).toBe(1);
    gallery.dispose();
  });

  it('rejects oversized sources before preparing or rendering', () => {
    const gallery = new GalleryRenderer();
    expect(GALLERY_MAX_SOURCE_PIXELS).toBe(2_100_000);
    expect(() => gallery.prepare(source('large', {} as never, 2101, 1000))).toThrow(/pixel budget/);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.render).not.toHaveBeenCalled();
    gallery.dispose();
  });

  it('reuses the same compositor for multiple CRT masks and disposes it once', () => {
    const gallery = new GalleryRenderer();
    for (const [index, settings] of [{}, { bloom: 1 }, { glow: 1 }, { imperfectSignal: 1 }, { humBar: 1 }].entries()) {
      const current = source(`tab-${index}`, settings as never);
      expect(gallery.prepare(current)).toBe(true);
      gallery.render(current, target());
    }
    expect(state.screenCreations).toBe(1);
    expect(state.prepare).toHaveBeenCalledTimes(5);
    gallery.dispose();
    gallery.dispose();
    expect(state.disposeScreen).toHaveBeenCalledOnce();
    expect(state.terminalRendererCreations).toBe(5);
    expect(state.disposeTerminal).toHaveBeenCalledTimes(5);
  });

  it('does not force a terminal redraw for unchanged settings, but redraws when raster settings change', () => {
    const gallery = new GalleryRenderer();
    const first = source('one', { consoleFontSize: 16, consoleFont: 'Consolas' } as never);
    gallery.render(first, target());
    expect(state.render.mock.calls.at(-1)?.[3]).toBe(true);
    state.markDirty.mockClear();
    gallery.render(first, target());
    expect(state.render.mock.calls.at(-1)?.[3]).toBe(false);
    expect(state.resizeSource).toHaveBeenCalledOnce();
    expect(state.markDirty).not.toHaveBeenCalled();
    gallery.render({ ...first, settings: { consoleFontSize: 16, consoleFont: 'Consolas', cellWidthAdjustment: 0, cellHeightAdjustment: 0, colorProfile: 'amber' } as never }, target());
    expect(state.markDirty).toHaveBeenCalledOnce();
    expect(state.render.mock.calls.at(-1)?.[3]).toBe(true);
    gallery.dispose();
  });

  it('forces a fresh shared compositor frame when switching between tabs', () => {
    const gallery = new GalleryRenderer();
    const first = source('one');
    const second = source('two');
    gallery.render(first, target());
    gallery.render(second, target());
    gallery.render(first, target());
    expect(state.render.mock.calls.map((call) => call[3])).toEqual([true, true, true]);
    gallery.dispose();
  });

  it('stops admission at the per-tab raster cache limit without renderer churn', () => {
    const gallery = new GalleryRenderer();
    for (let index = 0; index < GALLERY_MAX_TERMINAL_RENDERERS; index++) gallery.render(source(`tab-${index}`), target());
    expect(() => gallery.render(source('overflow'), target())).toThrow(/renderer limit/);
    expect(state.screenCreations).toBe(1);
    expect(state.terminalRendererCreations).toBe(GALLERY_MAX_TERMINAL_RENDERERS);
    expect(state.disposeTerminal).not.toHaveBeenCalled();
    gallery.dispose();
    expect(state.disposeTerminal).toHaveBeenCalledTimes(GALLERY_MAX_TERMINAL_RENDERERS);
    gallery.dispose();
    expect(state.disposeTerminal).toHaveBeenCalledTimes(GALLERY_MAX_TERMINAL_RENDERERS);
  });

  it('disposes cached terminal renderers when source tabs disappear', () => {
    const gallery = new GalleryRenderer();
    const current = source('one');
    gallery.render(current, target());
    expect(state.disposeTerminal).not.toHaveBeenCalled();
    gallery.retainSources([]);
    expect(state.disposeTerminal).toHaveBeenCalledOnce();
    gallery.retainSources([current]);
    gallery.render(current, target());
    expect(state.terminalRendererCreations).toBe(2);
    gallery.dispose();
    expect(state.disposeTerminal).toHaveBeenCalledTimes(2);
  });
});
