export type ScreenOverlay = {
  id: string;
  source: CanvasImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  opacity?: number;
};

export type NormalizedOverlay = Omit<ScreenOverlay, 'source' | 'x' | 'y' | 'width' | 'height' | 'zIndex'> & {
  source: CanvasImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
};

export function normalizedOverlay(overlay: NormalizedOverlay, width: number, height: number, zIndex = 0): ScreenOverlay {
  return { ...overlay, x: overlay.x * width, y: overlay.y * height, width: overlay.width * width, height: overlay.height * height, zIndex: overlay.zIndex ?? zIndex };
}

export class OverlayCompositor {
  readonly canvas = document.createElement('canvas');

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  compose(source: HTMLCanvasElement, overlays: readonly ScreenOverlay[]): boolean {
    this.resize(source.width, source.height);
    const ctx = this.canvas.getContext('2d');
    if (!ctx || typeof ctx.drawImage !== 'function') return false;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(source, 0, 0);
    const ordered = overlays.map((overlay, index) => ({ overlay, index })).sort((a, b) => a.overlay.zIndex - b.overlay.zIndex || a.index - b.index);
    for (const { overlay } of ordered) {
      if (overlay.opacity === 0) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, overlay.opacity ?? 1));
      ctx.drawImage(overlay.source, overlay.x, overlay.y, overlay.width, overlay.height);
    }
    ctx.globalAlpha = 1;
    return true;
  }
}
