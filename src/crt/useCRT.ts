/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CRTFilter, type CRTSettings } from './CRTFilter';
import type { RenderStats, Resolution, TerminalRenderer } from '../terminal/TerminalRenderer';

const TELEMETRY_ENABLED = false;

export function useCRT({ settings, resolution, renderer, onError, onResizeSource, enabled = true }: { settings: CRTSettings; resolution: Resolution; renderer: TerminalRenderer; onError: (message: string) => void; onResizeSource: (output: HTMLCanvasElement) => void; enabled?: boolean }) {
  const outputRef = useRef<HTMLCanvasElement>(null); const filterRef = useRef<CRTFilter | null>(null); const settingsRef = useRef(settings); const [fps, setFps] = useState(0); const [renderStats, setRenderStats] = useState<RenderStats>({ redraws: 0, canvasMs: 0, glyphs: 0 });
  settingsRef.current = settings;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  useEffect(() => { 
    const output = outputRef.current; if (!output) return; 
    let filter: CRTFilter | null = null;
    let ctx2d: CanvasRenderingContext2D | null = null;
    
    if (settings.crtEmulation) {
      filter = new CRTFilter(output); 
      filterRef.current = filter;
    } else {
      ctx2d = output.getContext('2d', { alpha: false });
    }

    let raf = 0; let reported = false; let breathingPrimed = false; let count = 0; let started = performance.now();
    
    const resize = () => { 
      const rect = output.getBoundingClientRect(); 
      const dpr = window.devicePixelRatio || 1; 
      output.width = Math.max(1, Math.round(rect.width * dpr)); 
      output.height = Math.max(1, Math.round(rect.height * dpr)); 
      onResizeSource(output); 
      renderer.markDirty(); 
      if (filter) filter.clearPersistence(); 
    }; 
    const observer = new ResizeObserver(resize); observer.observe(output); resize(); 
    
    const render = (now: number) => { 
      if (enabledRef.current) { 
        const changed = renderer.draw(now / 1000, settingsRef.current); 
        if (filter) {
          if (!filter.isValid() && !reported) { reported = true; onError('WebGL is unavailable in this WebView.'); } 
          if (!breathingPrimed && renderer.hasMeasuredLuma) { filter.restartBreathing(); breathingPrimed = true; }
          if (filter.isValid()) filter.render(renderer.sourceCanvas, settingsRef.current, changed, renderer.averageLuma);
        } else if (ctx2d) {
          if (changed) {
            ctx2d.imageSmoothingEnabled = settingsRef.current.antiAliasedPixels !== false;
            ctx2d.drawImage(renderer.sourceCanvas, 0, 0, output.width, output.height);
          }
        }
        count += 1; 
      } 
      if (now - started >= 500) { 
        setFps(Math.round(count * 1000 / (now - started))); 
        if (TELEMETRY_ENABLED) setRenderStats(renderer.consumeStats()); 
        count = 0; started = now; 
      } 
      raf = requestAnimationFrame(render); 
    }; 
    
    raf = requestAnimationFrame(render); 
    return () => { 
      cancelAnimationFrame(raf); 
      observer.disconnect(); 
      if (filter) filter.dispose(); 
      filterRef.current = null; 
    }; 
  }, [onError, onResizeSource, renderer, settings.crtEmulation]);
  useEffect(() => { filterRef.current?.clearPersistence(); }, [resolution]);
  const clearPersistence = useCallback(() => filterRef.current?.clearPersistence(), []);
  const startChannelSwitch = useCallback(() => filterRef.current?.startChannelSwitch(), []);
  return { outputRef, fps, renderStats, clearPersistence, startChannelSwitch };
}
