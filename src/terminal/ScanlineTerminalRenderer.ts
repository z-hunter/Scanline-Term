import { TerminalRenderer as CoreTerminalRenderer, type CopyPoint, type CopySelection, type Resolution, type TabColor } from 'scanline-virtual-screen/terminal';
import type { ScreenOverlay } from 'scanline-virtual-screen/core';

export type { CopyPoint, CopySelection, Resolution, TabColor };
export type TerminalImage = { id: string; src: string; image: HTMLImageElement; objectUrl?: string; x: number; y: number; width: number; height: number; baseWidth: number; baseHeight: number };

export class TerminalRenderer extends CoreTerminalRenderer {
  private images: TerminalImage[] = [];

  setImages(images: TerminalImage[]): void {
    this.images = images;
    this.cancelScroll();
    this.markDirty();
  }

  markImagesDirty(): void {
    this.cancelScroll();
    this.markDirty();
  }

  getOverlays(): ScreenOverlay[] {
    return this.images
      .filter((image) => image.image.complete && image.image.naturalWidth > 0)
      .map((image, index) => ({ id: image.id, source: image.image, x: image.x * this.sourceCanvas.width, y: image.y * this.sourceCanvas.height, width: image.width * this.sourceCanvas.width, height: image.height * this.sourceCanvas.height, zIndex: index, opacity: 1 }));
  }

  imageAtSourcePoint(x: number, y: number): TerminalImage | null {
    for (let index = this.images.length - 1; index >= 0; index -= 1) {
      const image = this.images[index];
      const left = image.x * this.sourceCanvas.width;
      const top = image.y * this.sourceCanvas.height;
      const width = image.width * this.sourceCanvas.width;
      const height = image.height * this.sourceCanvas.height;
      if (x >= left && y >= top && x <= left + width && y <= top + height) return image;
    }
    return null;
  }

  dispose(): void {
    super.dispose();
    this.images = [];
  }
}

export { SMOOTH_SCROLL_DIAGNOSTICS, canvasFont, canvasFontLoad, fontCellSize, terminalAverageColor, terminalAverageLuma, terminalContentOffset, terminalDimensions, accessibleTextColor, applyTabColorMode, detectVerticalScroll, inspectVerticalScroll, loadCanvasFont } from 'scanline-virtual-screen/terminal';
