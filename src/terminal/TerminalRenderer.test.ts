import { afterEach, describe, expect, it, vi } from 'vitest';
import { fontCellSize, TerminalRenderer } from './TerminalRenderer';
import { DEFAULT_CRT_SETTINGS } from '../crt/settings';

afterEach(() => vi.restoreAllMocks());

describe('TerminalRenderer', () => {
  it('uses window pixels for aspect-constrained physical modes', () => {
    const output = document.createElement('canvas'); output.width = 1234; output.height = 567;
    for (const id of ['physical-4x3', 'physical-8x5']) {
      const renderer = new TerminalRenderer();
      renderer.resizeSource({ id, width: 4, height: 3 }, output);
      expect(renderer.sourceCanvas).toMatchObject({ width: 1234, height: 567 });
    }
  });

  it('redraws only a changed terminal row', () => {
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const cell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    const rows = [[cell('A'), cell('B')], [cell('C'), cell('D')]]; let parsed = () => {};
    const terminal = { cols: 2, rows: 2, options: {}, buffer: { active: { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getNullCell: () => cell(''), getLine: (row: number) => ({ getCell: (column: number) => rows[row]?.[column] }) } }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: (listener: () => void) => { parsed = listener; return { dispose() {} }; }, onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas')); renderer.bindTerminal(terminal as never);
    expect(renderer.draw(0, DEFAULT_CRT_SETTINGS)).toBe(true); context.fillText.mockClear();
    rows[0][0] = cell('X'); parsed();
    expect(renderer.draw(.1, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(context.fillText).toHaveBeenCalledTimes(2);
  });

  it('memoizes fontCellSize and reuses measurement context when none is supplied', () => {
    const measureTextSpy = vi.fn().mockReturnValue({ width: 10, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 3 });
    const mockCtx = { font: '', measureText: measureTextSpy };
    const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: vi.fn().mockReturnValue(mockCtx),
    } as unknown as HTMLCanvasElement);

    const size1 = fontCellSize(14, 'CustomTestFont');
    expect(size1).toEqual({ width: 10, height: 15 });
    const size2 = fontCellSize(14, 'CustomTestFont');
    expect(size2).toEqual({ width: 10, height: 15 });

    // Repeated call with same font should hit cache and not call measureText or createElement again
    expect(measureTextSpy).toHaveBeenCalledTimes(1);
    createElementSpy.mockRestore();
  });
});
