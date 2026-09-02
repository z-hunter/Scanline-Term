import { type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent, useEffect, useRef, useState } from 'react';
import { Terminal, type IBufferCell } from '@xterm/xterm';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { CRTFilter, type CRTColorMode, type CRTSettings } from './crt/CRTFilter';
import {
  DEFAULT_CRT_SETTINGS,
  DEFAULT_RESOLUTION,
  loadStoredSettings,
  RESOLUTIONS,
  type ResolutionId,
} from './crt/settings';
import { terminalKey } from './terminal-input';
import { terminalMouse, type MouseTrackingMode } from './terminal-mouse';
import { win32InputKey } from './win32-input';
import { COLOR_PROFILES, colorProfile, DEFAULT_COLOR_PROFILE_ID, profileColor, remapLegacyRgb, type TerminalColorProfile } from './terminal-color-profiles';
import './styles.css';

const STORAGE_KEY = 'scanline-term.settings.v1';

type NumericKey = Exclude<keyof CRTSettings, 'crtEmulation' | 'colorProfile' | 'consoleFont' | 'bezelGlow' | 'showBezel' | 'antiAliasedPixels' | 'colorMode' | 'bloomAlgorithm'>;
type Control = { key: NumericKey; label: string; min: number; max: number; step: number };
type CopyPoint = { row: number; column: number };
type CopySelection = { start: CopyPoint; end: CopyPoint };
const controls: Record<string, Control[]> = {
  Geometry: [
    { key: 'curvature', label: 'Curvature', min: 0, max: 0.5, step: 0.01 },
    { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.05 },
  ],
  Raster: [
    { key: 'scanlineCount', label: 'Scanline count', min: 0, max: 768, step: 10 },
    { key: 'scanlineIntensity', label: 'Scanline intensity', min: 0, max: 1, step: 0.05 },
    { key: 'beamModulation', label: 'Beam modulation', min: 0, max: 1, step: 0.05 },
  ],
  Light: [
    { key: 'aberration', label: 'RGB split', min: 0, max: 5, step: 0.1 },
    { key: 'bloom', label: 'Bloom', min: 0, max: 1, step: 0.05 },
    { key: 'glow', label: 'Screen glow', min: 0, max: 1, step: 0.05 },
    { key: 'phosphor', label: 'Phosphor / grain', min: 0, max: 1, step: 0.05 },
  ],
  'Final image': [
    { key: 'imageBrightness', label: 'Image brightness', min: 0.5, max: 1.5, step: 0.05 },
    { key: 'imageContrast', label: 'Image contrast', min: 0.5, max: 1.5, step: 0.05 },
  ],
  Temporal: [
    { key: 'persistence', label: 'Phosphor trail', min: 0, max: 1, step: 0.05 },
    { key: 'persistenceIntensity', label: 'Trail intensity', min: 0, max: 4, step: 0.05 },
    { key: 'breathing', label: 'HV breathing', min: 0, max: 1, step: 0.05 },
  ],
};

function Knob({ value, min, max, step, label, onChange }: { value: number; min: number; max: number; step: number; label: string; onChange: (value: number) => void }) {
  const start = useRef<{ y: number; value: number } | null>(null);
  const setFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || !event.buttons) return;
    const next = Math.min(max, Math.max(min, start.current.value + (start.current.y - event.clientY) * step / 8));
    onChange(Math.round(next / step) * step);
  };
  const ratio = (value - min) / (max - min);
  return <div
    className="knob"
    role="slider"
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    tabIndex={0}
    style={{ '--knob-progress': `${ratio * 340}deg` } as React.CSSProperties}
    onPointerDown={(event) => { start.current = { y: event.clientY, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={setFromPointer}
    onPointerUp={() => { start.current = null; }}
    onWheel={(event) => { event.preventDefault(); onChange(Math.min(max, Math.max(min, value + (event.deltaY < 0 ? step : -step)))); }}
    onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(Math.min(max, value + step)); if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(Math.max(min, value - step)); }}
  ><span>{formatValue(value)}</span></div>;
}

function terminalPadding(width: number, height: number): number {
  return Math.max(2, Math.floor(Math.min(width, height) * 0.01));
}

function fontCellSize(fontSize: number, family: string, context?: CanvasRenderingContext2D): { width: number; height: number } {
  context ??= document.createElement('canvas').getContext('2d') ?? undefined;
  if (!context) return { width: Math.ceil(fontSize * 0.6), height: Math.ceil(fontSize * 1.2) };
  context.font = canvasFont(fontSize, family);
  const metrics = context.measureText('M');
  const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontSize;
  const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || Math.ceil(fontSize * 0.2);
  return { width: Math.ceil(metrics.width), height: Math.ceil(ascent + descent) };
}

function terminalDimensions(width: number, height: number, fontSize: number, fontFamily: string): { cols: number; rows: number } {
  const padding = terminalPadding(width, height);
  const cell = fontCellSize(fontSize, fontFamily);
  return {
    cols: Math.max(20, Math.min(300, Math.floor((width - padding * 2) / cell.width))),
    rows: Math.max(8, Math.min(150, Math.floor((height - padding * 2) / cell.height))),
  };
}

function sourceDimensions(resolution: (typeof RESOLUTIONS)[number], output?: HTMLCanvasElement | null): { width: number; height: number } {
  if (resolution.id === 'physical') return { width: output?.width || 1, height: output?.height || 1 };
  return resolution;
}

function activeColorProfile(settings: CRTSettings): TerminalColorProfile {
  return colorProfile(settings.colorProfile ?? DEFAULT_COLOR_PROFILE_ID);
}

function cellColor(cell: IBufferCell, foreground: boolean, profile: TerminalColorProfile): string {
  const isRgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette = foreground ? cell.isFgPalette() : cell.isBgPalette();
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (isRgb) return remapLegacyRgb(profile, `#${value.toString(16).padStart(6, '0')}`);
  if (isPalette) return profileColor(profile, value);
  return foreground ? profile.foreground : profile.background;
}

function canvasFont(fontSize: number, family: string): string {
  return `${fontSize}px "${family.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}", Consolas, "Courier New", monospace`;
}

function drawTerminal(canvas: HTMLCanvasElement, terminal: Terminal, time: number, profile: TerminalColorProfile, fontFamily: string, fontSize: number, selection: CopySelection | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const padding = terminalPadding(canvas.width, canvas.height);
  const { width: cellWidth, height: cellHeight } = fontCellSize(fontSize, fontFamily, ctx);
  ctx.fillStyle = profile.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = canvasFont(fontSize, fontFamily);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const buffer = terminal.buffer.active;
  const ydisp = buffer.viewportY;
  const cell = buffer.getNullCell();
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(ydisp + row);
    if (!line) continue;
    const y = padding + cellHeight * (row + 0.5);
    for (let column = 0; column < terminal.cols; column += 1) {
      const current = line.getCell(column, cell);
      if (!current || current.getWidth() === 0) continue;
      let foreground = cellColor(current, true, profile);
      let background = cellColor(current, false, profile);
      if (current.isInverse()) [foreground, background] = [background, foreground];
      const x = padding + cellWidth * column;
      if (background !== profile.background) {
        ctx.fillStyle = background;
        const left = Math.floor(x);
        const top = Math.floor(y - cellHeight / 2);
        ctx.fillRect(left, top, Math.ceil(x + cellWidth * current.getWidth()) - left, Math.ceil(y + cellHeight / 2) - top);
      }
      const position = (ydisp + row) * terminal.cols + column;
      const selectionStart = selection ? selection.start.row * terminal.cols + selection.start.column : -1;
      const selectionEnd = selection ? selection.end.row * terminal.cols + selection.end.column : -1;
      if (selection && position >= Math.min(selectionStart, selectionEnd) && position <= Math.max(selectionStart, selectionEnd)) {
        ctx.fillStyle = 'rgba(125, 210, 255, 0.42)';
        ctx.fillRect(Math.floor(x), Math.floor(y - cellHeight / 2), Math.ceil(cellWidth * current.getWidth()), Math.ceil(cellHeight));
      }
      const chars = current.getChars();
      if (chars && !current.isInvisible()) {
        ctx.globalAlpha = current.isDim() ? 0.6 : 1;
        ctx.fillStyle = foreground;
        ctx.fillText(chars, x, y);
      }
    }
  }
  ctx.globalAlpha = 1;
  const core = (terminal as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
  const cursorVisible = ydisp === buffer.baseY
    && core?.coreService?.isCursorHidden !== true
    && buffer.cursorX >= 0 && buffer.cursorX < terminal.cols && buffer.cursorY >= 0 && buffer.cursorY < terminal.rows;
  if (cursorVisible && Math.floor(time * 2) % 2 === 0) {
    const cursorX = padding + cellWidth * buffer.cursorX;
    const cursorY = padding + cellHeight * buffer.cursorY;
    ctx.fillStyle = profile.cursor ?? profile.foreground;
    const cursorWidth = Math.max(2, Math.min(cellWidth, terminal.options.cursorWidth ?? cellWidth * 0.15));
    if (terminal.options.cursorStyle === 'underline') ctx.fillRect(cursorX, cursorY + cellHeight - 2, cellWidth, 2);
    else if (terminal.options.cursorStyle === 'bar') ctx.fillRect(cursorX, cursorY, cursorWidth, Math.ceil(cellHeight));
    else ctx.fillRect(cursorX, cursorY, cellWidth, Math.ceil(cellHeight));
  }
}

function drawMockTerminal(canvas: HTMLCanvasElement, time: number, fontFamily: string, fontSize: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const lineHeight = Math.floor(fontSize * 1.5);
  ctx.fillStyle = '#050806';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = canvasFont(fontSize, fontFamily);
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#7dffae';
  ctx.fillText('SCANLINE TERM // CRT DISPLAY DIAGNOSTIC', fontSize, fontSize);
  ctx.fillStyle = '#4ecf83';
  ctx.fillText(`virtual framebuffer ${canvas.width}×${canvas.height}`, fontSize, fontSize + lineHeight);

  const lines = [
    '[ OK ] phosphor matrix online',
    '[ OK ] scanline generator synchronized',
    '[ OK ] WebGL fragment pipeline ready',
    '> rendering an ordinary terminal as an old monitor',
    '> browser preview uses a mock session',
    '',
    '  0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F',
    '  -- amber phosphor / green phosphor / glass glow --',
    '',
    `  frame ${Math.floor(time * 10) % 10000}  uptime ${(time % 3600).toFixed(1)}s`,
  ];
  lines.forEach((line, index) => {
    ctx.fillStyle = ['#9affbd', '#62db91', '#78c9ff', '#ffd166', '#ff8a80'][index % 5];
    ctx.fillText(line, fontSize, fontSize + lineHeight * (index + 3));
  });
  const menuTop = canvas.height - lineHeight * 4;

  if (canvas.width >= 480) {
    // Keep a colorful ANSI-like diagnostic area in the otherwise empty terminal space.
    const paletteX = Math.floor(canvas.width * 0.58);
    const paletteY = fontSize + lineHeight * 3;
    ctx.fillStyle = '#d8b4ff';
    ctx.fillText('ANSI COLOR TABLE', paletteX, paletteY);
    const palette = [
      ['RED', '#ff6b6b'], ['GREEN', '#72f1a4'], ['BLUE', '#72b7ff'],
      ['AMBER', '#ffd166'], ['MAGENTA', '#e59cff'], ['CYAN', '#63e6e2'],
    ] as const;
    palette.forEach(([label, color], index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = paletteX + column * Math.max(fontSize * 10, Math.floor(canvas.width * 0.16));
      const y = paletteY + lineHeight * (row + 1);
      ctx.fillStyle = color;
      ctx.fillRect(x, y + 2, Math.max(6, Math.floor(fontSize * 1.2)), Math.max(6, fontSize - 2));
      ctx.fillText(label, x + fontSize * 2, y);
    });

    // A breathing pseudo-graphics box expands and collapses in the free area.
    const pulse = (Math.sin(time * 1.8) + 1) / 2;
    const boxX = paletteX;
    const boxY = paletteY + lineHeight * 4;
    const boxWidth = Math.max(8, Math.floor(Math.max(8, (canvas.width - boxX - fontSize * 2) / fontSize) * (0.45 + pulse * 0.55)));
    const maxBoxRows = Math.max(3, Math.floor((menuTop - boxY - lineHeight) / lineHeight));
    const boxHeight = Math.max(3, 3 + Math.floor(pulse * Math.max(0, maxBoxRows - 3)));
    const horizontal = '─'.repeat(boxWidth);
    const boxLines = [`┌${horizontal}┐`, ...Array.from({ length: boxHeight - 2 }, () => `│${' '.repeat(boxWidth)}│`), `└${horizontal}┘`];
    ctx.fillStyle = pulse > 0.5 ? '#63e6e2' : '#e59cff';
    boxLines.forEach((line, index) => ctx.fillText(line, boxX, boxY + lineHeight * index));
  }

  ctx.fillStyle = '#092615';
  ctx.fillRect(0, menuTop - 2, canvas.width, lineHeight * 4 + 2);
  ctx.fillStyle = '#7dffae';
  ctx.fillText('C:\\SCANLINE   A: PROGRAMS   B: DATA', fontSize, menuTop);
  ctx.fillStyle = '#62db91';
  ctx.fillText('README.TXT  CRT.CFG   QUEST.BIN   TERMINAL.LOG', fontSize, menuTop + lineHeight);
  ctx.fillText('F1 Help  F2 Menu  F3 View  F4 Edit  F5 Copy', fontSize, menuTop + lineHeight * 2);
  ctx.fillText('F6 Move  F7 MkDir F8 Delete F9 PullDn F10 Quit', fontSize, menuTop + lineHeight * 3);
  if (Math.floor(time * 2) % 2 === 0) {
    const cursorY = menuTop + lineHeight * 3;
    const cursorX = fontSize + ctx.measureText('F6 Move  F7 MkDir F8 Delete F9 PullDn F10 Quit').width;
    ctx.fillStyle = '#b7ffd0';
    ctx.fillRect(cursorX, cursorY, Math.max(6, Math.floor(fontSize * 0.65)), lineHeight - 2);
  }
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export default function App() {
  const [stored, setStored] = useState(() => loadStoredSettings(localStorage.getItem(STORAGE_KEY)));
  const [error, setError] = useState<string | null>(null);
  const [terminalLive, setTerminalLive] = useState(false);
  const [monospaceFonts, setMonospaceFonts] = useState<string[]>(['Consolas']);
  const [settingsVisible, setSettingsVisible] = useState(true);
  const [, setCopyMode] = useState(false);
  const [terminalSize, setTerminalSize] = useState({ cols: 0, rows: 0 });
  const [fps, setFps] = useState(0);
  const resolution = RESOLUTIONS.find((item) => item.id === stored.resolution) ?? RESOLUTIONS[1];
  const outputRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const filterRef = useRef<CRTFilter | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalLiveRef = useRef(false);
  const sendInputRef = useRef<(input: string) => void>(() => {});
  const win32InputModeRef = useRef(false);
  const fullscreenShortcutRef = useRef(false);
  const menuKeyDownRef = useRef(false);
  const sgrMouseModeRef = useRef(false);
  const pressedMouseButtonsRef = useRef<Set<number>>(new Set());
  const copyModeRef = useRef(false);
  const copyStartRowRef = useRef<CopyPoint | null>(null);
  const copySelectionRef = useRef<CopySelection | null>(null);
  const terminalSizeRef = useRef({ cols: 0, rows: 0 });
  const resolutionRef = useRef(resolution);
  const settingsRef = useRef(stored.crt);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    settingsRef.current = stored.crt;
    resolutionRef.current = resolution;
  }, [stored, resolution]);

  useEffect(() => {
    const source = sourceRef.current ?? document.createElement('canvas');
    sourceRef.current = source;
    const size = sourceDimensions(resolution, outputRef.current);
    source.width = size.width;
    source.height = size.height;
    filterRef.current?.clearPersistence();
  }, [resolution]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<string[]>('list_monospace_fonts')
      .then((fonts) => setMonospaceFonts([...new Set(['Consolas', ...fonts])]))
      .catch((reason) => setError(`Could not list system fonts: ${String(reason)}`));
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const { width, height } = sourceDimensions(resolutionRef.current, outputRef.current);
    const { cols, rows } = terminalDimensions(width, height, settingsRef.current.consoleFontSize, settingsRef.current.consoleFont);
    const profile = activeColorProfile(settingsRef.current);
    const terminal = new Terminal({ cols, rows, scrollback: 1000, theme: { foreground: profile.foreground, background: profile.background } });
    terminalRef.current = terminal;
    const pressedMouseButtons = pressedMouseButtonsRef.current;
    const terminalResponse = terminal.onData((data) => sendInputRef.current(data));
    const enableWin32Input = terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(1006)) sgrMouseModeRef.current = true;
      if (params.length !== 1 || params[0] !== 9001) return false;
      win32InputModeRef.current = true;
      return true;
    });
    const disableWin32Input = terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(1006)) sgrMouseModeRef.current = false;
      if (params.length !== 1 || params[0] !== 9001) return false;
      win32InputModeRef.current = false;
      return true;
    });
    let unlisten: UnlistenFn | undefined;
    const start = window.setTimeout(async () => {
      try {
        unlisten = await listen<number[]>('terminal-output', (event) => terminal.write(Uint8Array.from(event.payload)));
        await invoke('start_terminal', { cols, rows });
        terminalSizeRef.current = { cols, rows };
        setTerminalSize({ cols, rows });
        terminalLiveRef.current = true;
        setTerminalLive(true);
      } catch (reason) {
        setError(`Windows console could not start: ${String(reason)}`);
      }
    });
    return () => {
      window.clearTimeout(start);
      unlisten?.();
      terminalLiveRef.current = false;
      win32InputModeRef.current = false;
      sgrMouseModeRef.current = false;
      pressedMouseButtons.clear();
      terminalSizeRef.current = { cols: 0, rows: 0 };
      setTerminalSize({ cols: 0, rows: 0 });
      terminalResponse.dispose();
      terminal.dispose();
      enableWin32Input.dispose();
      disableWin32Input.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminalLiveRef.current || !terminal) return;
    const source = sourceRef.current;
    if (!source) return;
    const { cols, rows } = terminalDimensions(source.width, source.height, stored.crt.consoleFontSize, stored.crt.consoleFont);
    if (cols === terminalSizeRef.current.cols && rows === terminalSizeRef.current.rows) return;
    terminalSizeRef.current = { cols, rows };
    setTerminalSize({ cols, rows });
    terminal.resize(cols, rows);
    void invoke('resize_terminal', { cols, rows }).catch((reason) => setError(`Terminal resize failed: ${String(reason)}`));
  }, [resolution, stored.crt.consoleFont, stored.crt.consoleFontSize]);

  useEffect(() => {
    const output = outputRef.current;
    const source = sourceRef.current;
    if (!output || !source) return;
    const filter = new CRTFilter(output);
    filterRef.current = filter;

    let raf = 0;
    let errorReported = false;
    let sourceDirty = true;
    let lastCursorPhase = -1;
    let lastSourceSize = '';
    let lastSourceStyle = '';
    let frameCount = 0;
    let fpsStarted = performance.now();
    const terminal = terminalRef.current;
    const outputWritten = terminal?.onWriteParsed(() => { sourceDirty = true; });
    const scrolled = terminal?.onScroll(() => { sourceDirty = true; });
    const resize = () => {
      const rect = output.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      output.width = Math.max(1, Math.round(rect.width * dpr));
      output.height = Math.max(1, Math.round(rect.height * dpr));
      if (resolutionRef.current.id === 'physical') {
        source.width = output.width;
        source.height = output.height;
      }
      sourceDirty = true;
      // A resized presentation surface must start with a fresh phosphor history.
      filter.clearPersistence();
      const terminal = terminalRef.current;
      if (!terminalLiveRef.current || !terminal) return;
      const { cols, rows } = terminalDimensions(source.width, source.height, settingsRef.current.consoleFontSize, settingsRef.current.consoleFont);
      if (cols === terminalSizeRef.current.cols && rows === terminalSizeRef.current.rows) return;
      terminalSizeRef.current = { cols, rows };
      setTerminalSize({ cols, rows });
      terminal.resize(cols, rows);
      void invoke('resize_terminal', { cols, rows }).catch((reason) => setError(`Terminal resize failed: ${String(reason)}`));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(output);
    resize();

    const render = (now: number) => {
      const time = now / 1000;
      const settings = settingsRef.current;
      const selection = copySelectionRef.current;
      const sourceStyle = `${settings.consoleFont}|${settings.consoleFontSize}|${settings.colorProfile}|${selection?.start.row}:${selection?.start.column}:${selection?.end.row}:${selection?.end.column}`;
      const sourceSize = `${source.width}x${source.height}`;
      const cursorPhase = Math.floor(time * 2);
      if (sourceStyle !== lastSourceStyle || sourceSize !== lastSourceSize || cursorPhase !== lastCursorPhase) sourceDirty = true;
      if (terminalLiveRef.current && terminalRef.current) {
        if (sourceDirty) drawTerminal(source, terminalRef.current, time, activeColorProfile(settings), settings.consoleFont, settings.consoleFontSize, selection);
      } else {
        drawMockTerminal(source, time, settings.consoleFont, settings.consoleFontSize);
        sourceDirty = true;
      }
      lastSourceStyle = sourceStyle;
      lastSourceSize = sourceSize;
      lastCursorPhase = cursorPhase;
      if (!filter.isValid() && !errorReported) {
        errorReported = true;
        setError('WebGL is unavailable in this WebView.');
      }
      if (filter.isValid()) filter.render(source, settings, sourceDirty);
      sourceDirty = false;
      frameCount += 1;
      if (now - fpsStarted >= 500) {
        setFps(Math.round(frameCount * 1000 / (now - fpsStarted)));
        frameCount = 0;
        fpsStarted = now;
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      outputWritten?.dispose();
      scrolled?.dispose();
      filter.dispose();
      filterRef.current = null;
    };
  }, []);

  const updateCrt = (key: NumericKey, value: number) => {
    setStored((current) => ({ ...current, crt: { ...current.crt, [key]: value } }));
  };

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY);
    setStored({ version: 1, resolution: DEFAULT_RESOLUTION, crt: { ...DEFAULT_CRT_SETTINGS } });
    filterRef.current?.clearPersistence();
  };

  const sendInput = (input: string) => {
    if (!terminalLiveRef.current || !input) return;
    void invoke('write_terminal', { input }).catch((reason) => setError(`Terminal input failed: ${String(reason)}`));
  };

  useEffect(() => {
    sendInputRef.current = sendInput;
  });

  const terminalMouseCell = (event: ReactMouseEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>, terminal: Terminal) => {
    const output = outputRef.current;
    const source = sourceRef.current;
    if (!output || !source) return null;
    const rect = output.getBoundingClientRect();
    const padding = terminalPadding(source.width, source.height);
    const x = (event.clientX - rect.left) * source.width / rect.width;
    const y = (event.clientY - rect.top) * source.height / rect.height;
    const cell = fontCellSize(settingsRef.current.consoleFontSize, settingsRef.current.consoleFont);
    return {
      col: Math.max(1, Math.min(terminal.cols, Math.floor((x - padding) / cell.width) + 1)),
      row: Math.max(1, Math.min(terminal.rows, Math.floor((y - padding) / cell.height) + 1)),
    };
  };

  const copySelection = async (terminal: Terminal, start: CopyPoint, end: CopyPoint) => {
    const buffer = terminal.buffer.active;
    const [first, last] = start.row < end.row || start.row === end.row && start.column <= end.column ? [start, end] : [end, start];
    const text = Array.from({ length: last.row - first.row + 1 }, (_, index) => {
      const row = first.row + index;
      const line = buffer.getLine(row);
      return line?.translateToString(index === last.row - first.row, row === first.row ? first.column : 0, row === last.row ? last.column + 1 : terminal.cols) ?? '';
    }).join('\r\n').replace(/(?:\r\n|\r|\n)$/, '');
    if (text) await navigator.clipboard.writeText(text);
  };

  const copyPoint = (terminal: Terminal, cell: { col: number; row: number }): CopyPoint => ({
    row: Math.max(terminal.buffer.active.viewportY, terminal.buffer.active.viewportY + cell.row - 2),
    column: Math.max(0, cell.col - 3),
  });

  const sendMouse = (event: ReactMouseEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>, action: Parameters<typeof terminalMouse>[0]['action'], button?: 0 | 1 | 2) => {
    const terminal = terminalRef.current;
    const tracking = terminal?.modes.mouseTrackingMode as MouseTrackingMode | undefined;
    if (!terminal || !tracking || tracking === 'none') return false;
    if (tracking === 'x10' && (action !== 'press' || event.ctrlKey || event.altKey || event.shiftKey)) return false;
    if (tracking === 'vt200' && action === 'move') return false;
    const cell = terminalMouseCell(event, terminal);
    if (!cell) return false;
    event.preventDefault();
    sendInput(terminalMouse({ ...cell, action, button, sgr: sgrMouseModeRef.current, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey }));
    return true;
  };

  const handleTerminalWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    const terminal = terminalRef.current;
    if (!terminal || event.deltaY === 0) return;
    if (sendMouse(event, event.deltaY < 0 ? 'wheel-up' : 'wheel-down')) return;
    event.preventDefault();
    if (terminal.buffer.active !== terminal.buffer.normal) return;
    terminal.scrollLines(Math.sign(event.deltaY) * 3);
  };

  const handleTerminalMouseMove = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const terminal = terminalRef.current;
    if (terminal && copyStartRowRef.current !== null && event.buttons) {
      const cell = terminalMouseCell(event, terminal);
      if (cell) {
        const end = copyPoint(terminal, cell);
        copySelectionRef.current = { start: copyStartRowRef.current, end };
      }
      return;
    }
    const tracking = terminal?.modes.mouseTrackingMode as MouseTrackingMode | undefined;
    if (!terminal || !tracking || tracking === 'none') return;
    if (tracking === 'drag' && pressedMouseButtonsRef.current.size === 0) return;
    if (tracking === 'x10' || tracking === 'vt200') return;
    sendMouse(event, 'move', pressedMouseButtonsRef.current.values().next().value as 0 | 1 | 2 | undefined);
  };

  const handleTerminalMouseDown = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const terminal = terminalRef.current;
    if (terminal && ((copyModeRef.current && event.button === 0) || event.button === 1)) {
      const cell = terminalMouseCell(event, terminal);
      if (cell) {
        event.preventDefault();
        copyStartRowRef.current = copyPoint(terminal, cell);
        copySelectionRef.current = { start: copyStartRowRef.current, end: copyStartRowRef.current };
      }
      return;
    }
    if (event.button > 2) return;
    const button = event.button as 0 | 1 | 2;
    if (sendMouse(event, 'press', button)) pressedMouseButtonsRef.current.add(button);
  };

  const handleTerminalMouseUp = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const terminal = terminalRef.current;
    if (terminal && copyStartRowRef.current !== null) {
      const cell = terminalMouseCell(event, terminal);
      const start = copyStartRowRef.current;
      copyStartRowRef.current = null;
      copyModeRef.current = false;
      setCopyMode(false);
      if (cell) {
        const end = copyPoint(terminal, cell);
        copySelectionRef.current = { start, end };
        void copySelection(terminal, start, end).catch((reason) => setError(`Clipboard copy failed: ${String(reason)}`));
        copySelectionRef.current = null;
      }
      return;
    }
    if (event.button <= 2) {
      sendMouse(event, 'release', event.button as 0 | 1 | 2);
      pressedMouseButtonsRef.current.delete(event.button);
    }
  };

  const handleTerminalMouseLeave = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    for (const button of pressedMouseButtonsRef.current) sendMouse(event, 'release', button as 0 | 1 | 2);
    pressedMouseButtonsRef.current.clear();
  };

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if (event.key === 'ContextMenu') menuKeyDownRef.current = true;
      if (menuKeyDownRef.current && event.code === 'KeyS') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) setSettingsVisible((visible) => !visible);
        return;
      }
      if (menuKeyDownRef.current && event.code === 'KeyV') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) navigator.clipboard.readText().then(sendInputRef.current).catch((reason) => setError(`Clipboard paste failed: ${String(reason)}`));
        return;
      }
      if (menuKeyDownRef.current && event.code === 'KeyC') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          copyModeRef.current = true;
          setCopyMode(true);
        }
        return;
      }
      if (event.altKey && event.key === 'Enter' && isTauri()) {
        event.preventDefault();
        event.stopPropagation();
        fullscreenShortcutRef.current = true;
        if (event.repeat) return;
        try {
          const window = getCurrentWindow();
          await window.setFullscreen(!(await window.isFullscreen()));
        } catch (reason) {
          setError(`Fullscreen toggle failed: ${String(reason)}`);
        }
        return;
      }
      const terminal = terminalRef.current;
      if (!terminalLiveRef.current || !terminal) return;
      const input = win32InputModeRef.current ? win32InputKey(event, true) : terminalKey(event, terminal.modes);
      event.preventDefault();
      event.stopPropagation();
      if (input) sendInputRef.current(input);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ContextMenu') menuKeyDownRef.current = false;
      if (fullscreenShortcutRef.current && event.key === 'Enter') {
        fullscreenShortcutRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const terminal = terminalRef.current;
      if (!terminalLiveRef.current || !terminal) return;
      event.preventDefault();
      event.stopPropagation();
      if (win32InputModeRef.current) sendInputRef.current(win32InputKey(event, false));
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  return (
    <main className={`app-shell${settingsVisible ? '' : ' settings-hidden'}`}>
      <section className="display-panel" aria-label="CRT display">
        <div className={`screen-frame${stored.crt.showBezel ? '' : ' bezel-hidden'}`}>
          <canvas
            ref={outputRef}
            className="output-canvas"
            data-testid="output-canvas"
            tabIndex={terminalLive ? 0 : -1}
            aria-label={terminalLive ? 'Windows console' : 'CRT display'}
            onWheel={handleTerminalWheel}
            onMouseDown={handleTerminalMouseDown}
            onMouseUp={handleTerminalMouseUp}
            onMouseMove={handleTerminalMouseMove}
            onMouseLeave={handleTerminalMouseLeave}
            onContextMenu={(event) => event.preventDefault()}
            onPaste={(event) => {
              const input = event.clipboardData.getData('text');
              if (!input) return;
              event.preventDefault();
              sendInput(input);
            }}
          />
          <span className="frame-status">{terminalSize.cols} × {terminalSize.rows}</span>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      {settingsVisible && <aside className="settings-panel">
        <header>
          <p className="eyebrow">SCANLINE TERM</p>
          <h1>CRT display lab</h1>
          <p className="display-status">CONSOLE BUFFER: {terminalSize.cols} × {terminalSize.rows} · FPS: {fps}</p>
        </header>
        <label className="resolution-control">
          Virtual resolution
          <select
            value={stored.resolution}
            data-testid="resolution-select"
            onChange={(event) => setStored((current) => ({ ...current, resolution: event.target.value as ResolutionId }))}
          >
            {RESOLUTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="resolution-control">
          Color mode
          <select
            value={stored.crt.colorMode}
            data-testid="color-mode-select"
            onChange={(event) => setStored((current) => ({
              ...current,
              crt: { ...current.crt, colorMode: event.target.value as CRTColorMode },
            }))}
          >
            <option value="color">Color</option>
            <option value="bw">B&amp;W</option>
            <option value="green">Green</option>
            <option value="amber">Amber</option>
            <option value="blue">Phosphor Blue</option>
          </select>
        </label>
        <label className="resolution-control">
          Color profile
          <select
            value={stored.crt.colorProfile}
            data-testid="color-profile-select"
            onChange={(event) => setStored((current) => ({
              ...current,
              crt: { ...current.crt, colorProfile: event.target.value as CRTSettings['colorProfile'] },
            }))}
          >
            {COLOR_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
          </select>
        </label>
        <label className="resolution-control">
          Bloom algorithm
          <select
            value={stored.crt.bloomAlgorithm}
            onChange={(event) => setStored((current) => ({
              ...current,
              crt: { ...current.crt, bloomAlgorithm: event.target.value as CRTSettings['bloomAlgorithm'] },
            }))}
          >
            <option value="soft">Soft blur</option>
            <option value="spiral">Spiral (legacy)</option>
          </select>
        </label>
        <label className="resolution-control">
          Console font
          <select
            value={stored.crt.consoleFont}
            onChange={(event) => setStored((current) => ({
              ...current,
              crt: { ...current.crt, consoleFont: event.target.value },
            }))}
          >
            {!monospaceFonts.includes(stored.crt.consoleFont) && <option value={stored.crt.consoleFont}>{stored.crt.consoleFont} (fallback)</option>}
            {monospaceFonts.map((font) => <option key={font} value={font}>{font}</option>)}
          </select>
        </label>
        <label className="resolution-control">
          Console font size
          <select
            value={stored.crt.consoleFontSize}
            onChange={(event) => setStored((current) => ({
              ...current,
              crt: { ...current.crt, consoleFontSize: Number(event.target.value) },
            }))}
          >
            {[6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32].map((size) => <option key={size} value={size}>{size} px</option>)}
          </select>
        </label>
        {Object.entries(controls).map(([group, groupControls]) => (
          <fieldset className="knob-group" key={group}>
            <legend>{group}</legend>
            {groupControls.map((control) => (
              <label className="slider-control" key={control.key}>
                <span>{control.label}<output>{formatValue(stored.crt[control.key])}</output></span>
                <Knob value={stored.crt[control.key]} min={control.min} max={control.max} step={control.step} label={control.label} onChange={(value) => updateCrt(control.key, value)} />
              </label>
            ))}
          </fieldset>
        ))}
        <fieldset className="knob-group">
          <legend>Surface</legend>
          <label className="slider-control">
            <span>Background desaturation<output>{formatValue(stored.crt.backgroundDesaturation)}</output></span>
            <Knob value={stored.crt.backgroundDesaturation} min={0} max={1} step={0.05} label="Background desaturation" onChange={(value) => updateCrt('backgroundDesaturation', value)} />
          </label>
        </fieldset>
        <fieldset>
          <legend>Display</legend>
          <label className="check-control">
            <input
              type="checkbox"
              checked={stored.crt.crtEmulation}
              data-testid="control-crtEmulation"
              onChange={(event) => setStored((current) => ({ ...current, crt: { ...current.crt, crtEmulation: event.target.checked } }))}
            />
            CRT Emulation
          </label>
          <label className="check-control">
            <input
              type="checkbox"
              checked={stored.crt.bezelGlow}
              onChange={(event) => setStored((current) => ({ ...current, crt: { ...current.crt, bezelGlow: event.target.checked } }))}
            />
            Bezel glow
          </label>
          <label className="check-control">
            <input
              type="checkbox"
              checked={stored.crt.showBezel}
              onChange={(event) => setStored((current) => ({ ...current, crt: { ...current.crt, showBezel: event.target.checked } }))}
            />
            Monitor frame
          </label>
          <label className="check-control">
            <input
              type="checkbox"
              checked={stored.crt.antiAliasedPixels}
              onChange={(event) => setStored((current) => ({ ...current, crt: { ...current.crt, antiAliasedPixels: event.target.checked } }))}
            />
            Anti-moiré pixels
          </label>
        </fieldset>
        <button type="button" className="reset-button" onClick={reset}>Reset defaults</button>
        <footer>v0.2 · ConPTY · ANSI screen buffer</footer>
      </aside>}
    </main>
  );
}
