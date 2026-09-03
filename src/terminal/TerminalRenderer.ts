import type { IBufferCell, Terminal } from '@xterm/xterm';
import type { CRTSettings } from '../crt/CRTFilter';
import { colorProfile, profileColor, remapLegacyRgb, type TerminalColorProfile } from '../terminal-color-profiles';

export type CopyPoint = { row: number; column: number };
export type CopySelection = { start: CopyPoint; end: CopyPoint };
export type Resolution = { id: string; width?: number; height?: number };
export type RenderStats = { redraws: number; canvasMs: number; glyphs: number };
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
function cellColor(cell: IBufferCell, foreground: boolean, profile: TerminalColorProfile): string {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return remapLegacyRgb(profile, `#${value.toString(16).padStart(6, '0')}`);
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return profileColor(profile, value);
  return foreground ? profile.foreground : profile.background;
}

export class TerminalRenderer {
  readonly sourceCanvas = document.createElement('canvas');
  private terminal: Terminal | null = null;
  private selection: CopySelection | null = null;
  private dirty = true;
  private fullDirty = true;
  private rowSignatures: string[] = [];
  private cursorRow: number | null = null;
  private disposables: { dispose(): void }[] = [];
  private stats: RenderStats = { redraws: 0, canvasMs: 0, glyphs: 0 };

  bindTerminal(terminal: Terminal | null): void {
    this.disposables.forEach((item) => item.dispose()); this.disposables = []; this.terminal = terminal; this.rowSignatures = []; this.cursorRow = null; this.markDirty();
    if (terminal) this.disposables.push(terminal.onCursorMove(() => this.markTerminalDirty()), terminal.onWriteParsed(() => this.markTerminalDirty()), terminal.onScroll(() => this.markDirty()));
  }
  resizeSource(resolution: Resolution, output: HTMLCanvasElement): boolean {
    const width = resolution.id.startsWith('physical') ? output.width || 1 : resolution.width || 1;
    const height = resolution.id.startsWith('physical') ? output.height || 1 : resolution.height || 1;
    if (this.sourceCanvas.width === width && this.sourceCanvas.height === height) return false;
    this.sourceCanvas.width = width; this.sourceCanvas.height = height; this.markDirty(); return true;
  }
  markDirty(): void { this.dirty = true; this.fullDirty = true; }
  private markTerminalDirty(): void { this.dirty = true; }
  consumeStats(): RenderStats { const stats = this.stats; this.stats = { redraws: 0, canvasMs: 0, glyphs: 0 }; return stats; }
  setSelection(selection: CopySelection | null): void { this.selection = selection; this.markDirty(); }
  cellAtPoint(clientX: number, clientY: number, output: HTMLCanvasElement, settings: CRTSettings) {
    const terminal = this.terminal; if (!terminal) return null;
    const rect = output.getBoundingClientRect(); if (!rect.width || !rect.height) return null;
    let u = (clientX - rect.left) / rect.width; let v = (clientY - rect.top) / rect.height;
    if (settings.crtEmulation && settings.curvature > 0) { let x = (u - .5) * 2 * (1 + settings.curvature * .1); let y = (v - .5) * 2 * (1 + settings.curvature * .1); x *= 1 + Math.pow(Math.abs(y) / 5, 2) * settings.curvature * 5; y *= 1 + Math.pow(Math.abs(x) / 4, 2) * settings.curvature * 5; u = x / 2 + .5; v = y / 2 + .5; }
    const cell = fontCellSize(settings.consoleFontSize, settings.consoleFont); const padding = terminalPadding(this.sourceCanvas.width, this.sourceCanvas.height);
    return { col: Math.max(1, Math.min(terminal.cols, Math.floor((u * this.sourceCanvas.width - padding) / cell.width) + 1)), row: Math.max(1, Math.min(terminal.rows, Math.floor((v * this.sourceCanvas.height - padding) / cell.height) + 1)) };
  }
  draw(time: number, settings: CRTSettings): boolean {
    const source = this.sourceCanvas; const terminal = this.terminal;
    if (!terminal) { this.drawMock(time, settings); return true; }
    const cursorPhase = Math.floor(time * 2); if (!this.dirty && cursorPhase === Math.floor((time - .1) * 2)) return false;
    const ctx = source.getContext('2d'); if (!ctx) return false;
    const profile = colorProfile(settings.colorProfile); const padding = terminalPadding(source.width, source.height); const cellSize = fontCellSize(settings.consoleFontSize, settings.consoleFont, ctx);
    const buffer = terminal.buffer.active; const cell = buffer.getNullCell();
    const core = (terminal as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core; const cursorVisible = buffer.viewportY === buffer.baseY && core?.coreService?.isCursorHidden !== true && cursorPhase % 2 === 0;
    const nextCursorRow = cursorVisible && buffer.cursorY >= 0 && buffer.cursorY < terminal.rows ? buffer.cursorY : null;
    const changedRows = new Set<number>(); const nextSignatures: string[] = [];
    if (this.dirty) for (let row = 0; row < terminal.rows; row += 1) { const signature = this.rowSignature(buffer.getLine(buffer.viewportY + row), terminal.cols, cell); nextSignatures.push(signature); if (this.fullDirty || signature !== this.rowSignatures[row]) changedRows.add(row); }
    if (this.cursorRow !== null) changedRows.add(this.cursorRow); if (nextCursorRow !== null) changedRows.add(nextCursorRow);
    if (changedRows.size === 0) { this.dirty = false; this.fullDirty = false; return false; }
    const started = performance.now(); let glyphs = 0;
    ctx.globalAlpha = 1; ctx.fillStyle = profile.background; if (this.fullDirty) ctx.fillRect(0, 0, source.width, source.height); ctx.font = canvasFont(settings.consoleFontSize, settings.consoleFont); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const row of changedRows) glyphs += this.drawRow(ctx, buffer.getLine(buffer.viewportY + row), row, terminal.cols, buffer.viewportY, cell, profile, padding, cellSize);
    if (nextCursorRow !== null) { const x = padding + cellSize.width * buffer.cursorX; const y = padding + cellSize.height * buffer.cursorY; ctx.fillStyle = profile.cursor ?? profile.foreground; if (terminal.options.cursorStyle === 'underline') ctx.fillRect(x, y + cellSize.height - 2, cellSize.width, 2); else if (terminal.options.cursorStyle === 'bar') ctx.fillRect(x, y, Math.max(2, Math.min(cellSize.width, terminal.options.cursorWidth ?? cellSize.width * .15)), Math.ceil(cellSize.height)); else ctx.fillRect(x, y, cellSize.width, Math.ceil(cellSize.height)); }
    this.rowSignatures = nextSignatures.length ? nextSignatures : this.rowSignatures; this.cursorRow = nextCursorRow; this.dirty = false; this.fullDirty = false; this.stats.redraws += 1; this.stats.canvasMs += performance.now() - started; this.stats.glyphs += glyphs; return true;
  }
  private rowSignature(line: BufferLine | undefined, cols: number, cell: IBufferCell): string {
    if (!line) return '';
    let signature = '';
    for (let column = 0; column < cols; column += 1) { const current = line.getCell(column, cell); if (!current) { signature += ';'; continue; } const chars = current.getChars(); signature += `${chars.length}:${chars},${current.getWidth()},${current.getFgColor()},${current.getBgColor()},${Number(current.isInverse())}${Number(current.isDim())}${Number(current.isInvisible())};`; }
    return signature;
  }
  private drawRow(ctx: CanvasRenderingContext2D, line: BufferLine | undefined, row: number, cols: number, viewportY: number, cell: IBufferCell, profile: TerminalColorProfile, padding: number, cellSize: { width: number; height: number }): number {
    const y = padding + cellSize.height * (row + .5); ctx.globalAlpha = 1; ctx.fillStyle = profile.background; ctx.fillRect(0, Math.floor(y - cellSize.height / 2), this.sourceCanvas.width, Math.ceil(cellSize.height)); if (!line) return 0;
    const selectionStart = this.selection ? this.selection.start.row * cols + this.selection.start.column : -1; const selectionEnd = this.selection ? this.selection.end.row * cols + this.selection.end.column : -1; let glyphs = 0;
    for (let column = 0; column < cols; column += 1) { const current = line.getCell(column, cell); if (!current || current.getWidth() === 0) continue; let fg = cellColor(current, true, profile); let bg = cellColor(current, false, profile); if (current.isInverse()) [fg, bg] = [bg, fg]; const x = padding + cellSize.width * column; if (bg !== profile.background) { ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fillRect(Math.floor(x), Math.floor(y - cellSize.height / 2), Math.ceil(x + cellSize.width * current.getWidth()) - Math.floor(x), Math.ceil(cellSize.height)); } const point = (viewportY + row) * cols + column; if (this.selection && point >= Math.min(selectionStart, selectionEnd) && point <= Math.max(selectionStart, selectionEnd)) { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(125, 210, 255, 0.42)'; ctx.fillRect(Math.floor(x), Math.floor(y - cellSize.height / 2), Math.ceil(cellSize.width * current.getWidth()), Math.ceil(cellSize.height)); } const chars = current.getChars(); if (chars && !current.isInvisible()) { glyphs += 1; ctx.globalAlpha = current.isDim() ? .6 : 1; ctx.fillStyle = fg; ctx.fillText(chars, x, y); } }
    return glyphs;
  }
  private drawMock(time: number, settings: CRTSettings): void { const ctx = this.sourceCanvas.getContext('2d'); if (!ctx) return; const { width, height } = this.sourceCanvas; const size = settings.consoleFontSize; const line = Math.floor(size * 1.5); ctx.fillStyle = '#050806'; ctx.fillRect(0, 0, width, height); ctx.font = canvasFont(size, settings.consoleFont); ctx.textBaseline = 'top'; ['SCANLINE TERM // CRT DISPLAY DIAGNOSTIC', `virtual framebuffer ${width}×${height}`, '[ OK ] phosphor matrix online', '[ OK ] scanline generator synchronized', '[ OK ] WebGL fragment pipeline ready', '> rendering an ordinary terminal as an old monitor', '> browser preview uses a mock session', '', `  frame ${Math.floor(time * 10) % 10000}  uptime ${(time % 3600).toFixed(1)}s`].forEach((text, i) => { ctx.fillStyle = ['#7dffae','#4ecf83','#9affbd','#62db91','#78c9ff','#ffd166','#ff8a80'][i % 7]; ctx.fillText(text, size, size + line * i); }); }
  dispose(): void { this.disposables.forEach((item) => item.dispose()); this.disposables = []; this.terminal = null; this.rowSignatures = []; this.cursorRow = null; }
}
