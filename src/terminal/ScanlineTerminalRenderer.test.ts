import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRT_SETTINGS } from 'scanline-virtual-screen/core';
import { TerminalRenderer, type TerminalImage } from './ScanlineTerminalRenderer';

describe('ScanlineTerminalRenderer', () => {
  it('renders the Scanline Term mock screen without a bound terminal', () => {
    const context = { globalAlpha: 1, fillStyle: '', font: '', textBaseline: 'top', fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn(), measureText: () => ({ width: 24 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const renderer = new TerminalRenderer(); renderer.resizeSource(320, 240); renderer.bindTerminal(null);
    expect(renderer.draw(1, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(context.fillText).toHaveBeenCalledWith('SCANLINE TERM // CRT DISPLAY DIAGNOSTIC', DEFAULT_CRT_SETTINGS.consoleFontSize, DEFAULT_CRT_SETTINGS.consoleFontSize);
  });

  it('hit-tests the topmost normalized image', () => {
    const renderer = new TerminalRenderer();
    renderer.resizeSource(100, 100);
    const image = (id: string, x: number): TerminalImage => ({ id, src: '', image: {} as HTMLImageElement, x, y: .2, width: .4, height: .4, baseWidth: .4, baseHeight: .4 });
    const bottom = image('bottom', .1); const top = image('top', .2);
    renderer.setImages([bottom, top]);
    expect(renderer.imageAtSourcePoint(30, 30)).toBe(top);
    expect(renderer.imageAtSourcePoint(12, 30)).toBe(bottom);
    expect(renderer.imageAtSourcePoint(90, 90)).toBeNull();
  });

  it('reports image-only changes when terminal rows stay unchanged', () => {
    const context = { globalAlpha: 1, fillStyle: '', font: '', textAlign: 'left', textBaseline: 'middle', drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const cell = { getChars: () => '', getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false };
    const normal = { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getNullCell: () => cell, getLine: () => ({ getCell: () => cell }) };
    const terminal = { cols: 2, rows: 2, options: {}, buffer: { active: normal, normal }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: () => ({ dispose() {} }), onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource(80, 40); renderer.bindTerminal(terminal as never);
    renderer.draw(0, DEFAULT_CRT_SETTINGS);
    renderer.setImages([{ id: 'image', src: '', image: { complete: true, naturalWidth: 1 } as HTMLImageElement, x: 0, y: 0, width: .5, height: .5, baseWidth: .5, baseHeight: .5 }]);
    expect(renderer.draw(.1, DEFAULT_CRT_SETTINGS)).toBe(true);
  });

  it('records the heuristic decision and a retargeted region transition', () => {
    const context = { globalAlpha: 1, fillStyle: '', font: '', textAlign: 'left', textBaseline: 'middle', imageSmoothingEnabled: true, drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const listeners: (() => void)[] = []; const cell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    let rows = ['A', 'B', 'C', 'D', 'E', 'F']; const alternate = { viewportY: 0, baseY: 0, cursorX: -1, cursorY: -1, getNullCell: () => cell(''), getLine: (row: number) => ({ getCell: () => cell(rows[row] ?? '') }) };
    const terminal = { cols: 1, rows: 6, options: {}, buffer: { active: alternate, alternate, normal: {} }, hasSelection: () => false, onCursorMove: () => ({ dispose() {} }), onWriteParsed: (listener: () => void) => { listeners.push(listener); return { dispose() {} }; }, onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource(80, 120); renderer.bindTerminal(terminal as never); renderer.setTuiScrollingEnabled(true); renderer.draw(0, DEFAULT_CRT_SETTINGS);
    rows = ['B', 'C', 'D', 'E', 'F', 'G']; listeners.forEach((listener) => listener()); renderer.draw(.1, DEFAULT_CRT_SETTINGS);
    rows = ['C', 'D', 'E', 'F', 'G', 'H']; listeners.forEach((listener) => listener()); renderer.draw(.11, DEFAULT_CRT_SETTINGS);
    const entries = JSON.parse(renderer.exportSmoothScrollDiagnostics()).entries;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'heuristic-frame', detection: expect.objectContaining({ candidate: expect.objectContaining({ deltaRows: 1 }) }) }), expect.objectContaining({ event: 'transition-request', operation: 'region', outcome: 'started' }), expect.objectContaining({ event: 'transition-request', operation: 'region', outcome: 'retargeted' })]));
  });

  it('cancels instead of restarting when an active heuristic region changes', () => {
    const context = { globalAlpha: 1, fillStyle: '', font: '', textAlign: 'left', textBaseline: 'middle', imageSmoothingEnabled: true, drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const listeners: (() => void)[] = []; const cell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    let rows = Array.from({ length: 35 }, (_, row) => `old-${row}`); const alternate = { viewportY: 0, baseY: 0, cursorX: -1, cursorY: -1, getNullCell: () => cell(''), getLine: (row: number) => ({ getCell: () => cell(rows[row] ?? '') }) };
    const terminal = { cols: 1, rows: 35, options: {}, buffer: { active: alternate, alternate, normal: {} }, hasSelection: () => false, onCursorMove: () => ({ dispose() {} }), onWriteParsed: (listener: () => void) => { listeners.push(listener); return { dispose() {} }; }, onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource(80, 700); renderer.bindTerminal(terminal as never); renderer.setTuiScrollingEnabled(true); renderer.draw(0, DEFAULT_CRT_SETTINGS);
    rows = Array.from({ length: 35 }, (_, row) => row < 30 ? `old-${row + 3}` : `first-${row}`); listeners.forEach((listener) => listener()); renderer.draw(.1, DEFAULT_CRT_SETTINGS);
    rows = Array.from({ length: 35 }, (_, row) => row >= 2 && row < 32 ? rows[row + 3] : `second-${row}`); listeners.forEach((listener) => listener()); renderer.draw(.11, DEFAULT_CRT_SETTINGS);
    const entries = JSON.parse(renderer.exportSmoothScrollDiagnostics()).entries;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'heuristic-skip', reason: 'active-region-changed' }), expect.objectContaining({ event: 'transition-cancelled', operation: 'region' })]));
    expect(entries.filter((entry: { event: string; operation?: string; outcome?: string }) => entry.event === 'transition-request' && entry.operation === 'region' && entry.outcome === 'started')).toHaveLength(1);
  });
});
