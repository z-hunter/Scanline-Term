import type { Terminal } from '@xterm/xterm';
import { TerminalRenderer as CoreTerminalRenderer, type CopyPoint, type CopySelection, type TerminalScrollRegion, type TextHighlightRange } from 'scanline-virtual-screen/terminal';
import type { CRTSettings } from 'scanline-virtual-screen/core';
import type { ScreenOverlay } from 'scanline-virtual-screen/core';
import { detectVerticalScroll, inspectVerticalScroll, snapshotTerminal, type ScrollDetection, type ScrollCandidate, type TerminalScreenSnapshot } from './terminal-scroll-heuristic';
import { applyTabColorMode, terminalAverageColor, type TabColor } from './terminal-tab-color';

export type { CopyPoint, CopySelection, TerminalScrollRegion, TextHighlightRange, ScrollCandidate, ScrollDetection, TabColor };
export type Resolution = { id: string; width?: number; height?: number };
export type TerminalImage = { id: string; src: string; image: HTMLImageElement; objectUrl?: string; x: number; y: number; width: number; height: number; baseWidth: number; baseHeight: number };

export const SMOOTH_SCROLL_DIAGNOSTICS = false;

export class TerminalRenderer extends CoreTerminalRenderer {
  private images: TerminalImage[] = [];
  private boundTerminal: Terminal | null = null;
  private writeSubscription: { dispose(): void } | null = null;
  private tuiScrollingEnabled = false;
  private heuristicDirty = false;
  private previousSnapshot: TerminalScreenSnapshot | null = null;
  private diagnostics: Record<string, unknown>[] = [];

  bindTerminal(terminal: Terminal | null, onScroll?: (viewportY: number) => void): void {
    this.writeSubscription?.dispose(); this.writeSubscription = null;
    super.bindTerminal(terminal, onScroll);
    this.boundTerminal = terminal;
    this.previousSnapshot = null; this.heuristicDirty = false;
    if (terminal) this.writeSubscription = terminal.onWriteParsed(() => { this.heuristicDirty = true; });
  }

  setTuiScrollingEnabled(enabled: boolean): void {
    this.tuiScrollingEnabled = enabled;
    if (!enabled) this.previousSnapshot = null;
  }
  beginScroll(fromViewportY: number, toViewportY: number): boolean { return this.beginBufferScroll(fromViewportY, toViewportY); }

  exportSmoothScrollDiagnostics(): string { return JSON.stringify({ version: 1, entries: this.diagnostics }, null, 2); }
  private recordDiagnostic(entry: Record<string, unknown>): void {
    if (!SMOOTH_SCROLL_DIAGNOSTICS) return;
    this.diagnostics.push({ at: new Date().toISOString(), ...entry });
    if (this.diagnostics.length > 60) this.diagnostics.shift();
  }

  resizeSource(width: number, height: number): boolean { this.previousSnapshot = null; return super.resizeSource(width, height); }
  setSelection(selection: CopySelection | null): void { this.previousSnapshot = null; super.setSelection(selection); }
  setTextHighlights(ranges: readonly TextHighlightRange[], activeIndex = -1): void { this.previousSnapshot = null; super.setTextHighlights(ranges, activeIndex); }
  markDirty(): void { this.previousSnapshot = null; super.markDirty(); }

  draw(time: number, settings: CRTSettings): boolean {
    const terminal = this.boundTerminal;
    if (!terminal) return this.drawBrowserMock(settings);
    if (this.tuiScrollingEnabled && this.heuristicDirty) {
      const current = snapshotTerminal(terminal); const previous = this.previousSnapshot;
      const stableNormal = terminal.buffer.active === terminal.buffer.normal && previous?.viewportY === current.viewportY && previous.baseY === current.baseY;
      const eligibleBuffer = terminal.buffer.active === terminal.buffer.alternate || stableNormal;
      if (previous && previous.buffer === current.buffer && previous.cols === current.cols && previous.rows === current.rows && eligibleBuffer && terminal.hasSelection?.() !== true) {
        const detection = inspectVerticalScroll(previous.presentation, current.presentation, previous.content, current.content);
        this.recordDiagnostic({ kind: 'tui-scroll', detection });
        if (detection.candidate) this.beginRegionScroll({ deltaRows: detection.candidate.deltaRows, topRow: detection.candidate.topRow, bottomRow: detection.candidate.bottomRow });
      } else if (previous) this.recordDiagnostic({ kind: 'tui-scroll-skip', reason: previous.buffer !== current.buffer ? 'buffer-change' : previous.cols !== current.cols || previous.rows !== current.rows ? 'grid-change' : 'selection' });
      this.previousSnapshot = current; this.heuristicDirty = false;
    } else if (terminal) {
      this.previousSnapshot ??= snapshotTerminal(terminal);
    }
    return super.draw(time, settings);
  }

  private drawBrowserMock(settings: CRTSettings): boolean {
    const ctx = this.sourceCanvas.getContext('2d'); const output = this.compositedCanvas.getContext('2d');
    if (!ctx || !output) return false;
    ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, this.sourceCanvas.width, this.sourceCanvas.height); ctx.fillStyle = '#65e6a8'; ctx.font = `${Math.max(12, settings.consoleFontSize)}px ${settings.consoleFont}`; ctx.fillText('SCANLINE TERM // CRT DISPLAY DIAGNOSTIC', 24, 36); ctx.fillStyle = '#8ba99a'; ctx.fillText('Bind a terminal session to begin.', 24, 66); output.clearRect(0, 0, this.compositedCanvas.width, this.compositedCanvas.height); output.drawImage(this.sourceCanvas, 0, 0); return true;
  }

  setImages(images: TerminalImage[]): void { this.images = images; this.cancelScroll(); this.markDirty(); }
  markImagesDirty(): void { this.cancelScroll(); this.markDirty(); }
  getOverlays(): ScreenOverlay[] { return this.images.filter((image) => image.image.complete && image.image.naturalWidth > 0).map((image, index) => ({ id: image.id, source: image.image, x: image.x * this.sourceCanvas.width, y: image.y * this.sourceCanvas.height, width: image.width * this.sourceCanvas.width, height: image.height * this.sourceCanvas.height, zIndex: index, opacity: 1 })); }
  imageAtSourcePoint(x: number, y: number): TerminalImage | null { for (let index = this.images.length - 1; index >= 0; index -= 1) { const image = this.images[index]; const left = image.x * this.sourceCanvas.width; const top = image.y * this.sourceCanvas.height; const width = image.width * this.sourceCanvas.width; const height = image.height * this.sourceCanvas.height; if (x >= left && y >= top && x <= left + width && y <= top + height) return image; } return null; }
  dispose(): void { this.writeSubscription?.dispose(); this.writeSubscription = null; this.boundTerminal = null; this.previousSnapshot = null; super.dispose(); this.images = []; }
}

export { applyTabColorMode, terminalAverageColor };
export { canvasFont, canvasFontLoad, fontCellSize, terminalAverageLuma, terminalContentOffset, terminalDimensions, accessibleTextColor, loadCanvasFont } from 'scanline-virtual-screen/terminal';
export { detectVerticalScroll, inspectVerticalScroll };
