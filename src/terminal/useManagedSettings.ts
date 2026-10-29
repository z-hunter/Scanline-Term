import { useCallback, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { effectiveManagedSettings, normalizeManagedSettings, type ManagedSettings, type ManagedSettingsResponse } from '../crt/managed-settings';

type Values = { defaultPreset: string; smoothScrollback: boolean; restoreWindow: boolean };

export function useManagedSettings(legacySmoothScrollback: boolean, onError: (message: string) => void) {
  const [values, setValues] = useState<Values>({ defaultPreset: 'default', smoothScrollback: legacySmoothScrollback, restoreWindow: true });
  const [ready, setReady] = useState(!isTauri());
  const [authoritative, setAuthoritative] = useState(false);
  const [writesEnabled, setWritesEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = useRef({ values, revision: '', hasSettings: false });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const sequence = useRef(0);
  const failureGeneration = useRef(0);
  const legacyValueAvailable = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  current.current.values = values;

  const load = useCallback(async (legacy = legacySmoothScrollback): Promise<{ values: Values; response: ManagedSettingsResponse | null }> => {
    const request = ++sequence.current;
    try {
      const response = normalizeManagedSettings(await invoke<unknown>('load_managed_settings'));
      const next = effectiveManagedSettings(response, legacy, legacyValueAvailable.current);
      if (response.hasSettings) legacyValueAvailable.current = false;
      current.current = { values: next, revision: response.revision, hasSettings: response.hasSettings };
      if (request === sequence.current) {
        setValues(next);
        setReady(true);
        setAuthoritative(!legacyValueAvailable.current);
        setWritesEnabled(true);
        setSaving(false);
      }
      return { values: next, response };
    } catch (reason) {
      if (request === sequence.current) {
        setReady(true);
        setWritesEnabled(false);
        setSaving(false);
        onErrorRef.current(`Could not load managed settings: ${String(reason)}`);
      }
      return { values: current.current.values, response: null };
    }
  }, [legacySmoothScrollback]);

  const save = useCallback((patch: Partial<Values>): Promise<boolean> => {
    if (!writesEnabled) return Promise.resolve(false);
    const next = { ...current.current.values, ...patch };
    current.current.values = next;
    setValues(next);
    const request = ++sequence.current;
    const failureAtEnqueue = failureGeneration.current;
    setSaving(true);
    const update = queue.current.catch(() => undefined).then(async (): Promise<boolean> => {
      if (failureAtEnqueue !== failureGeneration.current) {
        if (request === sequence.current) setSaving(false);
        return false;
      }
      const snapshot = current.current.values;
      const settings: ManagedSettings = snapshot;
      try {
        const response = normalizeManagedSettings(await invoke<unknown>('save_managed_settings', {
          settings,
          revision: current.current.revision,
        }));
        if (!response.hasSettings) throw new Error('managed settings were not persisted');
        legacyValueAvailable.current = false;
        current.current = { ...current.current, revision: response.revision, hasSettings: response.hasSettings };
        setAuthoritative(true);
        return true;
      } catch (reason) {
        failureGeneration.current += 1;
        let restored = current.current.values;
        try {
          const response = normalizeManagedSettings(await invoke<unknown>('load_managed_settings'));
          restored = effectiveManagedSettings(response, legacySmoothScrollback, legacyValueAvailable.current);
          if (response.hasSettings) legacyValueAvailable.current = false;
          current.current = { values: restored, revision: response.revision, hasSettings: response.hasSettings };
          setAuthoritative(!legacyValueAvailable.current);
          setWritesEnabled(false);
        } catch {
          current.current = { ...current.current, values: restored };
          setWritesEnabled(false);
        }
        current.current.values = restored;
        setValues(restored);
        setReady(true);
        onErrorRef.current(`Could not save managed settings: ${String(reason)}`);
        return false;
      } finally {
        if (request === sequence.current) setSaving(false);
      }
    });
    queue.current = update;
    return update;
  }, [legacySmoothScrollback, writesEnabled]);

  const disableWrites = useCallback(() => setWritesEnabled(false), []);
  const settle = useCallback(() => queue.current.then(() => undefined), []);

  return { values, ready, authoritative, saving, writesEnabled, load, save, disableWrites, settle };
}
