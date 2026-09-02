/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { DEFAULT_CRT_SETTINGS, DEFAULT_RESOLUTION, loadStoredSettings, RESOLUTIONS } from './crt/settings';
import { useCRT } from './crt/useCRT';
import { useTerminal } from './terminal/useTerminal';
import { SettingsPanel } from './ui/SettingsPanel';
import './styles.css';

const STORAGE_KEY = 'scanline-term.settings.v1';

export default function App() {
  const [stored, setStored] = useState(() => loadStoredSettings(localStorage.getItem(STORAGE_KEY)));
  const [error, setError] = useState<string | null>(null); const [settingsVisible, setSettingsVisible] = useState(true);
  const reportError = useCallback((message: string) => setError(message), []); const toggleSettings = useCallback(() => setSettingsVisible((visible) => !visible), []);
  const resolution = RESOLUTIONS.find((item) => item.id === stored.resolution) ?? RESOLUTIONS[1];
  const physicalWindow = resolution.id === 'physical';
  const screenStyle = physicalWindow ? undefined : { '--screen-ratio': String(resolution.width! / resolution.height!) } as CSSProperties;
  const terminal = useTerminal({ settings: stored.crt, resolution, onError: reportError, onToggleSettings: toggleSettings });
  const crt = useCRT({ settings: stored.crt, resolution, renderer: terminal.renderer, live: terminal.live, onError: reportError, onResizeSource: terminal.resizeSource });
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)); }, [stored]);
  const reset = () => { localStorage.removeItem(STORAGE_KEY); setStored({ version: 1, resolution: DEFAULT_RESOLUTION, crt: { ...DEFAULT_CRT_SETTINGS } }); crt.clearPersistence(); };
  return <main className={`app-shell${settingsVisible ? '' : ' settings-hidden'}`}><section className="display-panel" aria-label="CRT display"><div className={`screen-frame${physicalWindow ? ' physical-window' : ''}${stored.crt.showBezel ? '' : ' bezel-hidden'}`} style={screenStyle}><canvas ref={crt.outputRef} className="output-canvas" data-testid="output-canvas" tabIndex={terminal.live ? 0 : -1} aria-label={terminal.live ? 'Windows console' : 'CRT display'} {...terminal.canvasProps} /><span className="frame-status">{terminal.size.cols} × {terminal.size.rows}</span></div>{error && <p className="error" role="alert">{error}</p>}</section>{settingsVisible && <SettingsPanel stored={stored} setStored={setStored} monospaceFonts={terminal.fonts} terminalSize={terminal.size} fps={crt.fps} renderStats={crt.renderStats} onReset={reset} />}</main>;
}
