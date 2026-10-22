import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRT_SETTINGS } from './settings';
import { useCRT } from './useCRT';

const mocked = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('scanline-virtual-screen/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('scanline-virtual-screen/core')>(),
  VirtualScreenRenderer: class {
    clearPersistence() {}
    dispose() {}
    isValid() { return true; }
    isChannelSwitchAnimating() { return false; }
    render = mocked.render;
  },
}));

describe('useCRT settings ref', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); mocked.render.mockReset(); });

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
});
