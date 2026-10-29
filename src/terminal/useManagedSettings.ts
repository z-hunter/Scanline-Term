import { useCallback, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { effectiveManagedSettings, normalizeManagedSettings, type EffectiveManagedSettings, type ManagedSettings, type ManagedSettingsResponse } from '../crt/managed-settings';
import { appGlobalsFromStored, loadStoredSettings, type AppSettings } from '../crt/settings';

export function useManagedSettings(legacy: Omit<AppSettings, 'version'>, onError: (message: string) => void) {
  const [values, setValues] = useState<EffectiveManagedSettings>({ ...legacy, defaultPreset: 'default', restoreWindow: true });
  const [ready, setReady] = useState(!isTauri());
  const [authoritative, setAuthoritative] = useState(false);
  const [writesEnabled, setWritesEnabled] = useState(false);
  const writesEnabledRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const current = useRef({ values, revision: '' });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const sequence = useRef(0);
  const failureGeneration = useRef(0);
  const migrated = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  current.current.values = values;

  const load = useCallback(async (fallback: Omit<AppSettings, 'version'> = legacy): Promise<{ values: EffectiveManagedSettings; response: ManagedSettingsResponse | null; needsMigration: boolean }> => {
    const request = ++sequence.current;
    try {
      const response = normalizeManagedSettings(await invoke<unknown>('load_managed_settings'));
      const base = migrated.current ? appGlobalsFromStored(loadStoredSettings(null)) : fallback;
      const next = effectiveManagedSettings(response, base);
      const needsMigration = response.settings.settingsVersion !== 1 && !migrated.current;
      if (request === sequence.current) {
        current.current = { values: next, revision: response.revision };
        if (response.settings.settingsVersion === 1) migrated.current = true;
        setValues(next);
        setReady(true);
        setAuthoritative(!needsMigration);
        setWritesEnabled(true);
        writesEnabledRef.current = true;
        setSaving(false);
      }
      return { values: next, response, needsMigration };
    } catch (reason) {
      if (request === sequence.current) {
        setReady(true);
        setWritesEnabled(false);
        writesEnabledRef.current = false;
        setSaving(false);
        onErrorRef.current(`Could not load managed settings: ${String(reason)}`);
      }
      return { values: current.current.values, response: null, needsMigration: false };
    }
  }, [legacy]);

  const save = useCallback((patch: Partial<EffectiveManagedSettings>): Promise<boolean> => {
    if (!writesEnabledRef.current) return Promise.resolve(false);
    const next = { ...current.current.values, ...patch };
    current.current.values = next;
    setValues(next);
    const request = ++sequence.current;
    const failureAtEnqueue = failureGeneration.current;
    setSaving(true);
    const update = queue.current.catch(() => undefined).then(async (): Promise<boolean> => {
      if (failureAtEnqueue !== failureGeneration.current || request !== sequence.current) return false;
      const snapshot = current.current.values;
      const settings: ManagedSettings = { ...snapshot, lastAiSelection: snapshot.lastAiSelection ?? null, settingsVersion: 1 };
      try {
        const response = normalizeManagedSettings(await invoke<unknown>('save_managed_settings', { settings, revision: current.current.revision }));
        if (!response.hasSettings || response.settings.settingsVersion !== 1) throw new Error('managed settings were not persisted');
        migrated.current = true;
        current.current = { values: current.current.values, revision: response.revision };
        setAuthoritative(true);
        return true;
      } catch (reason) {
        failureGeneration.current += 1;
        let restored = current.current.values;
        try {
          const response = normalizeManagedSettings(await invoke<unknown>('load_managed_settings'));
          restored = effectiveManagedSettings(response, migrated.current ? appGlobalsFromStored(loadStoredSettings(null)) : legacy);
          current.current = { values: restored, revision: response.revision };
          setAuthoritative(response.settings.settingsVersion === 1 || migrated.current);
          setWritesEnabled(false);
          writesEnabledRef.current = false;
        } catch { setWritesEnabled(false); writesEnabledRef.current = false; }
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
  }, [legacy]);

  const disableWrites = useCallback(() => { writesEnabledRef.current = false; setWritesEnabled(false); }, []);
  const settle = useCallback(() => queue.current.then(() => undefined), []);
  return { values, ready, authoritative, saving, writesEnabled, load, save, disableWrites, settle };
}
