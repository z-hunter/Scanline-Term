/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CRTFilter, type CRTSettings } from './CRTFilter';
import type { RenderStats, Resolution, TerminalRenderer } from '../terminal/TerminalRenderer';

const TELEMETRY_ENABLED = false;

export function useCRT({ settings, resolution, renderer, onError, onResizeSource }: { settings: CRTSettings; resolution: Resolution; renderer: TerminalRenderer; onError: (message: string) => void; onResizeSource: (output: HTMLCanvasElement) => void }) {
  const outputRef = useRef<HTMLCanvasElement>(null); const filterRef = useRef<CRTFilter | null>(null); const settingsRef = useRef(settings); const [fps, setFps] = useState(0); const [renderStats, setRenderStats] = useState<RenderStats>({ redraws: 0, canvasMs: 0, glyphs: 0 });
  settingsRef.current = settings;
  useEffect(() => { const output = outputRef.current; if (!output) return; const filter = new CRTFilter(output); filterRef.current = filter; let raf = 0; let reported = false; let count = 0; let started = performance.now(); const resize = () => { const rect = output.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; output.width = Math.max(1, Math.round(rect.width * dpr)); output.height = Math.max(1, Math.round(rect.height * dpr)); onResizeSource(output); renderer.markDirty(); filter.clearPersistence(); }; const observer = new ResizeObserver(resize); observer.observe(output); resize(); const render = (now: number) => { const changed = renderer.draw(now / 1000, settingsRef.current); if (!filter.isValid() && !reported) { reported = true; onError('WebGL is unavailable in this WebView.'); } if (filter.isValid()) filter.render(renderer.sourceCanvas, settingsRef.current, changed); count += 1; if (now - started >= 500) { setFps(Math.round(count * 1000 / (now - started))); if (TELEMETRY_ENABLED) setRenderStats(renderer.consumeStats()); count = 0; started = now; } raf = requestAnimationFrame(render); }; raf = requestAnimationFrame(render); return () => { cancelAnimationFrame(raf); observer.disconnect(); filter.dispose(); filterRef.current = null; }; }, [onError, onResizeSource, renderer]);
  useEffect(() => { filterRef.current?.clearPersistence(); }, [resolution]);
  const clearPersistence = useCallback(() => filterRef.current?.clearPersistence(), []);
  return { outputRef, fps, renderStats, clearPersistence };
}
