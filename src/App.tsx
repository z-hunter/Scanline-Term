import { useEffect, useRef, useState } from 'react';
import { CRTFilter, type CRTSettings } from './crt/CRTFilter';
import {
  DEFAULT_CRT_SETTINGS,
  DEFAULT_RESOLUTION,
  loadStoredSettings,
  RESOLUTIONS,
  type ResolutionId,
} from './crt/settings';
import './styles.css';

const STORAGE_KEY = 'scanline-term.settings.v1';

type NumericKey = Exclude<keyof CRTSettings, 'bezelGlow' | 'antiAliasedPixels'>;
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
  Temporal: [
    { key: 'persistence', label: 'Phosphor trail', min: 0, max: 1, step: 0.05 },
    { key: 'breathing', label: 'HV breathing', min: 0, max: 1, step: 0.05 },
  ],
};

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
    '> this is a mock session; ConPTY comes later',
    '',
    '  0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F',
    '  -- amber phosphor / green phosphor / glass glow --',
    '',
    `  frame ${Math.floor(time * 10) % 10000}  uptime ${(time % 3600).toFixed(1)}s`,
  ];
  lines.forEach((line, index) => {
    ctx.fillStyle = index % 3 === 0 ? '#9affbd' : '#62db91';
    ctx.fillText(line, fontSize, fontSize + lineHeight * (index + 3));
  });
  if (Math.floor(time * 2) % 2 === 0) {
    const cursorY = fontSize + lineHeight * (lines.length + 4);
    ctx.fillStyle = '#b7ffd0';
    ctx.fillRect(fontSize, cursorY, Math.max(6, Math.floor(fontSize * 0.65)), lineHeight - 2);
  }
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export default function App() {
  const [stored, setStored] = useState(() => loadStoredSettings(localStorage.getItem(STORAGE_KEY)));
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const filterRef = useRef<CRTFilter | null>(null);
  const settingsRef = useRef(stored.crt);

  const resolution = RESOLUTIONS.find((item) => item.id === stored.resolution) ?? RESOLUTIONS[1];

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
    };
    const observer = new ResizeObserver(resize);
    observer.observe(output);
    resize();

    const render = (now: number) => {
      drawMockTerminal(source, now / 1000);
      if (!filter.isValid() && !errorReported) {
        errorReported = true;
        setError('WebGL is unavailable in this WebView.');
      }
      if (filter.isValid()) filter.render(source, settingsRef.current);
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

  return (
    <main className="app-shell">
      <section className="display-panel" aria-label="CRT display">
        <div className="screen-frame">
          <canvas ref={outputRef} className="output-canvas" data-testid="output-canvas" />
        </div>
        <p className="display-status">MOCK SESSION · {resolution.width}×{resolution.height}</p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <aside className="settings-panel">
        <header>
          <p className="eyebrow">SCANLINE TERM</p>
          <h1>CRT display lab</h1>
          <p className="subtitle">A reusable Quest CRT shader in a tiny Tauri shell.</p>
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
          <legend>Display</legend>
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
        <footer>v0.1 · mock terminal · no ConPTY yet</footer>
      </aside>
    </main>
  );
}
