import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRT_SETTINGS } from '../crt/settings';
import type { LuaPresetRequest } from './lua-automation';
import { applyLuaPresetCleanup, applyLuaPresetRequest } from './lua-preset-request';

const request: LuaPresetRequest = { frontendId: 'frontend', generation: 4, tabId: 'tab', name: 'custom' };
const preset = { version: 1 as const, resolution: '640x480' as const, crt: { ...DEFAULT_CRT_SETTINGS } };
const tabPreset = (dirty: boolean) => ({ name: 'default', draftName: 'default', settings: preset, dirty });

describe('applyLuaPresetRequest', () => {
  it('does not load or replace a dirty target preset', async () => {
    const load = vi.fn(async () => preset);
    const apply = vi.fn();
    const onError = vi.fn();
    await applyLuaPresetRequest(request, () => true, () => tabPreset(true), load, apply, onError);
    expect(load).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Lua preset custom was not applied because the tab has unsaved preset changes.');
  });

  it('rejects a request invalidated while its saved preset is loading', async () => {
    let finish!: (value: typeof preset) => void;
    let current = true;
    const apply = vi.fn();
    const pending = applyLuaPresetRequest(request, () => current, () => tabPreset(false), () => new Promise((resolve) => { finish = resolve; }), apply, vi.fn());
    current = false;
    finish(preset);
    await pending;
    expect(apply).not.toHaveBeenCalled();
  });

  it('rechecks dirty state after loading and applies only to the target tab', async () => {
    let dirty = false;
    const apply = vi.fn();
    const onError = vi.fn();
    await applyLuaPresetRequest(request, () => true, () => tabPreset(dirty), async () => { dirty = true; return preset; }, apply, onError);
    expect(apply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('applies a validated saved preset without requesting focus changes', async () => {
    const apply = vi.fn();
    await applyLuaPresetRequest(request, () => true, () => tabPreset(false), async () => preset, apply, vi.fn());
    expect(apply).toHaveBeenCalledWith(preset, 'custom', 'tab');
  });
});

describe('applyLuaPresetCleanup', () => {
  const cleanup = { id: '0', tabId: 'inactive-tab', name: 'baseline', expectedCurrentPreset: 'far' };

  it('restores a live inactive tab only while its expected preset is clean and unchanged', async () => {
    const apply = vi.fn();
    const onError = vi.fn();
    const result = await applyLuaPresetCleanup(cleanup, () => true, () => true, () => ({ ...tabPreset(false), name: 'far' }), async () => preset, apply, onError);
    expect(result).toBe('handled');
    expect(apply).toHaveBeenCalledWith(preset, 'baseline', 'inactive-tab');
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['dirty', () => ({ ...tabPreset(true), name: 'far' })],
    ['changed', () => ({ ...tabPreset(false), name: 'manual' })],
  ])('skips a %s tab without loading or replacing it', async (_reason, getPreset: () => ReturnType<typeof tabPreset>) => {
    const load = vi.fn(async () => preset);
    const apply = vi.fn();
    const onError = vi.fn();
    await applyLuaPresetCleanup(cleanup, () => true, () => true, getPreset, load, apply, onError);
    expect(load).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rechecks the exact preset and dirty state after async load', async () => {
    let current = { ...tabPreset(false), name: 'far' };
    const apply = vi.fn();
    const onError = vi.fn();
    await applyLuaPresetCleanup(cleanup, () => true, () => true, () => current, async () => {
      current = { ...current, name: 'manual' };
      return preset;
    }, apply, onError);
    expect(apply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not overwrite edits made while the restore preset is loading', async () => {
    let current = { ...tabPreset(false), name: 'far' };
    const apply = vi.fn();
    const onError = vi.fn();
    await applyLuaPresetCleanup(cleanup, () => true, () => true, () => current, async () => {
      current = { ...current, dirty: true };
      return preset;
    }, apply, onError);
    expect(apply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('aborts after a delayed load if the reload token became stale', async () => {
    let finish!: (value: typeof preset) => void;
    let current = true;
    const apply = vi.fn();
    const pending = applyLuaPresetCleanup(cleanup, () => current, () => true, () => ({ ...tabPreset(false), name: 'far' }), () => new Promise((resolve) => { finish = resolve; }), apply, vi.fn());
    current = false;
    finish(preset);
    expect(await pending).toBe('stale');
    expect(apply).not.toHaveBeenCalled();
  });

  it('treats a closed tab as handled without applying or reporting an error', async () => {
    const apply = vi.fn();
    const onError = vi.fn();
    const result = await applyLuaPresetCleanup(cleanup, () => true, () => false, () => undefined, async () => preset, apply, onError);
    expect(result).toBe('handled');
    expect(apply).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
