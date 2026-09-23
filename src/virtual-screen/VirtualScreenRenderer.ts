import { CRTFilter, type CRTSettings } from '../crt/CRTFilter';
import { OverlayCompositor, type ScreenOverlay } from './overlays';

export class VirtualScreenRenderer {
  readonly compositor = new OverlayCompositor();
  private filter: CRTFilter | null = null;

  constructor(readonly output: HTMLCanvasElement, crtEnabled = true) {
    if (crtEnabled) this.filter = new CRTFilter(output);
  }

  render(source: HTMLCanvasElement, settings: CRTSettings, overlays: readonly ScreenOverlay[] = [], sourceChanged = true): void {
    this.compositor.compose(source, overlays);
    if (this.filter?.isValid()) this.filter.render(this.compositor.canvas, settings, sourceChanged);
    else {
      const ctx = this.output.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = settings.antiAliasedPixels !== false;
      ctx.drawImage(this.compositor.canvas, 0, 0, this.output.width, this.output.height);
    }
  }

  isValid(): boolean { return this.filter?.isValid() ?? true; }
  restartBreathing(): void { this.filter?.restartBreathing(); }
  clearPersistence(): void { this.filter?.clearPersistence(); }
  startChannelSwitch(): void { this.filter?.startChannelSwitch(); }
  dispose(): void { this.filter?.dispose(); this.filter = null; }
}
