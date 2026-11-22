import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { BrowserBenchmark, BrowserTextureStreamReceiver } from './browser-benchmark';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

it('counts only the latest pending browser frame at each SVS submission', () => {
  const benchmark = new BrowserBenchmark('test', 'texture');
  const output = document.createElement('canvas');
  const source = document.createElement('canvas');
  benchmark.frame(320, 240);
  benchmark.frame(1280, 720, performance.timeOrigin + performance.now() - 20);
  benchmark.submitted(output, source);
  benchmark.submitted(output, source);
  expect(benchmark.read()).toMatchObject({
    distinctFrames: 1, submittedFrames: 2, sourceWidth: 1280, sourceHeight: 720,
    latencySamplesMs: [expect.any(Number)],
  });
  expect(benchmark.read().latencySamplesMs).toEqual([]);
});

it('stops a native stream that starts after the receiver was stopped', async () => {
  let resolveStart!: (value: { streamId: string }) => void;
  vi.mocked(invoke).mockImplementation((command) => command === 'start_browser_texture_stream'
    ? new Promise(resolve => { resolveStart = resolve; }) as never
    : Promise.resolve(null) as never);
  const getTextureStream = vi.fn();
  Object.defineProperty(window, 'chrome', { configurable: true, value: { webview: { getTextureStream } } });
  const receiver = new BrowserTextureStreamReceiver();
  const starting = receiver.start({ sessionId: 'tab', width: 640, height: 480 });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('start_browser_texture_stream', expect.objectContaining({ sessionId: 'tab' })));
  await receiver.stop();
  resolveStart({ streamId: 'late-stream' });
  await starting;
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('stop_browser_texture_stream', { streamId: 'late-stream' }));
  expect(getTextureStream).not.toHaveBeenCalled();
  delete (window as Window & { chrome?: unknown }).chrome;
  vi.mocked(invoke).mockReset();
});

it('times out when acquiring the MediaStream hangs', async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(window, 'chrome');
  vi.useFakeTimers();
  vi.mocked(invoke).mockResolvedValue({ streamId: 'pending-media-stream' } as never);
  Object.defineProperty(window, 'chrome', { configurable: true, value: { webview: { getTextureStream: () => new Promise<MediaStream>(() => {}) } } });
  const onError = vi.fn();
  const receiver = new BrowserTextureStreamReceiver(onError);
  try {
    const starting = receiver.start({ sessionId: 'tab', width: 640, height: 480 });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const startArgs = vi.mocked(invoke).mock.calls[0][1] as { streamId: string };
    await vi.advanceTimersByTimeAsync(10_000);
    await starting;
    expect(onError).toHaveBeenCalledWith('Error: TextureStream startup timed out', { sessionId: 'tab', width: 640, height: 480 });
    expect(invoke).toHaveBeenCalledWith('stop_browser_texture_stream', { streamId: startArgs.streamId });
  } finally {
    await receiver.stop();
    vi.useRealTimers();
    if (previousChrome) Object.defineProperty(window, 'chrome', previousChrome);
    else delete (window as Window & { chrome?: unknown }).chrome;
    vi.mocked(invoke).mockReset();
  }
});

it('associates receiver errors with the browser tab that owns the stream', async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(window, 'chrome');
  vi.mocked(invoke).mockRejectedValue(new Error('native stream failed'));
  Object.defineProperty(window, 'chrome', { configurable: true, value: { webview: { getTextureStream: vi.fn() } } });
  const onError = vi.fn();
  const receiver = new BrowserTextureStreamReceiver(onError);
  await expect(receiver.start({ sessionId: 'browser-tab-7', width: 640, height: 480 })).rejects.toThrow('native stream failed');
  expect(onError).toHaveBeenCalledWith('Error: native stream failed', { sessionId: 'browser-tab-7', width: 640, height: 480 });
  await receiver.stop();
  if (previousChrome) Object.defineProperty(window, 'chrome', previousChrome);
  else delete (window as Window & { chrome?: unknown }).chrome;
  vi.mocked(invoke).mockReset();
});
