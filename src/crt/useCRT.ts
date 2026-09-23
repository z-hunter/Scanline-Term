/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CRTSettings } from './CRTFilter';
import type { Resolution, TerminalRenderer } from '../terminal/ScanlineTerminalRenderer';
import { VirtualScreenRenderer } from 'scanline-virtual-screen/core';

export function useCRT({ settings, resolution, renderer, onError, onResizeSource, enabled = true }: { settings: CRTSettings; resolution: Resolution; renderer: TerminalRenderer; onError: (message: string) => void; onResizeSource: (output: HTMLCanvasElement) => void; enabled?: boolean }) {
  const outputRef = useRef<HTMLCanvasElement>(null); const screenRef = useRef<VirtualScreenRenderer | null>(null); const settingsRef = useRef(settings); const [fps, setFps] = useState(0);
  settingsRef.current = settings;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  useEffect(() => { 
    const output = outputRef.current; if (!output) return; 
    const screen = new VirtualScreenRenderer(output, settings.crtEmulation);
    screenRef.current = screen;

    let raf = 0; let reported = false; let renderFailed = false; let breathingPrimed = false; let count = 0; let started = performance.now();
    
    const resize = () => { 
      const rect = output.getBoundingClientRect(); 
      const dpr = window.devicePixelRatio || 1; 
      output.width = Math.max(1, Math.round(rect.width * dpr)); 
      output.height = Math.max(1, Math.round(rect.height * dpr)); 
      onResizeSource(output); 
      renderer.markDirty(); 
      screen.clearPersistence();
    }; 
    const observer = new ResizeObserver(resize); observer.observe(output); resize(); 
    
    const render = (now: number) => { 
      if (enabledRef.current) { 
        const wasScrollAnimating = renderer.isScrollAnimating;
        const changed = renderer.draw(now / 1000, settingsRef.current); 
        if (!screen.isValid() && !reported) { reported = true; onError('WebGL is unavailable in this WebView.'); }
        if (!breathingPrimed && renderer.hasMeasuredLuma) { screen.restartBreathing(); breathingPrimed = true; }
        if (!renderFailed && (changed || wasScrollAnimating || renderer.isScrollAnimating || settingsRef.current.crtEmulation)) {
          try { screen.render(renderer.compositedCanvas, settingsRef.current, renderer.getOverlays(), changed); } catch (reason) { renderFailed = true; onError(`Screen render failed: ${String(reason)}`); }
        }
        count += 1; 
      } 
      if (now - started >= 500) { 
        setFps(Math.round(count * 1000 / (now - started))); 
        count = 0; started = now; 
      } 
      raf = requestAnimationFrame(render); 
    }; 
    
    raf = requestAnimationFrame(render); 
    return () => { 
      cancelAnimationFrame(raf); 
      observer.disconnect(); 
      screen.dispose();
      screenRef.current = null;
    }; 
  }, [onError, onResizeSource, renderer, settings.crtEmulation]);
  useEffect(() => { screenRef.current?.clearPersistence(); }, [resolution]);
  const clearPersistence = useCallback(() => screenRef.current?.clearPersistence(), []);
  const startChannelSwitch = useCallback(() => screenRef.current?.startChannelSwitch(), []);
  return { outputRef, fps, clearPersistence, startChannelSwitch };
}
