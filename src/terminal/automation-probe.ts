import { isTauri } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ProbeLayoutState, type ProbeContext, type ProbeCursorStyle, type ProbeLayoutChange, type ProbeLayoutError, type ProbeLayoutRequest } from './automation-probe-state';

export type ProbeStatus = {
  frontendId: string;
  enabled: boolean;
  reason?: string;
  layouts?: { hkl: string; klid: string | null; langIdHint: string }[];
  targets?: { normalHkl: string | null; insertHkl: string | null };
  currentHkl?: string | null;
};

type ProbeLayoutChangeEvent = ProbeLayoutChange & { frontendId: string };
type ProbeLayoutErrorEvent = ProbeLayoutError & { frontendId: string };

const enabledInBuild = import.meta.env.DEV;

export class TerminalAutomationProbe {
  private readonly frontendId = crypto.randomUUID();
  private readonly layout = new ProbeLayoutState();
  private readonly cursorStyles = new Map<string, ProbeCursorStyle>();
  private readonly configuredTabs = new Set<string>();
  private unlisten: UnlistenFn[] = [];
  private startEpoch = 0;
  private startPromise: Promise<void> | null = null;
  private status: ProbeStatus = { frontendId: '', enabled: false };
  private context: ProbeContext = { tabId: null, generation: 0, focused: false };

  constructor(
    private readonly onStatus: (status: ProbeStatus) => void = () => undefined,
    private readonly onError: (message: string) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (!enabledInBuild || !isTauri() || this.unlisten.length) return;
    if (this.startPromise) return this.startPromise;
    const epoch = ++this.startEpoch;
    const startPromise = this.startListeners(epoch).catch((reason) => {
      if (epoch !== this.startEpoch) return;
      this.onError(`Automation probe startup failed: ${String(reason)}`);
      this.dispose();
    }).finally(() => {
      if (epoch === this.startEpoch && this.startPromise === startPromise) this.startPromise = null;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  get enabled(): boolean { return this.status.enabled; }
  get currentContext(): Readonly<ProbeContext> { return { ...this.context }; }

  setContext(tabId: string | null, focused: boolean): void {
    const nextFocused = tabId !== null && focused;
    if (this.context.tabId === tabId && this.context.focused === nextFocused) return;
    this.context = { tabId, focused: nextFocused, generation: this.context.generation + 1 };
    this.layout.setContext(this.context);
    if (this.status.enabled) this.send('automation-probe-context', this.contextPayload());
    if (tabId) this.configureTab(tabId);
    const style = tabId ? this.cursorStyles.get(tabId) : undefined;
    if (tabId && style !== undefined) this.setCursorStyle(tabId, style);
  }

  setCursorStyle(tabId: string, style: ProbeCursorStyle): void {
    this.cursorStyles.set(tabId, style);
    if (!this.status.enabled) return;
    this.configureTab(tabId);
    const request = this.layout.setCursorStyle(tabId, style, this.context.generation);
    if (request) void this.requestLayout(request);
  }

  dispose(): void {
    this.startEpoch++;
    this.startPromise = null;
    if (this.context.focused) this.setContext(this.context.tabId, false);
    for (const stop of this.unlisten) stop();
    this.unlisten = [];
    if (this.status.enabled) {
      this.status = { frontendId: this.frontendId, enabled: false, reason: 'probe disposed' };
      this.onStatus(this.status);
    }
  }

  private setStatus(status: ProbeStatus): void {
    if (status.frontendId !== this.frontendId) return;
    this.status = status;
    if (this.status.enabled) {
      this.layout.setContext(this.context);
      for (const tabId of this.cursorStyles.keys()) this.configureTab(tabId);
      if (this.context.tabId && this.status.currentHkl && this.hasLayout(this.status.currentHkl)) {
        const request = this.layout.observeLayout({ tabId: this.context.tabId, generation: this.context.generation, hkl: this.status.currentHkl, source: 'observed' });
        if (request) void this.requestLayout(request);
      }
      this.send('automation-probe-context', this.contextPayload());
    }
    this.onStatus(this.status);
  }

  private async startListeners(epoch: number): Promise<void> {
    const results = await Promise.allSettled([
      listen<ProbeStatus>('automation-probe-status', ({ payload }) => { if (epoch === this.startEpoch) this.setStatus(payload); }),
      listen<ProbeLayoutChangeEvent>('automation-probe-layout-changed', ({ payload }) => { if (epoch === this.startEpoch) this.layoutChanged(payload); }),
      listen<ProbeLayoutErrorEvent>('automation-probe-layout-error', ({ payload }) => { if (epoch === this.startEpoch) this.layoutError(payload); }),
    ]);
    const stops = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    if (epoch !== this.startEpoch) {
      stops.forEach((stop) => stop());
      return;
    }
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) {
      stops.forEach((stop) => stop());
      throw failed.reason;
    }
    this.unlisten = stops;
    await emit('automation-probe-ready', { frontendId: this.frontendId });
  }

  private configureTab(tabId: string): void {
    if (this.configuredTabs.has(tabId) || !this.status.enabled || !this.status.targets) return;
    const { normalHkl, insertHkl } = this.status.targets;
    if (!normalHkl || !insertHkl || !this.status.layouts?.length) return;
    const layouts = new Set(this.status.layouts.map(({ hkl }) => hkl.toLowerCase()));
    if (!layouts.has(normalHkl.toLowerCase()) || !layouts.has(insertHkl.toLowerCase())) return;
    this.layout.configure(tabId, { normalHkl, insertHkl });
    this.configuredTabs.add(tabId);
  }

  private layoutChanged(event: ProbeLayoutChangeEvent): void {
    if (event.frontendId !== this.frontendId) return;
    const change: ProbeLayoutChange = event;
    if (!this.status.enabled || !this.hasLayout(change.hkl)) return;
    const request = this.layout.observeLayout(change);
    if (request) void this.requestLayout(request);
  }

  private layoutError(event: ProbeLayoutErrorEvent): void {
    if (event.frontendId !== this.frontendId) return;
    const error: ProbeLayoutError = event;
    if (!this.status.enabled || !this.layout.rejectLayout(error)) return;
    this.onError(`Automation probe layout request failed (${error.hkl}): ${error.reason}`);
  }

  private hasLayout(hkl: string): boolean {
    return Boolean(this.status.layouts?.some((layout) => layout.hkl.toLowerCase() === hkl.toLowerCase()));
  }

  private requestLayout(request: ProbeLayoutRequest): void {
    void emit('automation-probe-layout-request', { ...request, frontendId: this.frontendId }).catch((reason) => {
      if (!this.layout.rejectLayout({ ...request, reason: `event emit failed: ${String(reason)}` })) return;
      this.onError(`Automation probe layout request failed (${request.hkl}): event emit failed: ${String(reason)}`);
    });
  }

  private contextPayload(): ProbeContext & { frontendId: string } {
    return { ...this.context, frontendId: this.frontendId };
  }

  private send(event: string, payload?: unknown): void {
    void emit(event, payload).catch((reason) => this.onError(`Automation probe event failed (${event}): ${String(reason)}`));
  }
}
