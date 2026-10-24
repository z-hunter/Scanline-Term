export type TapHoldState = { downAt: number | null; control: boolean; used: boolean };
export type TapHoldEvent = 'down' | 'up' | 'repeat' | 'other-key' | 'cancel' | 'timeout';
export type TapHoldClassification = 'tap' | 'held';
export type TapHoldResult = { state: TapHoldState; escape: boolean };

export function forwardedKeyIdentity(event: Pick<KeyboardEvent, 'code' | 'location'> & Partial<Pick<KeyboardEvent, 'keyCode' | 'which'>>): string {
  const virtualKey = event.keyCode || event.which || 0;
  return event.code ? `code:${event.code}:${event.location}` : `vk:${virtualKey}:${event.location}`;
}

export const emptyTapHoldState = (): TapHoldState => ({ downAt: null, control: false, used: false });

export function updateTapHold(
  state: TapHoldState,
  event: TapHoldEvent,
  now: number,
  thresholdMs: number,
  classification?: TapHoldClassification,
): TapHoldResult {
  if (event === 'cancel') return { state: emptyTapHoldState(), escape: false };
  if (event === 'down') {
    return state.downAt === null ? { state: { downAt: now, control: false, used: false }, escape: false } : { state, escape: false };
  }
  if (event === 'repeat' || state.downAt === null) return { state, escape: false };
  if (event === 'other-key' || event === 'timeout') {
    const control = state.control || event === 'other-key' || now - state.downAt >= thresholdMs;
    return { state: { ...state, control, used: state.used || event === 'other-key' }, escape: false };
  }
  const escape = classification === 'tap'
    ? !state.used
    : classification === 'held'
      ? false
      : !state.control && !state.used && now - state.downAt < thresholdMs;
  return { state: emptyTapHoldState(), escape };
}

export type ProbeCursorStyle = 'block' | 'bar' | 'underline' | null;
export type ProbeContext = { tabId: string | null; generation: number; focused: boolean };
export type ProbeLayoutRequest = { tabId: string; generation: number; hkl: string };
export type ProbeLayoutChange = { tabId: string | null; generation: number; hkl: string; source: 'request' | 'observed' };
export type ProbeLayoutError = { tabId: string | null; generation: number; hkl: string | null; reason: string };
export type ProbeTabLayouts = { normalHkl: string; insertHkl: string };

type TabLayoutState = ProbeTabLayouts & { cursorStyle: ProbeCursorStyle };

export class ProbeLayoutState {
  private readonly tabs = new Map<string, TabLayoutState>();
  private context: ProbeContext = { tabId: null, generation: 0, focused: false };
  private currentHkl: string | null = null;
  private readonly pendingHkls = new Set<string>();

  configure(tabId: string, layouts: ProbeTabLayouts): void {
    const previous = this.tabs.get(tabId);
    this.tabs.set(tabId, { ...layouts, cursorStyle: previous?.cursorStyle ?? null });
  }

  setContext(context: ProbeContext): void {
    if (context.generation < this.context.generation) return;
    if (context.generation !== this.context.generation || context.tabId !== this.context.tabId || context.focused !== this.context.focused) {
      this.currentHkl = null;
    }
    this.context = context;
    this.pendingHkls.clear();
  }

  setCursorStyle(tabId: string, style: ProbeCursorStyle, generation: number): ProbeLayoutRequest | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    tab.cursorStyle = style;
    if (this.context.tabId !== tabId) return null;
    return this.requestCurrent(generation);
  }

  observeLayout(change: ProbeLayoutChange): ProbeLayoutRequest | null {
    if (change.generation !== this.context.generation || change.tabId !== this.context.tabId) return null;
    const isPendingRequest = this.pendingHkls.delete(change.hkl);
    if (change.source === 'observed' && !isPendingRequest && this.currentHkl !== null && change.hkl !== this.currentHkl) {
      const tab = change.tabId ? this.tabs.get(change.tabId) : undefined;
      if (tab && this.context.focused && tab.cursorStyle === 'bar') tab.insertHkl = change.hkl;
    }
    this.currentHkl = change.hkl;
    return this.requestCurrent(change.generation);
  }

  rejectLayout(error: ProbeLayoutError): boolean {
    if (error.tabId === null || error.generation !== this.context.generation || error.tabId !== this.context.tabId || error.hkl === null) return false;
    const key = error.hkl.toLowerCase();
    const pending = [...this.pendingHkls].find((hkl) => hkl.toLowerCase() === key);
    if (!pending) return false;
    this.pendingHkls.delete(pending);
    return true;
  }

  private requestCurrent(generation: number): ProbeLayoutRequest | null {
    const { tabId, focused } = this.context;
    if (tabId === null || !focused || this.currentHkl === null || generation !== this.context.generation) return null;
    const tab = this.tabs.get(tabId);
    if (!tab || tab.cursorStyle === null) return null;
    const hkl = tab.cursorStyle === 'bar' ? tab.insertHkl : tab.normalHkl;
    if (!hkl || hkl === this.currentHkl || this.pendingHkls.has(hkl)) return null;
    this.pendingHkls.add(hkl);
    return { tabId, generation, hkl };
  }
}
