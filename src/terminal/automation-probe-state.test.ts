import { describe, expect, it } from 'vitest';
import { emptyTapHoldState, forwardedKeyIdentity, ProbeLayoutState, updateTapHold } from './automation-probe-state';

describe('tap-hold probe state', () => {
  it('pairs VK edges with no DOM code and keeps physical codes distinct', () => {
    const injectedH = { code: '', location: 0, keyCode: 72, which: 72 };
    const injectedJ = { code: '', location: 0, keyCode: 74, which: 74 };
    const physicalH = { code: 'KeyH', location: 0, keyCode: 72, which: 72 };
    expect(forwardedKeyIdentity(injectedH)).toBe(forwardedKeyIdentity({ ...injectedH }));
    expect(forwardedKeyIdentity(injectedH)).not.toBe(forwardedKeyIdentity(injectedJ));
    expect(forwardedKeyIdentity(physicalH)).not.toBe(forwardedKeyIdentity(injectedH));
  });

  it('turns a quick press into one Escape and ignores duplicate edges', () => {
    let state = emptyTapHoldState();
    state = updateTapHold(state, 'down', 10, 180).state;
    const up = updateTapHold(state, 'up', 40, 180);
    expect(up.escape).toBe(true);
    expect(updateTapHold(up.state, 'up', 41, 180).escape).toBe(false);
  });

  it('treats a chord or elapsed hold as Control and never also taps Escape', () => {
    let state = updateTapHold(emptyTapHoldState(), 'down', 10, 180).state;
    state = updateTapHold(state, 'repeat', 20, 180).state;
    state = updateTapHold(state, 'other-key', 30, 180).state;
    expect(state.control).toBe(true);
    expect(updateTapHold(state, 'up', 40, 180).escape).toBe(false);

    state = updateTapHold(emptyTapHoldState(), 'down', 10, 180).state;
    state = updateTapHold(state, 'timeout', 190, 180).state;
    expect(state.control).toBe(true);
    expect(updateTapHold(state, 'up', 200, 180).escape).toBe(false);

    state = updateTapHold(emptyTapHoldState(), 'down', 10, 180).state;
    expect(updateTapHold(state, 'up', 190, 180).escape).toBe(false);
  });

  it('uses native physical duration for framed taps even when WebView delivery crosses the threshold', () => {
    let state = updateTapHold(emptyTapHoldState(), 'down', 10, 180).state;
    state = updateTapHold(state, 'timeout', 190, 180).state;
    expect(updateTapHold(state, 'up', 247, 180, 'tap').escape).toBe(true);

    state = updateTapHold(emptyTapHoldState(), 'down', 10, 180).state;
    state = updateTapHold(state, 'other-key', 30, 180).state;
    expect(updateTapHold(state, 'up', 247, 180, 'tap').escape).toBe(false);

    state = updateTapHold(emptyTapHoldState(), 'down', 10, 180).state;
    expect(updateTapHold(state, 'up', 247, 180, 'held').escape).toBe(false);
  });

  it('cancels without emitting Escape', () => {
    const held = updateTapHold(emptyTapHoldState(), 'down', 10, 180).state;
    const canceled = updateTapHold(held, 'cancel', 20, 180);
    expect(canceled.escape).toBe(false);
    expect(updateTapHold(canceled.state, 'up', 30, 180).escape).toBe(false);
  });
});

describe('per-tab probe layouts', () => {
  it('keeps mode and user layout changes tab-local and rejects stale generations', () => {
    const state = new ProbeLayoutState();
    state.configure('a', { normalHkl: 'en', insertHkl: 'ru' });
    state.configure('b', { normalHkl: 'en', insertHkl: 'ru' });
    state.setContext({ tabId: 'a', generation: 1, focused: true });
    expect(state.setCursorStyle('a', 'block', 1)).toBeNull();
    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'en', source: 'observed' })).toBeNull();
    expect(state.setCursorStyle('b', 'bar', 1)).toBeNull();
    expect(state.setCursorStyle('a', 'bar', 1)).toEqual({ tabId: 'a', generation: 1, hkl: 'ru' });
    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'ru', source: 'request' })).toBeNull();
    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'fr', source: 'observed' })).toBeNull();

    state.setContext({ tabId: 'b', generation: 2, focused: true });
    state.setCursorStyle('b', 'bar', 2);
    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'ru', source: 'request' })).toBeNull();
    expect(state.observeLayout({ tabId: 'b', generation: 2, hkl: 'en', source: 'observed' })).toEqual({ tabId: 'b', generation: 2, hkl: 'ru' });
    state.setContext({ tabId: 'a', generation: 3, focused: true });
    expect(state.observeLayout({ tabId: 'a', generation: 3, hkl: 'fr', source: 'observed' })).toBeNull();
  });

  it('does not request a layout while unfocused or without configured targets', () => {
    const state = new ProbeLayoutState();
    state.configure('a', { normalHkl: 'en', insertHkl: 'ru' });
    state.setContext({ tabId: 'a', generation: 1, focused: false });
    expect(state.setCursorStyle('a', 'bar', 1)).toBeNull();
    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'en', source: 'observed' })).toBeNull();
  });

  it('keeps the configured Normal layout and ignores delayed own requests after a mode change or blur', () => {
    const state = new ProbeLayoutState();
    state.configure('a', { normalHkl: 'en', insertHkl: 'ru' });
    state.setContext({ tabId: 'a', generation: 1, focused: true });
    state.setCursorStyle('a', 'block', 1);
    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'en', source: 'observed' })).toBeNull();

    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'ru', source: 'observed' })).toEqual({ tabId: 'a', generation: 1, hkl: 'en' });
    expect(state.setCursorStyle('a', 'bar', 1)).toBeNull();
    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'en', source: 'observed' })).toEqual({ tabId: 'a', generation: 1, hkl: 'ru' });
    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'ru', source: 'request' })).toBeNull();

    expect(state.observeLayout({ tabId: 'a', generation: 1, hkl: 'fr', source: 'observed' })).toBeNull();
    state.setContext({ tabId: null, generation: 2, focused: false });
    state.setContext({ tabId: 'a', generation: 3, focused: true });
    expect(state.observeLayout({ tabId: 'a', generation: 3, hkl: 'de', source: 'observed' })).toEqual({ tabId: 'a', generation: 3, hkl: 'fr' });
  });

  it('clears a rejected pending request once and allows a later mode transition to retry', () => {
    const state = new ProbeLayoutState();
    state.configure('a', { normalHkl: 'en', insertHkl: 'ru' });
    state.setContext({ tabId: 'a', generation: 4, focused: true });
    state.setCursorStyle('a', 'bar', 4);
    expect(state.observeLayout({ tabId: 'a', generation: 4, hkl: 'en', source: 'observed' })).toEqual({ tabId: 'a', generation: 4, hkl: 'ru' });
    const error = { tabId: 'a', generation: 4, hkl: 'ru', reason: 'timeout' };
    expect(state.rejectLayout(error)).toBe(true);
    expect(state.rejectLayout(error)).toBe(false);
    expect(state.setCursorStyle('a', 'block', 4)).toBeNull();
    expect(state.setCursorStyle('a', 'bar', 4)).toEqual({ tabId: 'a', generation: 4, hkl: 'ru' });
  });
});
