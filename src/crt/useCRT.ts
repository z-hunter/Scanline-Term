/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CRTSettings } from 'scanline-virtual-screen/core';
import type { Resolution, TerminalRenderer } from '../terminal/ScanlineTerminalRenderer';
import { VirtualScreenRenderer } from 'scanline-virtual-screen/core';
import type { BrowserVideoFrame } from './browser-benchmark';

type VideoRenderer = {
  renderVideo?: (video: HTMLVideoElement, settings: CRTSettings, width: number, height: number, changed: boolean) => void;
};

export function useCRT({ settingsRef, resolution, renderer, onError, onBrowserVideoError, onResizeSource, onFrame, enabled = true, browserVideo }: { settingsRef: { current: CRTSettings }; resolution: Resolution; renderer: TerminalRenderer; onError: (message: string) => void; onBrowserVideoError?: (message: string) => void; onResizeSource: (output: HTMLCanvasElement, reason?: string) => void; onFrame?: (output: HTMLCanvasElement, now: number, changed: boolean) => void; enabled?: boolean; browserVideo?: { current: BrowserVideoFrame | null } }) {
  const outputRef = useRef<HTMLCanvasElement>(null); const screenRef = useRef<VirtualScreenRenderer | null>(null); const [fps, setFps] = useState(0);
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const browserVideoRef = useRef(browserVideo); browserVideoRef.current = browserVideo;
  useEffect(() => { 
    const output = outputRef.current; if (!output) return; 
    let screen: VirtualScreenRenderer | null = new VirtualScreenRenderer(output);
    screenRef.current = screen;
    renderer.setRasterScale(screen.rasterScale);

    let raf = 0; let reported = false; let renderFailed = false; let breathingPrimed = false; let count = 0; let started = performance.now();
    let previousVideo: BrowserVideoFrame | null = null;
    
    let initialResize = true;
    const onContextLost = (event: Event) => { event.preventDefault(); renderFailed = true; screen?.dispose(); screen = null; screenRef.current = null; renderer.setRasterScale(1); };
    const onContextRestored = () => {
      try {
        const restored = new VirtualScreenRenderer(output);
        screen = restored;
        screenRef.current = restored;
        renderer.setRasterScale(restored.rasterScale);
        renderFailed = false;
        reported = false;
        breathingPrimed = false;
        previousVideo = null;
        renderer.markDirty();
      } catch (reason) {
        renderFailed = true;
        onError(`Screen renderer restore failed: ${String(reason)}`);
      }
    };
    output.addEventListener('webglcontextlost', onContextLost);
    output.addEventListener('webglcontextrestored', onContextRestored);
    const resize = () => { 
      const rect = output.getBoundingClientRect(); 
      const dpr = window.devicePixelRatio || 1; 
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (output.width !== width) output.width = width;
      if (output.height !== height) output.height = height;
      onResizeSource(output, initialResize ? 'crt-initial' : 'output-resize-observer');
      previousVideo = null;
      initialResize = false;
      renderer.markDirty(); 
      screen?.clearPersistence();
    }; 
    let dprQuery: MediaQueryList | null = null;
    const watchDpr = () => {
      if (!window.matchMedia) return;
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener('change', onDprChange, { once: true });
    };
    const onDprChange = () => { resize(); watchDpr(); };
    const observer = new ResizeObserver(resize); observer.observe(output); resize(); 
    window.addEventListener('resize', resize);
    watchDpr();
    
    const render = (now: number) => {
      try {
        if (enabledRef.current) {
          const video = browserVideoRef.current?.current ?? null;
          const changed = video ? video !== previousVideo : renderer.draw(now / 1000, settingsRef.current);
          const activeScreen = screen;
          if (activeScreen && !renderFailed) {
            const wasScrollAnimating = renderer.isScrollAnimating;
            if (!activeScreen.isValid() && settingsRef.current.crtEmulation && !reported) { reported = true; onError('WebGL is unavailable in this WebView.'); }
            if (!breathingPrimed && renderer.hasMeasuredLuma) { activeScreen.restartBreathing(); breathingPrimed = true; }
            let rendered = false;
            if (changed || wasScrollAnimating || renderer.isScrollAnimating || activeScreen.isChannelSwitchAnimating() || settingsRef.current.crtEmulation) {
              try {
                if (video) {
                  const experimentalScreen = activeScreen as VirtualScreenRenderer & VideoRenderer;
                  if (experimentalScreen.renderVideo && activeScreen.isValid()) {
                    const { width, height } = renderer.compositedCanvas;
                    experimentalScreen.renderVideo(video.video, settingsRef.current, width, height, changed);
                  } else if (video.requireDirect) throw new Error('SVS direct WebGL video input is unavailable');
                  else {
                    renderer.setBrowserPreview(video.video);
                    activeScreen.render(renderer.compositedCanvas, settingsRef.current, renderer.getOverlays(), changed);
                  }
                } else {
                  activeScreen.render(renderer.compositedCanvas, settingsRef.current, renderer.getOverlays(), changed);
                }
                previousVideo = video;
                renderer.setRasterScale(activeScreen.rasterScale);
                rendered = true;
              } catch (reason) {
                if (video && !video.requireDirect) {
                  previousVideo = video;
                  (onBrowserVideoError ?? onError)(`Screen render failed: ${String(reason)}`);
                } else { renderFailed = true; onError(`Screen render failed: ${String(reason)}`); }
              }
            }
            if (rendered) onFrame?.(output, now, changed);
          }
          count += 1;
        }
        if (now - started >= 500) {
          setFps(Math.round(count * 1000 / (now - started)));
          count = 0; started = now;
        }
      } catch (reason) {
        if (!renderFailed) { renderFailed = true; onError(`Screen frame failed: ${String(reason)}`); }
      } finally {
        raf = requestAnimationFrame(render);
      }
    };
    
    raf = requestAnimationFrame(render); 
    return () => { 
      cancelAnimationFrame(raf); 
      observer.disconnect(); 
      window.removeEventListener('resize', resize);
      output.removeEventListener('webglcontextlost', onContextLost);
      output.removeEventListener('webglcontextrestored', onContextRestored);
      dprQuery?.removeEventListener('change', onDprChange);
      screen?.dispose();
      screenRef.current = null;
      renderer.setRasterScale(1);
    }; 
  }, [onError, onBrowserVideoError, onFrame, onResizeSource, renderer, settingsRef]);
  useEffect(() => { screenRef.current?.clearPersistence(); }, [resolution]);
  const captureFrame = useCallback((maxWidth = 720): HTMLCanvasElement | null => {
    const output = outputRef.current;
    const screen = screenRef.current;
    if (!output || !screen || output.width < 1 || output.height < 1) return null;
    const changed = renderer.draw(performance.now() / 1000, settingsRef.current);
    try {
      screen.render(renderer.compositedCanvas, settingsRef.current, renderer.getOverlays(), changed);
      renderer.setRasterScale(screen.rasterScale);
    } catch (reason) {
      onError(`Could not capture CRT frame: ${String(reason)}`);
      return null;
    }
    const scale = Math.min(1, maxWidth / output.width);
    const snapshot = document.createElement('canvas');
    snapshot.width = Math.max(1, Math.round(output.width * scale));
    snapshot.height = Math.max(1, Math.round(output.height * scale));
    const context = snapshot.getContext('2d');
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.drawImage(output, 0, 0, snapshot.width, snapshot.height);
    return snapshot;
  }, [onError, renderer, settingsRef]);
  const clearPersistence = useCallback(() => screenRef.current?.clearPersistence(), []);
  const startChannelSwitch = useCallback(() => screenRef.current?.startChannelSwitch(), []);
  const joinChannelSwitch = useCallback(() => screenRef.current?.joinChannelSwitch(), []);
  return { outputRef, fps, captureFrame, clearPersistence, startChannelSwitch, joinChannelSwitch };
}
