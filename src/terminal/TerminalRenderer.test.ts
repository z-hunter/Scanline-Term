import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { applyTabColorMode, canvasFont, canvasFontLoad, detectVerticalScroll, fontCellSize, inspectVerticalScroll, loadCanvasFont, terminalAverageColor, terminalAverageLuma, terminalContentOffset, terminalDimensions, TerminalRenderer } from './TerminalRenderer';
import { colorProfile } from '../terminal-color-profiles';
import { DEFAULT_CRT_SETTINGS } from '../crt/settings';

afterEach(() => vi.restoreAllMocks());

describe('TerminalRenderer', () => {
  it('detects unambiguous vertical shifts in either direction', () => {
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F'], ['B', 'C', 'D', 'E', 'F', 'G'])).toMatchObject({ deltaRows: 1, topRow: 0, bottomRow: 6, overlapRows: 5, matchTopRow: 0, matchBottomRow: 5 });
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F'], ['Z', 'A', 'B', 'C', 'D', 'E'])).toMatchObject({ deltaRows: -1, topRow: 0, bottomRow: 6, overlapRows: 5, matchTopRow: 1, matchBottomRow: 6 });
    expect(detectVerticalScroll(['header', 'A', 'B', 'B', 'C', 'D', 'E', 'F'], ['A', 'B', 'B', 'C', 'D', 'E', 'F', 'tail'])).toMatchObject({ deltaRows: 1, overlapRows: 7 });
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], ['B', 'C', 'D*', 'E', 'F', 'G', 'H', 'I'], ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])).toMatchObject({ deltaRows: 1, overlapRows: 7, presentationMismatchRows: [2] });
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], ['B*', 'C', 'D*', 'E', 'F*', 'G', 'H', 'I', 'J', 'K'], ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'])).toBeNull();
  });

  it('rejects weak or ambiguous scroll evidence', () => {
    expect(detectVerticalScroll(['', 'A', '', 'B', '', ''], ['A', '', 'B', '', '', 'X'])).toBeNull();
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F'], ['B', 'C', 'X', 'E', 'F', 'G'])).toBeNull();
    expect(detectVerticalScroll(['A', 'B', 'C'], ['B', 'C', 'D'])).toBeNull();
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'X', 'A', 'B', 'C', 'D', 'Y'], ['B', 'C', 'D', 'X', 'Q', 'B', 'C', 'D', 'Y', 'Z'])).toBeNull();
    expect(detectVerticalScroll(['A', 'A', 'A', 'A', 'A', 'A'], ['A', 'A', 'A', 'A', 'A', 'X'])).toBeNull();
  });

  it('reports the detector rejection for diagnostics', () => {
    expect(inspectVerticalScroll(['A', 'B', 'C'], ['B', 'C', 'D'])).toMatchObject({ candidate: null, rejection: 'no-four-row-exact-overlap' });
  });

  it('forwards xterm scroll events to the bound callback', () => {
    let scrolled: (viewportY: number) => void = () => {};
    const terminal = {
      onCursorMove: () => ({ dispose() {} }),
      onWriteParsed: () => ({ dispose() {} }),
      onScroll: (listener: (viewportY: number) => void) => { scrolled = listener; return { dispose() {} }; },
    };
    const onScroll = vi.fn();
    new TerminalRenderer().bindTerminal(terminal as never, onScroll);
    scrolled(42);
    expect(onScroll).toHaveBeenCalledWith(42);
  });

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

  it('tracks a scroll transition and cancels it safely', () => {
    const context = { drawImage: vi.fn(), clearRect: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const normal = { viewportY: 0, baseY: 0 };
    const terminal = {
      buffer: { active: normal, normal },
      onCursorMove: () => ({ dispose() {} }),
      onWriteParsed: () => ({ dispose() {} }),
      onScroll: () => ({ dispose() {} }),
    };
    const renderer = new TerminalRenderer();
    renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas'));
    renderer.bindTerminal(terminal as never);

    expect(renderer.beginScroll(0, 1)).toBe(true);
    expect(renderer.isScrollAnimating).toBe(true);
    expect(renderer.consumeScrollStart()).toBe(true);
    context.drawImage.mockClear();
    renderer.cancelScroll();
    expect(renderer.isScrollAnimating).toBe(false);
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it('retargets scrollback without replacing its source snapshot', () => {
    const context = { drawImage: vi.fn(), clearRect: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const normal = { viewportY: 0, baseY: 0 };
    const terminal = {
      buffer: { active: normal, normal },
      onCursorMove: () => ({ dispose() {} }),
      onWriteParsed: () => ({ dispose() {} }),
      onScroll: () => ({ dispose() {} }),
    };
    const renderer = new TerminalRenderer();
    renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas'));
    renderer.bindTerminal(terminal as never);
    renderer.beginScroll(0, 3);
    context.drawImage.mockClear();

    renderer.beginScroll(3, 6);

    expect(renderer.isScrollAnimating).toBe(true);
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it('captures the current frame for an incompatible scroll direction', () => {
    const context = { drawImage: vi.fn(), clearRect: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const normal = { viewportY: 0, baseY: 0 };
    const terminal = {
      buffer: { active: normal, normal },
      onCursorMove: () => ({ dispose() {} }),
      onWriteParsed: () => ({ dispose() {} }),
      onScroll: () => ({ dispose() {} }),
    };
    const renderer = new TerminalRenderer();
    renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas'));
    renderer.bindTerminal(terminal as never);
    renderer.beginScroll(0, 3);
    context.drawImage.mockClear();

    renderer.beginScroll(3, 0);

    expect(renderer.isScrollAnimating).toBe(true);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(context.drawImage.mock.calls[0][0]).not.toBe(renderer.compositedCanvas);
    expect(context.drawImage.mock.calls[0][0]).toBe((renderer as unknown as { scrollFrameCanvas: HTMLCanvasElement }).scrollFrameCanvas);
    expect((renderer as unknown as { scrollTransition: { fromPosition?: number } }).scrollTransition?.fromPosition).toBeCloseTo(0, 1);
  });

  it('animates an unambiguous alternate-buffer output shift', () => {
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', imageSmoothingEnabled: true, fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn(), save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const makeCell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    const alternate = { viewportY: 0, baseY: 0, cursorX: -1, cursorY: -1, getNullCell: () => makeCell(''), getLine: (row: number) => ({ getCell: () => makeCell(rows[row] ?? '') }) };
    let rows = ['A', 'B', 'C', 'D', 'E', 'F']; let parsed = () => {};
    const terminal = { cols: 1, rows: 6, options: {}, buffer: { active: alternate, alternate, normal: {} }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: (listener: () => void) => { parsed = listener; return { dispose() {} }; }, onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 80, height: 120 }, document.createElement('canvas')); renderer.bindTerminal(terminal as never); renderer.setSmoothScrollingEnabled(true);
    renderer.draw(0, DEFAULT_CRT_SETTINGS);
    rows = ['B', 'C', 'D', 'E', 'F', 'G']; parsed();
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F'], rows)).not.toBeNull();
    expect(renderer.draw(.1, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(renderer.isScrollAnimating).toBe(true);
  });

  it('animates stable normal-buffer TUI shifts but not scrollback growth', () => {
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', imageSmoothingEnabled: true, fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn(), save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const makeCell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    let rows = ['A', 'B', 'C', 'D', 'E', 'F']; let parsed = () => {};
    const normal = { viewportY: 7, baseY: 7, cursorX: -1, cursorY: -1, getNullCell: () => makeCell(''), getLine: (row: number) => ({ getCell: () => makeCell(rows[row - normal.viewportY] ?? '') }) };
    const terminal = { cols: 1, rows: 6, options: {}, buffer: { active: normal, normal, alternate: {} }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: (listener: () => void) => { parsed = listener; return { dispose() {} }; }, onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 80, height: 120 }, document.createElement('canvas')); renderer.bindTerminal(terminal as never); renderer.setSmoothScrollingEnabled(true);
    renderer.draw(0, DEFAULT_CRT_SETTINGS);
    rows = ['B', 'C', 'D', 'E', 'F', 'G']; parsed(); renderer.draw(.1, DEFAULT_CRT_SETTINGS);
    expect(renderer.isScrollAnimating).toBe(true);
    renderer.cancelScroll();
    rows = ['C', 'D', 'E', 'F', 'G', 'H']; normal.viewportY = normal.baseY = 8; parsed(); renderer.draw(.2, DEFAULT_CRT_SETTINGS);
    expect(renderer.isScrollAnimating).toBe(false);
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

  it('renders static text attributes and decorations', () => {
    const fillRect = vi.fn();
    const fillText = vi.fn();
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', fillRect, fillText, measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const cell = {
      getChars: () => 'A', getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0,
      isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false,
      isInverse: () => false, isDim: () => false, isInvisible: () => false,
      isBold: () => 1, isItalic: () => 1, isUnderline: () => 1, isStrikethrough: () => 1, isOverline: () => 1,
    };
    const terminal = { cols: 1, rows: 1, options: {}, _core: { coreService: { isCursorHidden: true } }, buffer: { active: { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getNullCell: () => cell, getLine: () => ({ getCell: () => cell }) } }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: () => ({ dispose() {} }), onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 20, height: 20 }, document.createElement('canvas')); renderer.bindTerminal(terminal as never);

    renderer.draw(0, DEFAULT_CRT_SETTINGS);

    expect(context.font).toMatch(/^italic bold 16px/);
    expect(fillText).toHaveBeenCalledWith('A', expect.any(Number), expect.any(Number), expect.any(Number));
    expect(fillRect.mock.calls.filter((call) => call[2] === 8 && call[3] === 1)).toHaveLength(3);
  });

  it('redraws when only a text attribute changes', () => {
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    let bold = false;
    const cell = { getChars: () => 'A', getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false, isBold: () => Number(bold), isItalic: () => 0, isUnderline: () => 0, isStrikethrough: () => 0, isOverline: () => 0 };
    let parsed = () => {};
    const terminal = { cols: 1, rows: 1, options: {}, _core: { coreService: { isCursorHidden: true } }, buffer: { active: { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getNullCell: () => cell, getLine: () => ({ getCell: () => cell }) } }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: (listener: () => void) => { parsed = listener; return { dispose() {} }; }, onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 20, height: 20 }, document.createElement('canvas')); renderer.bindTerminal(terminal as never);

    renderer.draw(0, DEFAULT_CRT_SETTINGS); context.fillText.mockClear(); bold = true; parsed();

    expect(renderer.draw(.1, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(context.fillText).toHaveBeenCalledTimes(1);
    expect(context.font).toMatch(/^bold 16px/);
  });

  it('renders attributes from a real xterm buffer', async () => {
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const terminal = new Terminal({ cols: 4, rows: 1 });
    await new Promise<void>((resolve) => terminal.write('\x1b[1;3;4;9;53mA', resolve));
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 40, height: 20 }, document.createElement('canvas')); renderer.bindTerminal(terminal);

    expect(renderer.draw(0, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(context.font).toMatch(/^italic bold 16px/);
  });

  it.each(['│', '▎'])('repeats the measured vertical raster through the cell for %s', (chars) => {
    const pixels = new Uint8ClampedArray(8 * 4); pixels[2 * 4 + 3] = 128; pixels[3 * 4 + 3] = 128; pixels[5 * 4 + 3] = 255; pixels[6 * 4 + 3] = 255;
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', fillRect: vi.fn(), fillText: vi.fn(), getImageData: vi.fn(() => ({ data: pixels })), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const cell = { getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false };
    const terminal = { cols: 1, rows: 1, options: {}, _core: { coreService: { isCursorHidden: true } }, buffer: { active: { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getNullCell: () => cell, getLine: () => ({ getCell: () => cell }) } }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: () => ({ dispose() {} }), onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 20, height: 20 }, document.createElement('canvas')); renderer.bindTerminal(terminal as never);

    expect(renderer.draw(0, { ...DEFAULT_CRT_SETTINGS, cellHeightAdjustment: 2 })).toBe(true);
    expect(context.fillText).toHaveBeenCalledTimes(1); // profile extraction canvas
    expect(context.getImageData).toHaveBeenCalledWith(0, 6, 8, 1);
    expect(context.fillRect).toHaveBeenCalledWith(8, 4, 2, 12);
    expect(context.fillRect).toHaveBeenCalledWith(11, 4, 2, 12);
  });

  it('redraws when a cell changes color mode with the same numeric colors', () => {
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    let rgb = true;
    const cell = { getChars: () => 'A', getWidth: () => 1, getFgColor: () => 1, getBgColor: () => 2, isFgRGB: () => rgb, isBgRGB: () => rgb, isFgPalette: () => !rgb, isBgPalette: () => !rgb, isInverse: () => false, isDim: () => false, isInvisible: () => false };
    let parsed = () => {};
    const terminal = { cols: 1, rows: 1, options: {}, _core: { coreService: { isCursorHidden: true } }, buffer: { active: { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getNullCell: () => cell, getLine: () => ({ getCell: () => cell }) } }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: (listener: () => void) => { parsed = listener; return { dispose() {} }; }, onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas')); renderer.bindTerminal(terminal as never);

    expect(renderer.draw(0, DEFAULT_CRT_SETTINGS)).toBe(true);
    context.fillText.mockClear();
    rgb = false;
    parsed();
    expect(renderer.draw(.1, DEFAULT_CRT_SETTINGS)).toBe(true);
    expect(context.fillText).toHaveBeenCalledTimes(1);
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

  it('registers native font bytes for canvas rendering', async () => {
    const add = vi.fn();
    const face = { load: vi.fn().mockResolvedValue('loaded-face') };
    const FontFaceMock = vi.fn(function FontFaceMock() { return face; });
    const fonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    vi.stubGlobal('FontFace', FontFaceMock);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add } });
    await loadCanvasFont('Native Test Font', [0, 1, 2]);
    expect(FontFaceMock).toHaveBeenCalledWith('Native Test Font', expect.any(Uint8Array));
    expect(add).toHaveBeenCalledWith('loaded-face');
    expect(canvasFontLoad('Native Test Font')).toBeDefined();
    if (fonts) Object.defineProperty(document, 'fonts', fonts);
  });

  it('caches native font loading, including the loader promise', async () => {
    const loader = vi.fn().mockResolvedValue(null);
    const first = canvasFontLoad('In-flight Font', loader)!;
    const second = canvasFontLoad('In-flight Font', vi.fn())!;
    expect(second).toBe(first);
    await first;
    expect(loader).toHaveBeenCalledTimes(1);
    expect(canvasFontLoad('In-flight Font')).toBe(first);
  });

  it('drops a rejected native font load so the next attempt can retry', async () => {
    const failed = canvasFontLoad('Retry Font', () => Promise.reject(new Error('load failed')))!;
    await expect(failed).rejects.toThrow('load failed');
    expect(canvasFontLoad('Retry Font')).toBeUndefined();
    const retry = canvasFontLoad('Retry Font', () => Promise.resolve(null));
    expect(retry).toBeDefined();
    await retry;
  });

  it('applies cell size adjustments without allowing zero-sized cells', () => {
    const context = { font: '', measureText: () => ({ width: 10, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 3 }) };
    expect(fontCellSize(14, 'AdjustedFont', context as unknown as CanvasRenderingContext2D, 4, -2)).toEqual({ width: 14, height: 13 });
    expect(fontCellSize(14, 'AdjustedFont', context as unknown as CanvasRenderingContext2D, -20, -20)).toEqual({ width: 1, height: 1 });
  });

  it('uses adjusted cells for terminal dimensions and mouse mapping', () => {
    const base = terminalDimensions(400, 400, 16, 'MouseFont');
    const adjusted = terminalDimensions(400, 400, 16, 'MouseFont', 5, 4);
    expect(adjusted.cols).toBeLessThan(base.cols);
    expect(adjusted.rows).toBeLessThan(base.rows);

    const cell = { getChars: () => '', getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false };
    const terminal = { cols: 5, rows: 5, buffer: { active: { getNullCell: () => cell } }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: () => ({ dispose() {} }), onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer();
    renderer.resizeSource({ id: 'test', width: 100, height: 100 }, document.createElement('canvas'));
    renderer.bindTerminal(terminal as never);
    const output = document.createElement('canvas'); output.width = 100; output.height = 100;
    vi.spyOn(output, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const unadjusted = renderer.cellAtPoint(30, 10, output, { ...DEFAULT_CRT_SETTINGS, consoleFont: 'MouseFont', cellWidthAdjustment: 0, cellHeightAdjustment: 0 });
    const widened = renderer.cellAtPoint(30, 10, output, { ...DEFAULT_CRT_SETTINGS, consoleFont: 'MouseFont', cellWidthAdjustment: 5, cellHeightAdjustment: 4 });
    expect(widened?.col).not.toBe(unadjusted?.col);
  });

  it('averages visible cell colors and chooses readable tab text', () => {
    const cell = { getChars: () => '', getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0xffffff, isFgRGB: () => false, isBgRGB: () => true, isFgPalette: () => false, isBgPalette: () => false };
    const terminal = { cols: 2, rows: 1, buffer: { active: { viewportY: 0, getNullCell: () => cell, getLine: () => ({ getCell: () => cell }) } } };
    expect(terminalAverageColor(terminal as never, colorProfile('dos-vga'))).toEqual({ background: '#ffffff', foreground: '#101a14' });
    expect(terminalAverageLuma(terminal as never, colorProfile('dos-vga'))).toBeCloseTo(1);
  });

  it('applies the CRT phosphor tint to tab colors without canvas readback', () => {
    expect(applyTabColorMode('#808080', 'green')).toBe('#5d8068');
    expect(applyTabColorMode('#808080', 'amber')).toBe('#866c4d');
    expect(applyTabColorMode('#ff0000', 'bw', 1)).toBe('#363636');
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

  it('formats canvas font strings with and without fallback font', () => {
    expect(canvasFont(16, 'MyFont')).toBe('16px "MyFont", Consolas, "Courier New", monospace');
    expect(canvasFont(14, 'Primary Font', 'Fallback Font')).toBe('14px "Primary Font", "Fallback Font", Consolas, "Courier New", monospace');
    expect(canvasFont(14, 'Primary Font', '')).toBe('14px "Primary Font", Consolas, "Courier New", monospace');
    expect(canvasFont(14, 'Primary Font', 'Primary Font')).toBe('14px "Primary Font", Consolas, "Courier New", monospace');
  });

  it('applies fallback font in draw loop when configured in settings', () => {
    const context = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'middle', fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 8, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const cell = (chars: string) => ({ getChars: () => chars, getWidth: () => 1, getFgColor: () => 0, getBgColor: () => 0, isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false, isInverse: () => false, isDim: () => false, isInvisible: () => false });
    const terminal = { cols: 2, rows: 2, options: {}, buffer: { active: { viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getNullCell: () => cell(''), getLine: () => ({ getCell: () => cell('A') }) } }, onCursorMove: () => ({ dispose() {} }), onWriteParsed: () => ({ dispose() {} }), onScroll: () => ({ dispose() {} }) };
    const renderer = new TerminalRenderer(); renderer.resizeSource({ id: 'test', width: 80, height: 40 }, document.createElement('canvas')); renderer.bindTerminal(terminal as never);

    renderer.draw(0, { ...DEFAULT_CRT_SETTINGS, consoleFont: 'CustomFont', fallbackFont: 'SecondaryFont' });
    expect(context.font).toBe('16px "CustomFont", "SecondaryFont", Consolas, "Courier New", monospace');
  });

  it('hit-tests the topmost normalized image', () => {
    const renderer = new TerminalRenderer();
    renderer.resizeSource({ id: 'test', width: 100, height: 100 }, document.createElement('canvas'));
    const image = (id: string, x: number): import('./TerminalRenderer').TerminalImage => ({ id, src: '', image: {} as HTMLImageElement, x, y: .2, width: .4, height: .4, baseWidth: .4, baseHeight: .4 });
    const bottom = image('bottom', .1); const top = image('top', .2);
    renderer.setImages([bottom, top]);
    expect(renderer.imageAtSourcePoint(30, 30)).toBe(top);
    expect(renderer.imageAtSourcePoint(12, 30)).toBe(bottom);
    expect(renderer.imageAtSourcePoint(90, 90)).toBeNull();
  });
});
