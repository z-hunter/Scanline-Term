import type { Terminal } from '@xterm/xterm';
import { VirtualScreenRenderer, type CRTSettings, type ScreenOverlay } from 'scanline-virtual-screen/core';
import { fontCellSize, terminalPadding, TerminalRenderer } from 'scanline-virtual-screen/terminal';
import type { TerminalImage } from './ScanlineTerminalRenderer';

export const GALLERY_RENDER_INTERVAL_MS = 100;
export const GALLERY_RENDER_BUDGET_MS = 16;
export const GALLERY_RENDER_MAX_INTERVAL_MS = 500;
export const GALLERY_RENDER_FAST_SAMPLES = 10;
export const GALLERY_RENDER_SLOW_SAMPLES = 2;
export const GALLERY_RENDER_HARD_BUDGET_MS = 50;
export const GALLERY_FRAME_LAG_MS = 120;
export const GALLERY_RENDER_INIT_BUDGET_MS = 50;
export const GALLERY_PREPARE_TIMEOUT_MS = 5_000;
export const GALLERY_MAX_SOURCE_PIXELS = 2_100_000;
export const GALLERY_THUMBNAIL_MAX_DIMENSION = 480;
export const GALLERY_MAX_TERMINAL_RENDERERS = 8;

export type GalleryRenderSource = { id: string; terminal: Terminal; settings: CRTSettings; images: TerminalImage[]; width: number; height: number };

export function fitGalleryRasterSettings(settings: CRTSettings, cols: number, rows: number, width: number, height: number, scale: number): CRTSettings | null {
  const padding = terminalPadding(width, height);
  const minFontSize = 1;
  const baseFontSize = Math.max(minFontSize, settings.consoleFontSize);
  for (let fontSize = Math.max(minFontSize, baseFontSize * scale); fontSize >= minFontSize; fontSize = Math.max(minFontSize, fontSize - 0.25)) {
    const adjustmentScale = fontSize / baseFontSize;
    const cellWidthAdjustment = (settings.cellWidthAdjustment ?? 0) * adjustmentScale;
    const cellHeightAdjustment = (settings.cellHeightAdjustment ?? 0) * adjustmentScale;
    const candidate = { ...settings, consoleFontSize: fontSize, cellWidthAdjustment, cellHeightAdjustment };
    const cell = fontCellSize(fontSize, settings.consoleFont, undefined, cellWidthAdjustment, cellHeightAdjustment, settings.fallbackFont);
    if (cols * cell.width <= width - padding * 2 && rows * cell.height <= height - padding * 2) return candidate;
    if (fontSize === minFontSize) break;
  }
  return null;
}

export function galleryRenderShouldStop(duration: number, _frameLag: number, visible: boolean): boolean {
  return visible && duration > GALLERY_RENDER_HARD_BUDGET_MS;
}

export function galleryFrameLagShouldStop(frameLag: number, visible: boolean, consecutiveSlowFrames: number): boolean {
  return visible && frameLag > GALLERY_FRAME_LAG_MS && consecutiveSlowFrames > 0;
}

export function nextGalleryRenderInterval(interval: number, duration: number, fastSamples: number, slowSamples: number): { interval: number; fastSamples: number; slowSamples: number } {
  if (duration > GALLERY_RENDER_BUDGET_MS) {
    const nextSlowSamples = slowSamples + 1;
    return nextSlowSamples >= GALLERY_RENDER_SLOW_SAMPLES
      ? { interval: Math.min(GALLERY_RENDER_MAX_INTERVAL_MS, Math.max(GALLERY_RENDER_INTERVAL_MS, interval * 2)), fastSamples: 0, slowSamples: 0 }
      : { interval, fastSamples: 0, slowSamples: nextSlowSamples };
  }
  const nextFastSamples = fastSamples + 1;
  return nextFastSamples >= GALLERY_RENDER_FAST_SAMPLES
    ? { interval: Math.max(GALLERY_RENDER_INTERVAL_MS, interval / 2), fastSamples: 0, slowSamples: 0 }
    : { interval, fastSamples: nextFastSamples, slowSamples: 0 };
}

export function galleryInitializationShouldStop(duration: number): boolean {
  return duration > GALLERY_RENDER_INIT_BUDGET_MS;
}

export function galleryPreparationShouldStop(duration: number, visible: boolean): boolean {
  return visible && duration > GALLERY_RENDER_HARD_BUDGET_MS;
}

export function galleryPreparationTimedOut(duration: number): boolean {
  return duration > GALLERY_PREPARE_TIMEOUT_MS;
}

export class GalleryRenderer {
  private readonly terminalRenderers = new Map<string, { renderer: TerminalRenderer; terminal: Terminal; rasterSettingsKey: string }>();
  private readonly output = document.createElement('canvas');
  private readonly screen: VirtualScreenRenderer;
  private contextLost = false;
  private disposed = false;
  private lastSharedRenderKey = '';
  private readonly onContextLost = (event: Event) => { event.preventDefault(); this.contextLost = true; };

  constructor() {
    this.output.addEventListener('webglcontextlost', this.onContextLost);
    try {
      this.screen = new VirtualScreenRenderer(this.output, true, { asyncShaderCompilation: true, maxProgramVariants: 4 });
    } catch (reason) {
      this.output.removeEventListener('webglcontextlost', this.onContextLost);
      throw reason;
    }
  }

  prepare(source: GalleryRenderSource): boolean {
    if (this.contextLost) throw new Error('Gallery WebGL context was lost.');
    if (source.width * source.height > GALLERY_MAX_SOURCE_PIXELS) throw new Error('Gallery source exceeds the preview pixel budget.');
    this.assertRendererCapacity(source);
    return this.screen.prepare(this.settings(source.settings));
  }

  retainSources(sources: readonly GalleryRenderSource[]): void {
    const active = new Map(sources.map(({ id, terminal }) => [id, terminal]));
    for (const [id, entry] of this.terminalRenderers) {
      if (active.get(id) === entry.terminal) continue;
      entry.renderer.dispose();
      this.terminalRenderers.delete(id);
    }
  }

  render(source: GalleryRenderSource, target: HTMLCanvasElement): void {
    if (this.contextLost) throw new Error('Gallery WebGL context was lost.');
    const settings = this.settings(source.settings);
    const aspectRatio = source.width / source.height;
    const width = Math.max(1, Math.round(Math.min(GALLERY_THUMBNAIL_MAX_DIMENSION, GALLERY_THUMBNAIL_MAX_DIMENSION * aspectRatio)));
    const height = Math.max(1, Math.round(Math.min(GALLERY_THUMBNAIL_MAX_DIMENSION, width / aspectRatio)));
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    if (this.output.width !== width) this.output.width = width;
    if (this.output.height !== height) this.output.height = height;
    const rasterSettings = fitGalleryRasterSettings(settings, source.terminal.cols, source.terminal.rows, width, height, Math.min(width / source.width, height / source.height));
    if (!rasterSettings) throw new Error('Gallery thumbnail cannot fit the full terminal grid.');
    const entry = this.terminalRendererFor(source);
    if (entry.renderer.sourceCanvas.width !== width || entry.renderer.sourceCanvas.height !== height) entry.renderer.resizeSource(width, height);
    entry.renderer.setFocused(false);
    const rasterSettingsKey = [rasterSettings.consoleFontSize, rasterSettings.consoleFont, rasterSettings.fallbackFont, rasterSettings.cellWidthAdjustment, rasterSettings.cellHeightAdjustment, rasterSettings.colorProfile, rasterSettings.cursorStyle, rasterSettings.cursorBrightness].join('|');
    if (entry.rasterSettingsKey !== rasterSettingsKey) {
      entry.renderer.markDirty();
      entry.rasterSettingsKey = rasterSettingsKey;
    }
    const sourceChanged = entry.renderer.draw(performance.now() / 1000, rasterSettings);
    this.screen.clearPersistence();
    const sharedRenderKey = JSON.stringify([source.id, settings, rasterSettingsKey, source.images.map(({ id, src, image, x, y, width, height }) => [id, src, image.complete, image.naturalWidth, image.naturalHeight, x, y, width, height])]);
    this.screen.render(entry.renderer.compositedCanvas, settings, this.overlays(source.images, entry.renderer.sourceCanvas), sourceChanged || sharedRenderKey !== this.lastSharedRenderKey);
    this.lastSharedRenderKey = sharedRenderKey;
    const context = target.getContext('2d');
    if (!context) throw new Error('Gallery card canvas is unavailable.');
    context.imageSmoothingEnabled = true;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(this.output, 0, 0, target.width, target.height);
    this.screen.clearPersistence();
    return;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.output.removeEventListener('webglcontextlost', this.onContextLost);
    this.screen.dispose();
    for (const { renderer } of this.terminalRenderers.values()) renderer.dispose();
    this.terminalRenderers.clear();
  }

  private settings(settings: CRTSettings): CRTSettings {
    return { ...settings, persistence: 0, persistenceEnergy: 0, persistenceIntensity: 0, breathing: 0, channelSwitchEffect: false };
  }

  private terminalRendererFor(source: GalleryRenderSource): { renderer: TerminalRenderer; terminal: Terminal; rasterSettingsKey: string } {
    let entry = this.terminalRenderers.get(source.id);
    if (!entry || entry.terminal !== source.terminal) {
      if (entry) {
        entry.renderer.dispose();
        this.terminalRenderers.delete(source.id);
      }
      this.assertRendererCapacity(source);
      const renderer = new TerminalRenderer();
      renderer.bindTerminal(source.terminal);
      entry = { renderer, terminal: source.terminal, rasterSettingsKey: '' };
      this.terminalRenderers.set(source.id, entry);
    }
    return entry;
  }

  private assertRendererCapacity(source: GalleryRenderSource): void {
    const existing = this.terminalRenderers.get(source.id);
    if (existing) return;
    if (this.terminalRenderers.size >= GALLERY_MAX_TERMINAL_RENDERERS) throw new Error(`Gallery terminal renderer limit (${GALLERY_MAX_TERMINAL_RENDERERS}) exceeded.`);
  }

  private overlays(images: TerminalImage[], sourceCanvas: HTMLCanvasElement): ScreenOverlay[] {
    return images.filter(({ image }) => image.complete && image.naturalWidth > 0).map((image, index) => ({
      id: image.id, source: image.image, x: image.x * sourceCanvas.width,
      y: image.y * sourceCanvas.height, width: image.width * sourceCanvas.width,
      height: image.height * sourceCanvas.height, zIndex: index + 1, opacity: 1,
    }));
  }
}
