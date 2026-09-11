import type { IBufferCell, Terminal } from '@xterm/xterm';
import type { CRTSettings } from '../crt/CRTFilter';
import { colorProfile, profileColor, remapLegacyRgb, type TerminalColorProfile } from '../terminal-color-profiles';

export type CopyPoint = { row: number; column: number };
export type CopySelection = { start: CopyPoint; end: CopyPoint };
export type Resolution = { id: string; width?: number; height?: number };
export type RenderStats = { redraws: number; canvasMs: number; glyphs: number };
export type TabColor = { background: string; foreground: string };
type LumaFrame = { width: number; height: number; cellWidth: number; cellHeight: number; padding: number };
type BufferLine = { getCell(column: number, cell?: IBufferCell): IBufferCell | undefined };

const fontMetricsCache = new Map<string, { width: number; height: number }>();
let measurementContext: CanvasRenderingContext2D | undefined;

export function terminalPadding(width: number, height: number): number { return Math.max(2, Math.floor(Math.min(width, height) * 0.01)); }
export function canvasFont(fontSize: number, family: string): string { return `${fontSize}px "${family.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}", Consolas, "Courier New", monospace`; }
export function fontCellSize(fontSize: number, family: string, context?: CanvasRenderingContext2D): { width: number; height: number } {
  const key = `${fontSize}:${family}`;
  const cached = fontMetricsCache.get(key);
  if (cached) return cached;
  context ??= (measurementContext ??= document.createElement('canvas').getContext('2d') ?? undefined);
  if (!context) return { width: Math.ceil(fontSize * 0.6), height: Math.ceil(fontSize * 1.2) };
  context.font = canvasFont(fontSize, family);
  const metrics = context.measureText('M');
  const size = { width: Math.ceil(metrics.width), height: Math.ceil((metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontSize) + (metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || Math.ceil(fontSize * 0.2))) };
  fontMetricsCache.set(key, size);
  return size;
}
export function terminalDimensions(width: number, height: number, fontSize: number, family: string) {
  const padding = terminalPadding(width, height); const cell = fontCellSize(fontSize, family);
  return { cols: Math.max(20, Math.min(300, Math.floor((width - padding * 2) / cell.width))), rows: Math.max(8, Math.min(150, Math.floor((height - padding * 2) / cell.height))) };
}
export function terminalContentOffset(width: number, height: number, cols: number, rows: number, cell: { width: number; height: number }) {
  return { x: Math.floor((width - cols * cell.width) / 2), y: Math.floor((height - rows * cell.height) / 2) };
}
function cellColor(cell: IBufferCell, foreground: boolean, profile: TerminalColorProfile): string {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return remapLegacyRgb(profile, `#${value.toString(16).padStart(6, '0')}`);
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return profileColor(profile, value);
  return foreground ? profile.foreground : profile.background;
}

function rgb(value: string): [number, number, number] {
  return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16)];
}

export function terminalAverageColor(terminal: Terminal, profile: TerminalColorProfile): TabColor {
  const buffer = terminal.buffer.active; const cell = buffer.getNullCell(); const total = [0, 0, 0]; let count = 0;
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row); if (!line) continue;
    for (let column = 0; column < terminal.cols; column += 1) {
      const current = line.getCell(column, cell); if (!current) continue;
      let bg = rgb(cellColor(current, false, profile)); let fg = rgb(cellColor(current, true, profile));
      if (current.isInverse && current.isInverse()) [bg, fg] = [fg, bg];
      const ink = current.getChars() ? .22 : 0;
      for (let channel = 0; channel < 3; channel += 1) total[channel] += bg[channel] * (1 - ink) + fg[channel] * ink;
      count += 1;
    }
  }
  const average = total.map((channel) => Math.round(channel / Math.max(1, count))); const background = `#${average.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  const luminance = (average[0] * 299 + average[1] * 587 + average[2] * 114) / 1000;
  return { background, foreground: luminance > 145 ? '#101a14' : '#d7f5df' };
}

function luma([red, green, blue]: [number, number, number]): number {
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
}

// This estimates the full source raster without a canvas readback. A glyph covers
// only a small fraction of its cell; treating it as the tab-color 22% coverage
// makes a single bright character disproportionately drive HV breathing.
export function terminalAverageLuma(terminal: Terminal, profile: TerminalColorProfile, frame?: LumaFrame): number {
  const baseLuma = luma(rgb(profile.background));
  const totalArea = Math.max(1, frame ? frame.width * frame.height : terminal.cols * terminal.rows);
  let total = baseLuma * totalArea;
  const buffer = terminal.buffer.active; const cell = buffer.getNullCell();
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row); if (!line) continue;
    for (let column = 0; column < terminal.cols; column += 1) {
      const current = line.getCell(column, cell); if (!current || current.getWidth() === 0) continue;
      let bg = rgb(cellColor(current, false, profile)); let fg = rgb(cellColor(current, true, profile));
      if (current.isInverse && current.isInverse()) [bg, fg] = [fg, bg];
      const x = frame ? frame.padding + column * frame.cellWidth : column;
      const y = frame ? frame.padding + row * frame.cellHeight : row;
      const width = frame ? frame.cellWidth * current.getWidth() : current.getWidth();
      const height = frame ? frame.cellHeight : 1;
      const area = frame
        ? Math.max(0, Math.min(frame.width, x + width) - Math.max(0, x)) * Math.max(0, Math.min(frame.height, y + height) - Math.max(0, y))
        : width * height;
      if (area === 0) continue;
      const backgroundLuma = luma(bg);
      total += (backgroundLuma - baseLuma) * area;
      if (current.getChars() && !current.isInvisible?.()) total += (luma(fg) - backgroundLuma) * area * 0.08 * (current.isDim?.() ? 0.6 : 1);
    }
  }
  return Math.min(1, Math.max(0, total / totalArea));
}

export class TerminalRenderer {
  readonly sourceCanvas = document.createElement('canvas');
  private terminal: Terminal | null = null;
  private selection: CopySelection | null = null;
  private dirty = true;
  private fullDirty = true;
  private focused = true;
  private rowSignatures: string[] = [];
  private cursorRow: number | null = null;
  private disposables: { dispose(): void }[] = [];
  private stats: RenderStats = { redraws: 0, canvasMs: 0, glyphs: 0 };
  private sourceLuma = 0.12;
  private hasMeasuredSourceLuma = false;
  private lastCursorPhase = -1;
  private lastCursorMoveTime = 0;
  private lastCursorX = -1;
  private lastCursorY = -1;
  private cursorMoved = false;

  bindTerminal(terminal: Terminal | null): void {
    this.disposables.forEach((item) => item.dispose()); this.disposables = []; this.terminal = terminal; this.rowSignatures = []; this.cursorRow = null; this.hasMeasuredSourceLuma = false; this.lastCursorPhase = -1; this.lastCursorMoveTime = 0; this.lastCursorX = -1; this.lastCursorY = -1; this.cursorMoved = false; this.markDirty();
    if (terminal) this.disposables.push(terminal.onCursorMove(() => this.markCursorMoved()), terminal.onWriteParsed(() => this.markTerminalDirty()), terminal.onScroll(() => this.markDirty()));
  }
  resizeSource(resolution: Resolution, output: HTMLCanvasElement): boolean {
    const width = resolution.id.startsWith('physical') ? output.width || 1 : resolution.width || 1;
    const height = resolution.id.startsWith('physical') ? output.height || 1 : resolution.height || 1;
    if (this.sourceCanvas.width === width && this.sourceCanvas.height === height) return false;
    this.sourceCanvas.width = width; this.sourceCanvas.height = height; this.markDirty(); return true;
  }
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (focused) this.lastCursorMoveTime = performance.now() / 1000;
    this.markDirty();
  }
  markDirty(): void { this.dirty = true; this.fullDirty = true; }
  private markTerminalDirty(): void { this.dirty = true; }
  private markCursorMoved(): void { this.cursorMoved = true; this.dirty = true; }
  isCursorBlinkActive(): boolean { return this.focused; }
  getCursorBlinkPhase(time: number): number {
    if (!this.isCursorBlinkActive()) return 0;
    const idleTime = Math.max(0, time - this.lastCursorMoveTime);
    if (idleTime < 0.5) return 0;
    return Math.floor(idleTime * 2);
  }
  isCursorVisibleAt(time: number, buffer: { viewportY: number; baseY: number; cursorX: number; cursorY: number }, isCursorHidden: boolean): boolean {
    if (buffer.viewportY !== buffer.baseY || isCursorHidden) return false;
    if (buffer.cursorX < 0 || buffer.cursorY < 0) return false;
    return this.getCursorBlinkPhase(time) % 2 === 0;
  }
  get averageLuma(): number { return this.sourceLuma; }
  get hasMeasuredLuma(): boolean { return this.hasMeasuredSourceLuma; }
  consumeStats(): RenderStats { const stats = this.stats; this.stats = { redraws: 0, canvasMs: 0, glyphs: 0 }; return stats; }
  setSelection(selection: CopySelection | null): void { this.selection = selection; this.markDirty(); }
  cellAtPoint(clientX: number, clientY: number, output: HTMLCanvasElement, settings: CRTSettings) {
    const terminal = this.terminal; if (!terminal) return null;
    const rect = output.getBoundingClientRect(); if (!rect.width || !rect.height) return null;
    let u = (clientX - rect.left) / rect.width; let v = (clientY - rect.top) / rect.height;
    if (settings.crtEmulation && settings.curvature > 0) { let x = (u - .5) * 2 * (1 + settings.curvature * .1); let y = (v - .5) * 2 * (1 + settings.curvature * .1); x *= 1 + Math.pow(Math.abs(y) / 5, 2) * settings.curvature * 5; y *= 1 + Math.pow(Math.abs(x) / 4, 2) * settings.curvature * 5; u = x / 2 + .5; v = y / 2 + .5; }
    const cell = fontCellSize(settings.consoleFontSize, settings.consoleFont); const offset = terminalContentOffset(this.sourceCanvas.width, this.sourceCanvas.height, terminal.cols, terminal.rows, cell);
    return { col: Math.max(1, Math.min(terminal.cols, Math.floor((u * this.sourceCanvas.width - offset.x) / cell.width) + 1)), row: Math.max(1, Math.min(terminal.rows, Math.floor((v * this.sourceCanvas.height - offset.y) / cell.height) + 1)) };
  }
  draw(time: number, settings: CRTSettings): boolean {
    const source = this.sourceCanvas; const terminal = this.terminal;
    if (!terminal) { this.drawMock(time, settings); return true; }
    const buffer = terminal.buffer.active;
    const cursorX = buffer.cursorX;
    const cursorY = buffer.cursorY;
    const cursorMoved = cursorX !== this.lastCursorX || cursorY !== this.lastCursorY || this.cursorMoved;
    if (cursorMoved) {
      this.cursorMoved = false;
      this.lastCursorX = cursorX;
      this.lastCursorY = cursorY;
      this.lastCursorMoveTime = time;
      this.dirty = true;
    }
    const cursorPhase = this.getCursorBlinkPhase(time);
    if (!this.dirty && cursorPhase === this.lastCursorPhase) return false;
    const ctx = source.getContext('2d'); if (!ctx) return false;
    const profile = colorProfile(settings.colorProfile); const cellSize = fontCellSize(settings.consoleFontSize, settings.consoleFont, ctx);
    const cell = buffer.getNullCell();
    const offset = terminalContentOffset(source.width, source.height, terminal.cols, terminal.rows, cellSize);
    const core = (terminal as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
    const cursorVisible = this.isCursorVisibleAt(time, buffer, core?.coreService?.isCursorHidden === true);
    const nextCursorRow = cursorVisible && buffer.cursorY >= 0 && buffer.cursorY < terminal.rows ? buffer.cursorY : null;
    const changedRows = new Set<number>(); const nextSignatures: string[] = [];
    if (this.dirty) for (let row = 0; row < terminal.rows; row += 1) { const signature = this.rowSignature(buffer.getLine(buffer.viewportY + row), terminal.cols, cell); nextSignatures.push(signature); if (this.fullDirty || signature !== this.rowSignatures[row]) changedRows.add(row); }
    if (this.cursorRow !== null) changedRows.add(this.cursorRow); if (nextCursorRow !== null) changedRows.add(nextCursorRow);
    if (changedRows.size === 0) { this.dirty = false; this.fullDirty = false; this.lastCursorPhase = cursorPhase; return false; }
    const started = performance.now(); let glyphs = 0;
    ctx.globalAlpha = 1; ctx.fillStyle = profile.background; if (this.fullDirty) ctx.fillRect(0, 0, source.width, source.height); ctx.font = canvasFont(settings.consoleFontSize, settings.consoleFont); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const row of changedRows) glyphs += this.drawRow(ctx, buffer.getLine(buffer.viewportY + row), row, terminal.cols, buffer.viewportY, cell, profile, offset, cellSize);
    if (nextCursorRow !== null) {
      const x = offset.x + cellSize.width * buffer.cursorX;
      const y = offset.y + cellSize.height * buffer.cursorY;
      ctx.fillStyle = profile.cursor ?? profile.foreground;
      const cursorStyle = settings.cursorStyle ?? terminal.options.cursorStyle ?? 'block';
      if (cursorStyle === 'underline') {
        const underlineHeight = Math.max(2, Math.round(cellSize.height * 0.1));
        ctx.fillRect(x, y + cellSize.height - underlineHeight, cellSize.width, underlineHeight);
      } else if (cursorStyle === 'bar') {
        const barWidth = Math.max(2, Math.min(cellSize.width, terminal.options.cursorWidth ?? cellSize.width * 0.15));
        ctx.fillRect(x, y, barWidth, Math.ceil(cellSize.height));
      } else {
        ctx.fillRect(x, y, cellSize.width, Math.ceil(cellSize.height));
      }
    }
    if (nextSignatures.length) { this.sourceLuma = terminalAverageLuma(terminal, profile, { width: source.width, height: source.height, cellWidth: cellSize.width, cellHeight: cellSize.height, padding: terminalPadding(source.width, source.height) }); this.hasMeasuredSourceLuma = true; }
    this.rowSignatures = nextSignatures.length ? nextSignatures : this.rowSignatures; this.cursorRow = nextCursorRow; this.lastCursorPhase = cursorPhase; this.dirty = false; this.fullDirty = false; this.stats.redraws += 1; this.stats.canvasMs += performance.now() - started; this.stats.glyphs += glyphs; return true;
  }
  private rowSignature(line: BufferLine | undefined, cols: number, cell: IBufferCell): string {
    if (!line) return '';
    let signature = '';
    for (let column = 0; column < cols; column += 1) { const current = line.getCell(column, cell); if (!current) { signature += ';'; continue; } const chars = current.getChars(); signature += `${chars.length}:${chars},${current.getWidth()},${current.getFgColor()},${current.getBgColor()},${Number(current.isInverse())}${Number(current.isDim())}${Number(current.isInvisible())};`; }
    return signature;
  }
  private drawRow(ctx: CanvasRenderingContext2D, line: BufferLine | undefined, row: number, cols: number, viewportY: number, cell: IBufferCell, profile: TerminalColorProfile, offset: { x: number; y: number }, cellSize: { width: number; height: number }): number {
    const y = offset.y + cellSize.height * (row + .5); ctx.globalAlpha = 1; ctx.fillStyle = profile.background; ctx.fillRect(0, Math.floor(y - cellSize.height / 2), this.sourceCanvas.width, Math.ceil(cellSize.height)); if (!line) return 0;
    const selectionStart = this.selection ? this.selection.start.row * cols + this.selection.start.column : -1; const selectionEnd = this.selection ? this.selection.end.row * cols + this.selection.end.column : -1; let glyphs = 0;
    for (let column = 0; column < cols; column += 1) { const current = line.getCell(column, cell); if (!current || current.getWidth() === 0) continue; let fg = cellColor(current, true, profile); let bg = cellColor(current, false, profile); if (current.isInverse()) [fg, bg] = [bg, fg]; const x = offset.x + cellSize.width * column; if (bg !== profile.background) { ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fillRect(Math.floor(x), Math.floor(y - cellSize.height / 2), Math.ceil(x + cellSize.width * current.getWidth()) - Math.floor(x), Math.ceil(cellSize.height)); } const point = (viewportY + row) * cols + column; if (this.selection && point >= Math.min(selectionStart, selectionEnd) && point <= Math.max(selectionStart, selectionEnd)) { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(125, 210, 255, 0.42)'; ctx.fillRect(Math.floor(x), Math.floor(y - cellSize.height / 2), Math.ceil(cellSize.width * current.getWidth()), Math.ceil(cellSize.height)); } const chars = current.getChars(); if (chars && !current.isInvisible()) { glyphs += 1; ctx.globalAlpha = current.isDim() ? .6 : 1; ctx.fillStyle = fg; ctx.fillText(chars, x, y); } }
    return glyphs;
  }
  private drawMock(time: number, settings: CRTSettings): void {
    const ctx = this.sourceCanvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.sourceCanvas;
    const size = settings.consoleFontSize;
    const line = Math.floor(size * 1.5);
    const profile = colorProfile(settings.colorProfile);
    ctx.fillStyle = '#050806';
    ctx.fillRect(0, 0, width, height);
    ctx.font = canvasFont(size, settings.consoleFont);
    ctx.textBaseline = 'top';
    const lines = [
      'SCANLINE TERM // CRT DISPLAY DIAGNOSTIC',
      `virtual framebuffer ${width}×${height}`,
      '[ OK ] phosphor matrix online',
      '[ OK ] scanline generator synchronized',
      '[ OK ] WebGL fragment pipeline ready',
      '> rendering an ordinary terminal as an old monitor',
      '> browser preview uses a mock session',
      '',
      `  frame ${Math.floor(time * 10) % 10000}  uptime ${(time % 3600).toFixed(1)}s`,
    ];
    lines.forEach((text, i) => {
      ctx.fillStyle = ['#7dffae','#4ecf83','#9affbd','#62db91','#78c9ff','#ffd166','#ff8a80'][i % 7];
      ctx.fillText(text, size, size + line * i);
    });
    const promptY = size + line * lines.length;
    const promptText = 'ready> ';
    ctx.fillStyle = '#7dffae';
    ctx.fillText(promptText, size, promptY);
    const cursorPhase = Math.floor(time * 2);
    if (cursorPhase % 2 === 0) {
      const cursorX = size + ctx.measureText(promptText).width;
      const cursorW = ctx.measureText('M').width;
      const cursorH = size;
      const cursorStyle = settings.cursorStyle ?? 'block';
      ctx.fillStyle = profile.cursor ?? '#7dffae';
      if (cursorStyle === 'underline') {
        const h = Math.max(2, Math.round(cursorH * 0.12));
        ctx.fillRect(cursorX, promptY + cursorH - h, cursorW, h);
      } else if (cursorStyle === 'bar') {
        const w = Math.max(2, Math.min(cursorW, cursorW * 0.2));
        ctx.fillRect(cursorX, promptY, w, cursorH);
      } else {
        ctx.fillRect(cursorX, promptY, cursorW, cursorH);
      }
    }
  }
  dispose(): void { this.disposables.forEach((item) => item.dispose()); this.disposables = []; this.terminal = null; this.rowSignatures = []; this.cursorRow = null; this.lastCursorPhase = -1; this.lastCursorMoveTime = 0; this.lastCursorX = -1; this.lastCursorY = -1; this.cursorMoved = false; }
}
