import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { DEFAULT_CRT_SETTINGS, DEFAULT_RESOLUTION, loadStoredSettings, RESOLUTIONS } from './crt/settings';
import { useCRT } from './crt/useCRT';
import { useTerminal } from './terminal/useTerminal';
import { SettingsPanel } from './ui/SettingsPanel';
import { TerminalTabs } from './ui/TerminalTabs';
import './styles.css';

const STORAGE_KEY = 'scanline-term.settings.v1';

export default function App() {
  const [stored, setStored] = useState(() => loadStoredSettings(localStorage.getItem(STORAGE_KEY)));
  const workspaceRef = useRef<HTMLDivElement>(null); const tabsRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null); const [settingsVisible, setSettingsVisible] = useState(true);
  const reportError = useCallback((message: string) => setError(message), []); const toggleSettings = useCallback(() => setSettingsVisible((visible) => !visible), []);
  const resolution = RESOLUTIONS.find((item) => item.id === stored.resolution) ?? RESOLUTIONS[1];
  const physicalWindow = resolution.id === 'physical';
  const screenStyle = physicalWindow ? undefined : { '--screen-ratio': String(resolution.width! / resolution.height!) } as CSSProperties;
  const terminal = useTerminal({ settings: stored.crt, resolution, onError: reportError, onToggleSettings: toggleSettings });
  const crt = useCRT({ settings: stored.crt, resolution, renderer: terminal.renderer, onError: reportError, onResizeSource: terminal.resizeSource });
  const { clearPersistence, outputRef, fps, renderStats } = crt;
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)); }, [stored]);
  useEffect(() => { if (!terminal.activeSessionId) return; clearPersistence(); window.requestAnimationFrame(() => outputRef.current?.focus()); }, [terminal.activeSessionId, clearPersistence, outputRef]);
  useEffect(() => { const workspace = workspaceRef.current; const tabs = tabsRef.current; if (!workspace || !tabs || stored.tabPlacement !== 'left') return; const resize = () => workspace.style.setProperty('--tab-space', `${Math.ceil(tabs.getBoundingClientRect().width) + 8}px`); const observer = new ResizeObserver(resize); observer.observe(tabs); resize(); return () => observer.disconnect(); }, [stored.tabPlacement, terminal.tabs.length]);
  const reset = () => { localStorage.removeItem(STORAGE_KEY); setStored({ version: 1, resolution: DEFAULT_RESOLUTION, tabPlacement: 'top', hideTabsWhenSingleSession: false, settingsScale: 1, crt: { ...DEFAULT_CRT_SETTINGS } }); clearPersistence(); };
  return <main style={{ '--settings-scale': String(stored.settingsScale) } as CSSProperties} className={`app-shell${settingsVisible ? '' : ' settings-hidden'}`}><section className="display-panel" aria-label="CRT display"><div ref={workspaceRef} style={{ '--tab-space': '36px' } as CSSProperties} className={`terminal-workspace terminal-workspace-${stored.tabPlacement}`}>{isTauri() && (!stored.hideTabsWhenSingleSession || terminal.tabs.length > 1) && <TerminalTabs panelRef={tabsRef} tabs={terminal.tabs} activeId={terminal.activeSessionId} placement={stored.tabPlacement} onSelect={terminal.selectSession} onClose={terminal.closeSession} onNew={() => terminal.openSession()} onToggleSettings={toggleSettings} />}<div id="terminal-display" className={`screen-frame${physicalWindow ? ' physical-window' : ''}${stored.crt.showBezel ? '' : ' bezel-hidden'}`} style={screenStyle}><canvas ref={outputRef} className="output-canvas" data-testid="output-canvas" tabIndex={terminal.live ? 0 : -1} aria-label={terminal.live ? 'Windows console' : 'CRT display'} {...terminal.canvasProps} /><span className="frame-status">{terminal.size.cols} × {terminal.size.rows}</span></div></div>{error && <p className="error" role="alert">{error}</p>}</section>{settingsVisible && <SettingsPanel stored={stored} setStored={setStored} monospaceFonts={terminal.fonts} terminalSize={terminal.size} fps={fps} renderStats={renderStats} onReset={reset} />}</main>;
}
