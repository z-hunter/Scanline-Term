import { invoke } from '@tauri-apps/api/core';

export const BENCHMARK_URL = 'http://localhost:5173/texture-stream-benchmark.html';
export const BENCHMARK_WIDTH = 1280;
export const BENCHMARK_HEIGHT = 720;
export type BrowserBenchmarkMode = 'jpeg' | 'texture';
export type BrowserVideoFrame = { video: HTMLVideoElement; timestamp: number; epochTimeMs?: number; requireDirect?: boolean; sessionId?: string };
export type BrowserTextureMetrics = { frames: number; width: number; height: number };

type TextureStreamInfo = { streamId: string; epochAtQpcZeroMs?: number | null };
export type BrowserTextureStreamOptions = { width: number; height: number } & (
  { sessionId: string; sourceUrl?: never; streamId?: never } |
  { sourceUrl: string; streamId: string; sessionId?: never }
);
const TEXTURE_START_TIMEOUT_MS = 10_000;

declare global {
  interface Window {
    __scanlineBrowserBenchmark?: {
      open(options: { mode: BrowserBenchmarkMode; url: string }): Promise<void>;
      read(): ReturnType<BrowserBenchmark['read']>;
      close(): Promise<void>;
    };
  }
}

export class BrowserBenchmark {
  readonly video = { current: null as BrowserVideoFrame | null };
  private pending: { at: number | undefined; width: number; height: number } | undefined;
  private latency: number[] = [];
  private submittedFrames = 0;
  private distinctFrames = 0;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private outputWidth = 0;
  private outputHeight = 0;
  private rasterWidth = 0;
  private rasterHeight = 0;
  error: string | null = null;

  constructor(readonly id: string, readonly mode: BrowserBenchmarkMode) {}

  frame(width: number, height: number, at?: number) {
    this.pending = { at, width, height };
  }

  submitted(output: HTMLCanvasElement, source: HTMLCanvasElement) {
    ++this.submittedFrames;
    if (!this.pending) return;
    const { at, width, height } = this.pending;
    this.pending = undefined;
    ++this.distinctFrames;
    this.sourceWidth = width;
    this.sourceHeight = height;
    this.outputWidth = output.width;
    this.outputHeight = output.height;
    this.rasterWidth = source.width;
    this.rasterHeight = source.height;
    if (at !== undefined) {
      const elapsed = performance.timeOrigin + performance.now() - at;
      if (Number.isFinite(elapsed) && elapsed >= -5 && elapsed < 60_000) this.latency.push(elapsed);
      if (this.latency.length > 2048) this.latency.shift();
    }
  }

  get hasFrame() { return this.distinctFrames > 0; }

  read() {
    return {
      submittedFrames: this.submittedFrames, distinctFrames: this.distinctFrames,
      latencySamplesMs: this.latency.splice(0), sourceWidth: this.sourceWidth, sourceHeight: this.sourceHeight,
      outputWidth: this.outputWidth, outputHeight: this.outputHeight,
      rasterWidth: this.rasterWidth, rasterHeight: this.rasterHeight,
      preset: 'benchmark-default', error: this.error,
    };
  }
}

export class BrowserTextureStreamReceiver {
  readonly video = { current: null as BrowserVideoFrame | null };
  readonly metrics: BrowserTextureMetrics = { frames: 0, width: 0, height: 0 };
  error: string | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private readonly api = (window as Window & { chrome?: { webview?: { getTextureStream?(id: string): Promise<MediaStream> } } }).chrome?.webview;
  private callback = 0;
  private stream: MediaStream | undefined;
  private streamId: string | null = null;
  private options: BrowserTextureStreamOptions | null = null;
  private generation = 0;
  private started = false;
  private startupTimer = 0;
  private readonly onStreamInactive = () => { void this.fail(new Error('TextureStream ended')); };
  private readonly listeners = new Set<(frame: BrowserVideoFrame, metrics: BrowserTextureMetrics) => void>();

  constructor(private readonly onError: (reason: string, options: BrowserTextureStreamOptions | null) => void = () => {}) {}

  onFrame(callback: (frame: BrowserVideoFrame, metrics: BrowserTextureMetrics) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async start(options: BrowserTextureStreamOptions): Promise<void> {
    const generation = ++this.generation;
    await this.stopResources();
    if (generation !== this.generation) return;
    this.options = options;
    this.error = null;
    this.metrics.frames = this.metrics.width = this.metrics.height = 0;
    const streamId = options.sourceUrl ? options.streamId! : crypto.randomUUID();
    this.streamId = streamId;
    let rejectDeadline!: (reason: Error) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    this.startupTimer = window.setTimeout(() => {
      const error = new Error('TextureStream startup timed out');
      rejectDeadline(error);
      if (generation === this.generation) void this.fail(error);
    }, TEXTURE_START_TIMEOUT_MS);
    const withinDeadline = <T>(promise: Promise<T>) => Promise.race([promise, deadline]);
    try {
      if (!this.api?.getTextureStream) throw new Error('WebView2 TextureStream feature is unavailable');
      this.started = true;
      const request = invoke<TextureStreamInfo>('start_browser_texture_stream', options.sourceUrl
        ? { streamId, sourceUrl: options.sourceUrl, width: options.width, height: options.height }
        : { sessionId: options.sessionId, streamId, width: options.width, height: options.height });
      void request.then(result => { if (generation !== this.generation) void this.stopNative(result.streamId); }, () => {});
      const result = await withinDeadline(request);
      if (generation !== this.generation) { await this.stopNative(streamId); return; }
      const pendingStream = this.api.getTextureStream(result.streamId).then(stream => {
        if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); void this.stopNative(result.streamId); }
        return stream;
      });
      const stream = await withinDeadline(pendingStream);
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const video = this.videoElement = document.createElement('video');
      video.muted = true; video.playsInline = true; video.setAttribute('aria-hidden', 'true');
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
      video.onerror = () => { void this.fail(video.error ?? new Error('TextureStream video failed')); };
      this.stream.addEventListener('inactive', this.onStreamInactive);
      document.body.append(video);
      video.srcObject = this.stream;
      await withinDeadline(video.play());
      if (generation !== this.generation) return;
      let previous = -1;
      const frame: VideoFrameRequestCallback = (_, metadata) => {
        if (generation !== this.generation) return;
        if (metadata.mediaTime !== previous) {
          previous = metadata.mediaTime;
          window.clearTimeout(this.startupTimer);
          this.startupTimer = 0;
          const current = this.video.current = { video, timestamp: previous, epochTimeMs: result.epochAtQpcZeroMs == null ? undefined : result.epochAtQpcZeroMs + previous * 1000, requireDirect: !!options.sourceUrl, sessionId: options.sessionId };
          this.metrics.frames += 1; this.metrics.width = metadata.width; this.metrics.height = metadata.height;
          this.listeners.forEach(callback => callback(current, this.metrics));
        }
        this.callback = video.requestVideoFrameCallback(frame);
      };
      this.callback = video.requestVideoFrameCallback(frame);
    } catch (reason) {
      if (generation !== this.generation) return;
      await this.fail(reason);
      throw reason;
    }
  }

  async stop(): Promise<void> {
    ++this.generation;
    await this.stopResources();
  }

  private async stopResources(): Promise<void> {
    window.clearTimeout(this.startupTimer);
    this.startupTimer = 0;
    const video = this.videoElement;
    this.videoElement = null;
    if (video && this.callback) video.cancelVideoFrameCallback(this.callback);
    this.callback = 0;
    this.video.current = null;
    this.options = null;
    const stream = this.stream;
    this.stream = undefined;
    if (stream) { stream.removeEventListener('inactive', this.onStreamInactive); stream.getTracks().forEach(track => track.stop()); }
    if (video) { video.onerror = null; video.srcObject = null; video.remove(); }
    const id = this.streamId; this.streamId = null;
    const started = this.started; this.started = false;
    if (id && started) await this.stopNative(id);
  }

  private async stopNative(streamId: string) {
    try { await invoke('stop_browser_texture_stream', { streamId }); }
    catch (reason) { this.error = String(reason); }
  }

  private async fail(reason: unknown) {
    this.error = String(reason);
    this.onError(this.error, this.options);
    await this.stop();
  }
}

export function createBrowserTextureStreamReceiver(onError?: (reason: string) => void) {
  const receiver = new BrowserTextureStreamReceiver(onError);
  return { receiver, cleanup: () => receiver.stop() };
}

export function attachBrowserTextureStream(run: BrowserBenchmark, changed: () => void) {
  const { receiver, cleanup } = createBrowserTextureStreamReceiver(reason => { run.error = reason; });
  const unsubscribe = receiver.onFrame((frame, metrics) => {
    run.video.current = frame;
    run.frame(metrics.width, metrics.height, frame.epochTimeMs);
    changed();
  });
  void receiver.start({ streamId: run.id, sourceUrl: BENCHMARK_URL, width: BENCHMARK_WIDTH, height: BENCHMARK_HEIGHT })
    .catch(reason => { run.error = String(reason); });
  return () => { unsubscribe(); run.video.current = null; void cleanup(); };
}
