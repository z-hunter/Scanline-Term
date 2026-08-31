import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { Terminal, type IBufferCell } from '@xterm/xterm';
import { invoke, isTauri } from '@tauri-apps/api/core';
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
import { COLOR_PROFILES, colorProfile, DEFAULT_COLOR_PROFILE_ID, profileColor, remapLegacyRgb, type TerminalColorProfile } from './terminal-color-profiles';
import './styles.css';

const STORAGE_KEY = 'scanline-term.settings.v1';

type NumericKey = Exclude<keyof CRTSettings, 'crtEmulation' | 'colorProfile' | 'bezelGlow' | 'antiAliasedPixels' | 'colorMode'>;
type Control = { key: NumericKey; label: string; min: number; max: number; step: number };
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

function terminalPadding(width: number, height: number): number {
  return Math.max(4, Math.floor(Math.min(width, height) * 0.02));
}

function terminalDimensions(width: number, height: number, visibleWidth: number, visibleHeight: number): { cols: number; rows: number } {
  const padding = terminalPadding(width, height);
  return {
    cols: Math.max(20, Math.min(300, Math.floor(Math.min((width - padding * 2) / 6, visibleWidth / 8)))),
    rows: Math.max(8, Math.min(150, Math.floor(Math.min((height - padding * 2) / 12, visibleHeight / 16)))),
  };
}

function activeColorProfile(settings: CRTSettings): TerminalColorProfile {
  return colorProfile(settings.colorMode === 'color' ? settings.colorProfile : DEFAULT_COLOR_PROFILE_ID);
}

function cellColor(cell: IBufferCell, foreground: boolean, profile: TerminalColorProfile): string {
  const isRgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette = foreground ? cell.isFgPalette() : cell.isBgPalette();
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (isRgb) return remapLegacyRgb(profile, `#${value.toString(16).padStart(6, '0')}`);
  if (isPalette) return profileColor(profile, value);
  return foreground ? profile.foreground : profile.background;
}

function drawTerminal(canvas: HTMLCanvasElement, terminal: Terminal, time: number, profile: TerminalColorProfile): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const padding = terminalPadding(canvas.width, canvas.height);
  const cellWidth = (canvas.width - padding * 2) / terminal.cols;
  const cellHeight = (canvas.height - padding * 2) / terminal.rows;
  const fontSize = Math.max(7, Math.floor(Math.min(cellHeight * 0.78, cellWidth / 0.55)));
  ctx.fillStyle = profile.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontSize}px Consolas, "Courier New", monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
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
      const chars = current.getChars();
      if (chars && !current.isInvisible()) {
        ctx.globalAlpha = current.isDim() ? 0.6 : 1;
        ctx.fillStyle = foreground;
        ctx.fillText(chars, x, y);
      }
    }
  }
  ctx.globalAlpha = 1;
  if (Math.floor(time * 2) % 2 === 0) {
    const cursorX = padding + cellWidth * buffer.cursorX;
    const cursorY = padding + cellHeight * buffer.cursorY;
    ctx.fillStyle = profile.cursor ?? profile.foreground;
    ctx.fillRect(cursorX, cursorY, Math.max(2, Math.floor(cellWidth * 0.8)), Math.ceil(cellHeight));
  }
}

function drawMockTerminal(canvas: HTMLCanvasElement, time: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const fontSize = Math.max(10, Math.floor(canvas.width / 80));
  const lineHeight = Math.floor(fontSize * 1.5);
  ctx.fillStyle = '#050806';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontSize}px Consolas, "Courier New", monospace`;
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
  const resolution = RESOLUTIONS.find((item) => item.id === stored.resolution) ?? RESOLUTIONS[1];
  const outputRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const filterRef = useRef<CRTFilter | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalLiveRef = useRef(false);
  const terminalInputRef = useRef(Promise.resolve());
  const pendingInputRef = useRef('');
  const inputFrameRef = useRef(0);
  const terminalSizeRef = useRef({ cols: 0, rows: 0 });
  const initialResolutionRef = useRef(resolution);
  const settingsRef = useRef(stored.crt);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    settingsRef.current = stored.crt;
  }, [stored]);

  useEffect(() => {
    const source = sourceRef.current ?? document.createElement('canvas');
    sourceRef.current = source;
    source.width = resolution.width;
    source.height = resolution.height;
    filterRef.current?.clearPersistence();
  }, [resolution.height, resolution.width]);

  useEffect(() => {
    if (!isTauri()) return;
    const { width, height } = initialResolutionRef.current;
    const rect = outputRef.current?.getBoundingClientRect();
    const { cols, rows } = terminalDimensions(width, height, rect?.width ?? window.innerWidth, rect?.height ?? window.innerHeight);
    const profile = activeColorProfile(settingsRef.current);
    const terminal = new Terminal({ cols, rows, scrollback: 1000, theme: { foreground: profile.foreground, background: profile.background } });
    terminalRef.current = terminal;
    let unlisten: UnlistenFn | undefined;
    const start = window.setTimeout(async () => {
      try {
        unlisten = await listen<number[]>('terminal-output', (event) => terminal.write(Uint8Array.from(event.payload)));
        await invoke('start_terminal', { cols, rows });
        terminalSizeRef.current = { cols, rows };
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
      terminalSizeRef.current = { cols: 0, rows: 0 };
      pendingInputRef.current = '';
      cancelAnimationFrame(inputFrameRef.current);
      inputFrameRef.current = 0;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminalLiveRef.current || !terminal) return;
    const rect = outputRef.current?.getBoundingClientRect();
    const { cols, rows } = terminalDimensions(resolution.width, resolution.height, rect?.width ?? window.innerWidth, rect?.height ?? window.innerHeight);
    if (cols === terminalSizeRef.current.cols && rows === terminalSizeRef.current.rows) return;
    terminalSizeRef.current = { cols, rows };
    terminal.resize(cols, rows);
    void invoke('resize_terminal', { cols, rows }).catch((reason) => setError(`Terminal resize failed: ${String(reason)}`));
  }, [resolution.height, resolution.width]);

  useEffect(() => {
    const output = outputRef.current;
    const source = sourceRef.current;
    if (!output || !source) return;
    const filter = new CRTFilter(output);
    filterRef.current = filter;

    let raf = 0;
    let errorReported = false;
    const resize = () => {
      const rect = output.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      output.width = Math.max(1, Math.round(rect.width * dpr));
      output.height = Math.max(1, Math.round(rect.height * dpr));
      const terminal = terminalRef.current;
      if (!terminalLiveRef.current || !terminal) return;
      const { cols, rows } = terminalDimensions(source.width, source.height, rect.width, rect.height);
      if (cols === terminalSizeRef.current.cols && rows === terminalSizeRef.current.rows) return;
      terminalSizeRef.current = { cols, rows };
      terminal.resize(cols, rows);
      void invoke('resize_terminal', { cols, rows }).catch((reason) => setError(`Terminal resize failed: ${String(reason)}`));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(output);
    resize();

    const render = (now: number) => {
      const time = now / 1000;
      const settings = settingsRef.current;
      if (terminalLiveRef.current && terminalRef.current) drawTerminal(source, terminalRef.current, time, activeColorProfile(settings));
      else drawMockTerminal(source, time);
      if (!filter.isValid() && !errorReported) {
        errorReported = true;
        setError('WebGL is unavailable in this WebView.');
      }
      if (filter.isValid()) filter.render(source, settings);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
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
    pendingInputRef.current += input;
    if (inputFrameRef.current) return;
    inputFrameRef.current = requestAnimationFrame(() => {
      inputFrameRef.current = 0;
      const pending = pendingInputRef.current;
      pendingInputRef.current = '';
      if (!pending || !terminalLiveRef.current) return;
      terminalInputRef.current = terminalInputRef.current
        .then(() => invoke('write_terminal', { input: pending }))
        .then(() => undefined)
        .catch((reason) => setError(`Terminal input failed: ${String(reason)}`));
    });
  };

  const handleTerminalKey = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const terminal = terminalRef.current;
    const input = terminal && terminalKey(event.nativeEvent, terminal.modes);
    if (!input) return;
    event.preventDefault();
    sendInput(input);
  };

  return (
    <main className="app-shell">
      <section className="display-panel" aria-label="CRT display">
        <div className="screen-frame">
          <canvas
            ref={outputRef}
            className="output-canvas"
            data-testid="output-canvas"
            tabIndex={terminalLive ? 0 : -1}
            aria-label={terminalLive ? 'Windows console' : 'CRT display'}
            onKeyDown={handleTerminalKey}
            onPaste={(event) => {
              const input = event.clipboardData.getData('text');
              if (!input) return;
              event.preventDefault();
              sendInput(input);
            }}
          />
        </div>
        <p className="display-status">{terminalLive ? 'WINDOWS CMD · click screen to type' : 'MOCK SESSION'} · {resolution.width}×{resolution.height}</p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <aside className="settings-panel">
        <header>
          <p className="eyebrow">SCANLINE TERM</p>
          <h1>CRT display lab</h1>
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
            disabled={stored.crt.colorMode !== 'color'}
            onChange={(event) => setStored((current) => ({
              ...current,
              crt: { ...current.crt, colorProfile: event.target.value as CRTSettings['colorProfile'] },
            }))}
          >
            {COLOR_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
          </select>
        </label>
        {Object.entries(controls).map(([group, groupControls]) => (
          <fieldset key={group}>
            <legend>{group}</legend>
            {groupControls.map((control) => (
              <label className="slider-control" key={control.key}>
                <span>{control.label}<output>{formatValue(stored.crt[control.key])}</output></span>
                <input
                  type="range"
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  value={stored.crt[control.key]}
                  data-testid={`control-${control.key}`}
                  onChange={(event) => updateCrt(control.key, Number(event.target.value))}
                />
              </label>
            ))}
          </fieldset>
        ))}
        <fieldset>
          <legend>Surface</legend>
          <label className="slider-control">
            <span>Background desaturation<output>{formatValue(stored.crt.backgroundDesaturation)}</output></span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={stored.crt.backgroundDesaturation}
              disabled={stored.crt.colorMode === 'color'}
              data-testid="control-backgroundDesaturation"
              onChange={(event) => updateCrt('backgroundDesaturation', Number(event.target.value))}
            />
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
              checked={stored.crt.antiAliasedPixels}
              onChange={(event) => setStored((current) => ({ ...current, crt: { ...current.crt, antiAliasedPixels: event.target.checked } }))}
            />
            Anti-moiré pixels
          </label>
        </fieldset>
        <button type="button" className="reset-button" onClick={reset}>Reset defaults</button>
        <footer>v0.2 · ConPTY · ANSI screen buffer</footer>
      </aside>
    </main>
  );
}
