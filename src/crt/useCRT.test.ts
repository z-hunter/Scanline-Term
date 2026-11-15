import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRT_SETTINGS } from './settings';
import { useCRT } from './useCRT';

const mocked = vi.hoisted(() => ({ render: vi.fn(), constructed: 0, disposed: 0 }));
vi.mock('scanline-virtual-screen/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('scanline-virtual-screen/core')>(),
  VirtualScreenRenderer: class {
    constructor() { mocked.constructed += 1; }
    clearPersistence() {}
    dispose() { mocked.disposed += 1; }
    isValid() { return true; }
    isChannelSwitchAnimating() { return false; }
    render = mocked.render;
  },
}));

describe('useCRT settings ref', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); mocked.render.mockReset(); mocked.constructed = 0; mocked.disposed = 0; });

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
        renderer: { draw, compositedCanvas: document.createElement('canvas'), isScrollAnimating: false, hasMeasuredLuma: false, markDirty: vi.fn(), getOverlays: vi.fn(() => []) } as never,
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
    await act(async () => { output.dispatchEvent(lost); frames[0](16); });
    expect(lost.defaultPrevented).toBe(true);
    expect(mocked.render).not.toHaveBeenCalled();

    await act(async () => { output.dispatchEvent(new Event('webglcontextrestored')); frames[1](32); });
    expect(mocked.constructed).toBe(2);
    expect(mocked.disposed).toBe(1);
    expect(mocked.render).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
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
        renderer: { draw: vi.fn(() => false), compositedCanvas: document.createElement('canvas'), isScrollAnimating: false, hasMeasuredLuma: false, markDirty: vi.fn(), getOverlays: vi.fn(() => []) } as never,
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
