import type { Terminal } from '@xterm/xterm';
import { TerminalRenderer as CoreTerminalRenderer, type CopyPoint, type CopySelection, type TerminalScrollRegion, type TextHighlightRange } from 'scanline-virtual-screen/terminal';
import type { CRTSettings } from 'scanline-virtual-screen/core';
import type { ScreenOverlay } from 'scanline-virtual-screen/core';
import { colorProfile } from 'scanline-virtual-screen/core';
import { canvasFont } from 'scanline-virtual-screen/terminal';
import { detectVerticalScroll, inspectVerticalScroll, snapshotTerminal, type ScrollDetection, type ScrollCandidate, type TerminalScreenSnapshot } from './terminal-scroll-heuristic';
import { applyTabColorMode, terminalAverageColor, type TabColor } from './terminal-tab-color';

export type { CopyPoint, CopySelection, TerminalScrollRegion, TextHighlightRange, ScrollCandidate, ScrollDetection, TabColor };
export type Resolution = { id: string; width?: number; height?: number };
export type TerminalImage = { id: string; src: string; image: HTMLImageElement; objectUrl?: string; x: number; y: number; width: number; height: number; baseWidth: number; baseHeight: number };

export const SMOOTH_SCROLL_DIAGNOSTICS = true;

export class TerminalRenderer extends CoreTerminalRenderer {
  private images: TerminalImage[] = [];
  private boundTerminal: Terminal | null = null;
  private writeSubscription: { dispose(): void } | null = null;
  private tuiScrollingEnabled = false;
  private heuristicDirty = false;
  private previousSnapshot: TerminalScreenSnapshot | null = null;
  private diagnostics: Record<string, unknown>[] = [];
  private nextTransitionId = 1;
  private activeTransitionId: number | null = null;
  private activeTransitionOperation: 'buffer' | 'region' | null = null;
  private drawing = false;
  private readonly logo = new Image();

  constructor() {
    super();
    this.logo.src = '/icon.png';
    this.logo.onload = () => this.markDirty();
  }

  bindTerminal(terminal: Terminal | null, onScroll?: (viewportY: number) => void): void {
    this.writeSubscription?.dispose(); this.writeSubscription = null;
    super.bindTerminal(terminal, onScroll);
    this.boundTerminal = terminal;
    this.previousSnapshot = null; this.heuristicDirty = false;
    if (terminal) this.writeSubscription = terminal.onWriteParsed(() => { this.heuristicDirty = true; });
  }

  setTuiScrollingEnabled(enabled: boolean): void {
    if (this.tuiScrollingEnabled !== enabled) this.recordDiagnostic({ event: 'heuristic-toggle', enabled });
    this.tuiScrollingEnabled = enabled;
    if (!enabled) this.previousSnapshot = null;
  }
  beginScroll(fromViewportY: number, toViewportY: number): boolean { return this.beginBufferScroll(fromViewportY, toViewportY); }
  beginBufferScroll(fromViewportY: number, toViewportY: number): boolean {
    const wasAnimating = this.isScrollAnimating;
    const accepted = super.beginBufferScroll(fromViewportY, toViewportY);
    this.recordScrollRequest('buffer', { fromViewportY, toViewportY, deltaRows: toViewportY - fromViewportY }, wasAnimating, accepted);
    return accepted;
  }
  beginRegionScroll(region: TerminalScrollRegion): boolean {
    const wasAnimating = this.isScrollAnimating;
    const accepted = super.beginRegionScroll(region);
    this.recordScrollRequest('region', region, wasAnimating, accepted);
    return accepted;
  }
  cancelScroll(): void {
    const wasAnimating = this.isScrollAnimating;
    const transitionId = this.activeTransitionId;
    const operation = this.activeTransitionOperation;
    super.cancelScroll();
    if (wasAnimating) this.recordDiagnostic({ event: this.drawing ? 'transition-completed' : 'transition-cancelled', transitionId, operation });
    this.activeTransitionId = null;
    this.activeTransitionOperation = null;
  }

  exportSmoothScrollDiagnostics(): string { return JSON.stringify({ version: 2, entries: this.diagnostics }, null, 2); }
  private recordDiagnostic(entry: Record<string, unknown>): void {
    if (!SMOOTH_SCROLL_DIAGNOSTICS) return;
    this.diagnostics.push({ at: new Date().toISOString(), ...entry });
    if (this.diagnostics.length > 300) this.diagnostics.shift();
  }
  private recordScrollRequest(operation: 'buffer' | 'region', request: Record<string, unknown>, wasAnimating: boolean, accepted: boolean): void {
    const started = accepted && this.consumeScrollStart();
    if (started) {
      this.activeTransitionId = this.nextTransitionId++;
      this.activeTransitionOperation = operation;
    }
    this.recordDiagnostic({ event: 'transition-request', transitionId: this.activeTransitionId, operation, request, accepted, wasAnimating, outcome: !accepted ? 'rejected' : started ? 'started' : wasAnimating ? 'retargeted' : 'continued' });
  }

  resizeSource(width: number, height: number): boolean { this.previousSnapshot = null; return super.resizeSource(width, height); }
  setSelection(selection: CopySelection | null): void { this.previousSnapshot = null; super.setSelection(selection); }
  setTextHighlights(ranges: readonly TextHighlightRange[], activeIndex = -1): void { this.previousSnapshot = null; super.setTextHighlights(ranges, activeIndex); }
  markDirty(): void { this.previousSnapshot = null; super.markDirty(); }

  draw(time: number, settings: CRTSettings): boolean {
    const terminal = this.boundTerminal;
    if (!terminal) return this.drawBrowserMock(time, settings);
    if (this.tuiScrollingEnabled && this.heuristicDirty) {
      const current = snapshotTerminal(terminal); const previous = this.previousSnapshot;
      const stableNormal = terminal.buffer.active === terminal.buffer.normal && previous?.viewportY === current.viewportY && previous.baseY === current.baseY;
      const eligibleBuffer = terminal.buffer.active === terminal.buffer.alternate || stableNormal;
      if (previous && previous.buffer === current.buffer && previous.cols === current.cols && previous.rows === current.rows && eligibleBuffer && terminal.hasSelection?.() !== true) {
        const detection = inspectVerticalScroll(previous.presentation, current.presentation, previous.content, current.content);
        this.recordDiagnostic({ event: 'heuristic-frame', buffer: terminal.buffer.active === terminal.buffer.alternate ? 'alternate' : 'normal', cols: current.cols, rows: current.rows, viewportY: current.viewportY, baseY: current.baseY, stableNormal, detection });
        if (detection.candidate) this.beginRegionScroll({ deltaRows: detection.candidate.deltaRows, topRow: detection.candidate.topRow, bottomRow: detection.candidate.bottomRow });
      } else if (previous) this.recordDiagnostic({ event: 'heuristic-skip', reason: previous.buffer !== current.buffer ? 'buffer-change' : previous.cols !== current.cols || previous.rows !== current.rows ? 'grid-change' : !eligibleBuffer ? 'normal-buffer-moved' : 'selection' });
      this.previousSnapshot = current; this.heuristicDirty = false;
    } else if (terminal) {
      this.previousSnapshot ??= snapshotTerminal(terminal);
    }
    this.drawing = true;
    try { return super.draw(time, settings); } finally { this.drawing = false; }
  }

  private drawBrowserMock(time: number, settings: CRTSettings): boolean {
    const ctx = this.sourceCanvas.getContext('2d'); const output = this.compositedCanvas.getContext('2d');
    if (!ctx || !output) return false;
    const { width, height } = this.sourceCanvas; const size = settings.consoleFontSize; const line = Math.floor(size * 1.5); const profile = colorProfile(settings.colorProfile);
    ctx.fillStyle = '#050806'; ctx.fillRect(0, 0, width, height);
    if (this.logo.complete && this.logo.naturalWidth > 0 && typeof ctx.drawImage === 'function') { const logoSize = Math.min(256, width, height); ctx.drawImage(this.logo, (width - logoSize) / 2, (height - logoSize) / 2, logoSize, logoSize); }
    ctx.font = canvasFont(size, settings.consoleFont, settings.fallbackFont); ctx.textBaseline = 'top';
    const lines = ['SCANLINE TERM // CRT DISPLAY DIAGNOSTIC', `virtual framebuffer ${width}×${height}`, '[ OK ] phosphor matrix online', '[ OK ] scanline generator synchronized', '[ OK ] WebGL fragment pipeline ready', '> rendering an ordinary terminal as an old monitor', '> browser preview uses a mock session', '', `  frame ${Math.floor(time * 10) % 10000}  uptime ${(time % 3600).toFixed(1)}s`];
    lines.forEach((text, index) => { ctx.fillStyle = ['#7dffae', '#4ecf83', '#9affbd', '#62db91', '#78c9ff', '#ffd166', '#ff8a80'][index % 7]; ctx.fillText(text, size, size + line * index); });
    const promptY = size + line * lines.length; const promptText = 'ready> '; ctx.fillStyle = '#7dffae'; ctx.fillText(promptText, size, promptY);
    if (Math.floor(time * 2) % 2 === 0) { const cursorX = size + ctx.measureText(promptText).width; const cursorW = ctx.measureText('M').width; const cursorH = size; ctx.fillStyle = profile.cursor ?? '#7dffae'; if (settings.cursorStyle === 'underline') ctx.fillRect(cursorX, promptY + cursorH - Math.max(2, Math.round(cursorH * 0.12)) - 1, cursorW, Math.max(2, Math.round(cursorH * 0.12))); else if (settings.cursorStyle === 'bar') ctx.fillRect(cursorX, promptY, Math.max(2, Math.min(cursorW, cursorW * 0.2)), cursorH); else ctx.fillRect(cursorX, promptY + 1, cursorW, Math.max(1, cursorH - 2)); }
    output.clearRect(0, 0, this.compositedCanvas.width, this.compositedCanvas.height); output.drawImage(this.sourceCanvas, 0, 0); return true;
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
