import { afterEach, describe, expect, it, vi } from 'vitest';
import { fontCellSize, terminalAverageColor, terminalAverageLuma, terminalContentOffset, TerminalRenderer } from './TerminalRenderer';
import { colorProfile } from '../terminal-color-profiles';
import { DEFAULT_CRT_SETTINGS } from '../crt/settings';

afterEach(() => vi.restoreAllMocks());

describe('TerminalRenderer', () => {
  it('centers the rendered grid after cell dimensions are rounded', () => {
    expect(terminalContentOffset(100, 103, 8, 8, { width: 10, height: 10 })).toEqual({ x: 10, y: 11 });
  });

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
    expect(renderer.hasMeasuredLuma).toBe(false);
    expect(renderer.draw(0, DEFAULT_CRT_SETTINGS)).toBe(true); context.fillText.mockClear();
    expect(renderer.hasMeasuredLuma).toBe(true);
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

  it('averages visible cell colors and chooses readable tab text', () => {
    const cell = { getChars: () => '', getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0xffffff, isFgRGB: () => false, isBgRGB: () => true, isFgPalette: () => false, isBgPalette: () => false };
    const terminal = { cols: 2, rows: 1, buffer: { active: { viewportY: 0, getNullCell: () => cell, getLine: () => ({ getCell: () => cell }) } } };
    expect(terminalAverageColor(terminal as never, colorProfile('dos-vga'))).toEqual({ background: '#ffffff', foreground: '#101a14' });
    expect(terminalAverageLuma(terminal as never, colorProfile('dos-vga'))).toBeCloseTo(1);
  });

  it('uses the full source raster for breathing luma, not a single glyph cell', () => {
    const cell = { getChars: () => 'X', getWidth: () => 1, getFgColor: () => 0xffffff, getBgColor: () => 0, isFgRGB: () => true, isBgRGB: () => true, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false };
    const terminal = { cols: 1, rows: 1, buffer: { active: { viewportY: 0, getNullCell: () => cell, getLine: () => ({ getCell: () => cell }) } } };
    expect(terminalAverageLuma(terminal as never, colorProfile('dos-vga'), { width: 100, height: 100, cellWidth: 10, cellHeight: 10, padding: 0 })).toBeCloseTo(0.0008);
  });

  it('swaps foreground and background for inverse cells when calculating average color', () => {
    const normalCell = { getChars: () => '', getWidth: () => 1, getFgColor: () => 0xffffff, getBgColor: () => 0x000000, isFgRGB: () => true, isBgRGB: () => true, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false };
    const inverseCell = { getChars: () => '', getWidth: () => 1, getFgColor: () => 0xffffff, getBgColor: () => 0x000000, isFgRGB: () => true, isBgRGB: () => true, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => true };
    const normalTerminal = { cols: 1, rows: 1, buffer: { active: { viewportY: 0, getNullCell: () => normalCell, getLine: () => ({ getCell: () => normalCell }) } } };
    const inverseTerminal = { cols: 1, rows: 1, buffer: { active: { viewportY: 0, getNullCell: () => inverseCell, getLine: () => ({ getCell: () => inverseCell }) } } };
    expect(terminalAverageColor(normalTerminal as never, colorProfile('dos-vga')).background).toBe('#000000');
    expect(terminalAverageColor(inverseTerminal as never, colorProfile('dos-vga')).background).toBe('#ffffff');
  });

  it('renders cursor according to cursorStyle setting', () => {
    const fillRectSpy = vi.fn();
    const fillTextSpy = vi.fn();
    const context = {
      fillStyle: '',
      globalAlpha: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'middle',
      fillRect: fillRectSpy,
      fillText: fillTextSpy,
      measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const cell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    const rows = [[cell('A'), cell('B')]];
    const terminal = {
      cols: 2,
      rows: 1,
      options: {},
      buffer: {
        active: {
          viewportY: 0,
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          getNullCell: () => cell(''),
          getLine: (row: number) => ({ getCell: (column: number) => rows[row]?.[column] }),
        },
      },
      onCursorMove: () => ({ dispose() {} }),
      onWriteParsed: () => ({ dispose() {} }),
      onScroll: () => ({ dispose() {} }),
    };

    const renderer = new TerminalRenderer();
    renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas'));
    renderer.bindTerminal(terminal as never);

    // Test 'underline'
    fillRectSpy.mockClear();
    renderer.markDirty();
    renderer.draw(0, { ...DEFAULT_CRT_SETTINGS, cursorStyle: 'underline' });
    const underlineCall = fillRectSpy.mock.calls.find((call) => call[2] === 8 && call[3] === 2);
    expect(underlineCall).toBeDefined();

    // Test 'bar'
    fillRectSpy.mockClear();
    renderer.markDirty();
    renderer.draw(0, { ...DEFAULT_CRT_SETTINGS, cursorStyle: 'bar' });
    const barCall = fillRectSpy.mock.calls.find((call) => call[2] === 2 && call[3] === 10);
    expect(barCall).toBeDefined();

    // Test 'block'
    fillRectSpy.mockClear();
    renderer.markDirty();
    renderer.draw(0, { ...DEFAULT_CRT_SETTINGS, cursorStyle: 'block' });
    const blockCall = fillRectSpy.mock.calls.find((call) => call[2] === 8 && call[3] === 10);
    expect(blockCall).toBeDefined();
  });

  it('does not blink cursor while moving or typing, and only blinks when stationary', () => {
    const fillRectSpy = vi.fn();
    const context = {
      fillStyle: '',
      globalAlpha: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'middle',
      fillRect: fillRectSpy,
      fillText: vi.fn(),
      measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const cell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    const rows = [[cell('A'), cell('B'), cell('C'), cell('D'), cell('E')]];
    let onCursorMoveCallback = () => {};
    const terminalBuffer = {
      viewportY: 0,
      baseY: 0,
      cursorX: 0,
      cursorY: 0,
      getNullCell: () => cell(''),
      getLine: (row: number) => ({ getCell: (column: number) => rows[row]?.[column] }),
    };
    const terminal = {
      cols: 5,
      rows: 1,
      options: {},
      buffer: { active: terminalBuffer },
      onCursorMove: (cb: () => void) => { onCursorMoveCallback = cb; return { dispose() {} }; },
      onWriteParsed: () => ({ dispose() {} }),
      onScroll: () => ({ dispose() {} }),
    };

    const renderer = new TerminalRenderer();
    renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas'));
    renderer.bindTerminal(terminal as never);

    // Initial frame at t = 0: cursor at (0, 0) should be drawn (visible)
    fillRectSpy.mockClear();
    expect(renderer.draw(0, DEFAULT_CRT_SETTINGS)).toBe(true);
    // Cursor fillRect should be called with width=8, height=10
    expect(fillRectSpy.mock.calls.some((c) => c[0] === 20 && c[1] === 15 && c[2] === 8 && c[3] === 10)).toBe(true);

    // After remaining stationary for > 0.5s (t = 0.55): cursor blinks off
    fillRectSpy.mockClear();
    expect(renderer.draw(0.55, DEFAULT_CRT_SETTINGS)).toBe(true);
    // Row 0 background is cleared/redrawn, but cursor is NOT drawn
    expect(fillRectSpy.mock.calls.some((c) => c[2] === 8 && c[3] === 10)).toBe(false);

    // Cursor moves while in the "off" phase: t = 0.60, cursorX = 1
    terminalBuffer.cursorX = 1;
    onCursorMoveCallback();
    fillRectSpy.mockClear();
    expect(renderer.draw(0.60, DEFAULT_CRT_SETTINGS)).toBe(true);
    // Cursor MUST immediately be visible at col 1 (x = 28)
    expect(fillRectSpy.mock.calls.some((c) => c[0] === 28 && c[1] === 15 && c[2] === 8 && c[3] === 10)).toBe(true);

    // Continue moving (t = 0.70, cursorX = 2): stays visible
    terminalBuffer.cursorX = 2;
    onCursorMoveCallback();
    fillRectSpy.mockClear();
    expect(renderer.draw(0.70, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(fillRectSpy.mock.calls.some((c) => c[0] === 36 && c[1] === 15 && c[2] === 8 && c[3] === 10)).toBe(true);

    // Continue moving (t = 0.80, cursorX = 3): stays visible
    terminalBuffer.cursorX = 3;
    onCursorMoveCallback();
    fillRectSpy.mockClear();
    expect(renderer.draw(0.80, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(fillRectSpy.mock.calls.some((c) => c[0] === 44 && c[1] === 15 && c[2] === 8 && c[3] === 10)).toBe(true);

    // Stop moving at t = 0.80. At t = 1.10 (0.3s after stopping, < 0.5s): still visible, no redraw needed
    expect(renderer.draw(1.10, DEFAULT_CRT_SETTINGS)).toBe(false);

    // At t = 1.35 (> 0.5s after stopping at 0.80): blinks off
    fillRectSpy.mockClear();
    expect(renderer.draw(1.35, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(fillRectSpy.mock.calls.some((c) => c[2] === 8 && c[3] === 10)).toBe(false);

    // At t = 1.85 (> 1.0s after stopping at 0.80): blinks on again
    fillRectSpy.mockClear();
    expect(renderer.draw(1.85, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(fillRectSpy.mock.calls.some((c) => c[0] === 44 && c[1] === 15 && c[2] === 8 && c[3] === 10)).toBe(true);
  });

  it('pauses cursor blinking when unfocused and keeps cursor solid visible', () => {
    const fillRectSpy = vi.fn();
    const context = {
      fillStyle: '',
      globalAlpha: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'middle',
      fillRect: fillRectSpy,
      fillText: vi.fn(),
      measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const cell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    const rows = [[cell('A')]];
    const terminal = {
      cols: 1,
      rows: 1,
      options: {},
      buffer: { active: { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getNullCell: () => cell(''), getLine: () => ({ getCell: () => rows[0][0] }) } },
      onCursorMove: () => ({ dispose() {} }),
      onWriteParsed: () => ({ dispose() {} }),
      onScroll: () => ({ dispose() {} }),
    };

    const renderer = new TerminalRenderer();
    renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas'));
    renderer.bindTerminal(terminal as never);

    // Focus lost: blinking is paused
    renderer.setFocused(false);
    expect(renderer.isCursorBlinkActive()).toBe(false);
    expect(renderer.getCursorBlinkPhase(0)).toBe(0);
    expect(renderer.getCursorBlinkPhase(0.75)).toBe(0);
    expect(renderer.getCursorBlinkPhase(2.5)).toBe(0);

    // When drawn while unfocused, cursor is solid ON
    fillRectSpy.mockClear();
    expect(renderer.draw(0.75, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(fillRectSpy.mock.calls.some((c) => c[2] === 8 && c[3] === 10)).toBe(true);

    // Subsequent draws while unfocused and idle return false (no blink redraws)
    expect(renderer.draw(1.25, DEFAULT_CRT_SETTINGS)).toBe(false);
    expect(renderer.draw(1.75, DEFAULT_CRT_SETTINGS)).toBe(false);

    // Regain focus: cursor resets move time and starts solid ON
    renderer.setFocused(true);
    expect(renderer.isCursorBlinkActive()).toBe(true);
  });
});
