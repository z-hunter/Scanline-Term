import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRT_SETTINGS } from './settings';
import { useCRT } from './useCRT';

const mocked = vi.hoisted(() => ({ render: vi.fn(), constructed: 0, disposed: 0, callsAfterDispose: 0, failValidity: false, setRasterScale: vi.fn() }));
vi.mock('scanline-virtual-screen/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('scanline-virtual-screen/core')>(),
  VirtualScreenRenderer: class {
    private disposed = false;
    constructor() { mocked.constructed += 1; }
    clearPersistence() { if (this.disposed) mocked.callsAfterDispose += 1; }
    dispose() { mocked.disposed += 1; this.disposed = true; }
    isValid() { if (this.disposed) mocked.callsAfterDispose += 1; if (mocked.failValidity) throw new Error('validity check failed'); return true; }
    restartBreathing() { if (this.disposed) mocked.callsAfterDispose += 1; }
    get rasterScale() { return 1.25; }
    isChannelSwitchAnimating() { if (this.disposed) mocked.callsAfterDispose += 1; return false; }
    render = mocked.render;
  },
}));

describe('useCRT settings ref', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); mocked.render.mockReset(); mocked.setRasterScale.mockReset(); mocked.constructed = 0; mocked.disposed = 0; mocked.callsAfterDispose = 0; mocked.failValidity = false; });

  it('draws with synchronously switched settings on the next frame without a React rerender', async () => {
    const targetSettings = { ...DEFAULT_CRT_SETTINGS, colorProfile: 'commodore-64' as const, consoleFontSize: 22 };
    const settingsRef = { current: { ...DEFAULT_CRT_SETTINGS } };
    const calls: string[] = [];
    mocked.render.mockImplementationOnce(() => { calls.push('render'); });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const draw = vi.fn(() => true);
    const renderer = {
      draw,
      compositedCanvas: document.createElement('canvas'),
      isScrollAnimating: false,
      hasMeasuredLuma: false,
      markDirty: vi.fn(),
      getOverlays: vi.fn(() => []),
      setRasterScale: mocked.setRasterScale,
    } as never;
    const onFrame = vi.fn(() => { calls.push('frame'); });
    function TestComponent() {
      const result = useCRT({ settingsRef, resolution: { id: '1024x768', width: 1024, height: 768 }, renderer, onError: vi.fn(), onResizeSource: vi.fn(), onFrame });
      return createElement('canvas', { ref: result.outputRef });
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });

    settingsRef.current = targetSettings;
    await act(async () => { frames[0](16); });

    expect(draw).toHaveBeenCalledWith(0.016, targetSettings);
    expect(onFrame).toHaveBeenCalledWith(container.querySelector('canvas'), 16, true);
    expect(mocked.setRasterScale).toHaveBeenCalledWith(1.25);
    expect(calls).toEqual(['render', 'frame']);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('calls onFrame only after screen.render succeeds', async () => {
    const settingsRef = { current: { ...DEFAULT_CRT_SETTINGS, crtEmulation: false } };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const renderError = new Error('render failed');
    mocked.render.mockImplementationOnce(() => { throw renderError; });
    const onError = vi.fn();
    const draw = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const onFrame = vi.fn();
    function TestComponent() {
      const result = useCRT({
        settingsRef,
        resolution: { id: '1024x768', width: 1024, height: 768 },
        renderer: {
          draw,
          compositedCanvas: document.createElement('canvas'),
          isScrollAnimating: false,
          hasMeasuredLuma: false,
          markDirty: vi.fn(),
          getOverlays: vi.fn(() => []),
          setRasterScale: mocked.setRasterScale,
        } as never,
        onError,
        onResizeSource: vi.fn(),
        onFrame,
      });
      return createElement('canvas', { ref: result.outputRef });
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });

    await act(async () => { frames[0](16); });
    expect(mocked.render).not.toHaveBeenCalled();
    expect(onFrame).not.toHaveBeenCalled();

    await act(async () => { frames[1](32); });
    expect(onError).toHaveBeenCalledWith(`Screen render failed: ${String(renderError)}`);
    expect(onFrame).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('uses the normal overlay renderer for TextureStream video when SVS has no direct video method', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const video = document.createElement('video');
    const browserVideo = { current: { video, timestamp: 1 } };
    const setBrowserPreview = vi.fn();
    const overlays = [{ id: 'browser-preview' }];
    const getOverlays = vi.fn(() => overlays as never);
    const canvas = document.createElement('canvas');
    function TestComponent() {
      const result = useCRT({
        settingsRef: { current: { ...DEFAULT_CRT_SETTINGS } },
        resolution: { id: '1024x768', width: 1024, height: 768 },
        renderer: { draw: vi.fn(), compositedCanvas: canvas, isScrollAnimating: false, hasMeasuredLuma: false, markDirty: vi.fn(), getOverlays, setBrowserPreview, setRasterScale: mocked.setRasterScale } as never,
        onError: vi.fn(), onResizeSource: vi.fn(), browserVideo,
      });
      return createElement('canvas', { ref: result.outputRef });
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    await act(async () => { frames[0](16); });
    expect(setBrowserPreview).toHaveBeenCalledWith(video);
    expect(mocked.render).toHaveBeenCalledWith(canvas, expect.any(Object), overlays, true);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('recreates the screen renderer after WebGL restores its context', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const draw = vi.fn(() => true);
    const onError = vi.fn();
    function TestComponent() {
      const result = useCRT({
        settingsRef: { current: { ...DEFAULT_CRT_SETTINGS } },
        resolution: { id: '1024x768', width: 1024, height: 768 },
        renderer: { draw, compositedCanvas: document.createElement('canvas'), isScrollAnimating: false, hasMeasuredLuma: true, markDirty: vi.fn(), getOverlays: vi.fn(() => []), setRasterScale: mocked.setRasterScale } as never,
        onError,
        onResizeSource: vi.fn(),
      });
      return createElement('canvas', { ref: result.outputRef });
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    const output = container.querySelector('canvas')!;
    expect(mocked.constructed).toBe(1);

    const lost = new Event('webglcontextlost', { cancelable: true });
    await act(async () => { output.dispatchEvent(lost); window.dispatchEvent(new Event('resize')); frames[0](16); });
    expect(lost.defaultPrevented).toBe(true);
    expect(mocked.callsAfterDispose).toBe(0);
    expect(mocked.render).not.toHaveBeenCalled();

    mocked.failValidity = true;
    await act(async () => { output.dispatchEvent(new Event('webglcontextrestored')); frames[1](32); });
    expect(mocked.constructed).toBe(2);
    expect(mocked.disposed).toBe(1);
    expect(mocked.render).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Screen frame failed: Error: validity check failed');
    await act(async () => { frames[2](48); });
    expect(frames).toHaveLength(4);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('resizes the source when the window moves to a different DPI monitor', async () => {
    const oldDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    let onDprChange!: EventListener;
    const matchMedia = vi.fn(() => ({
      addEventListener: (_type: string, listener: EventListener) => { onDprChange = listener; },
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
    vi.stubGlobal('matchMedia', matchMedia);
    const onResizeSource = vi.fn();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    function TestComponent() {
      const result = useCRT({
        settingsRef: { current: { ...DEFAULT_CRT_SETTINGS } },
        resolution: { id: 'physical' } as never,
        renderer: { draw: vi.fn(() => false), compositedCanvas: document.createElement('canvas'), isScrollAnimating: false, hasMeasuredLuma: false, markDirty: vi.fn(), getOverlays: vi.fn(() => []), setRasterScale: mocked.setRasterScale } as never,
        onError: vi.fn(), onResizeSource,
      });
      return createElement('canvas', { ref: result.outputRef });
    }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(TestComponent)); });
    expect(onResizeSource).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.5 });
    await act(async () => { onDprChange(new Event('change')); });
    expect(onResizeSource).toHaveBeenCalledTimes(2);
    expect(matchMedia).toHaveBeenLastCalledWith('(resolution: 1.5dppx)');

    await act(async () => { root.unmount(); });
    container.remove();
    if (oldDpr) Object.defineProperty(window, 'devicePixelRatio', oldDpr);
    else Reflect.deleteProperty(window, 'devicePixelRatio');
  });
});
