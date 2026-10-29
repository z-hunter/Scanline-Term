export type ManagedSettings = {
  defaultPreset: string | null;
  smoothScrollback: boolean | null;
};

export type ManagedSettingsResponse = {
  settings: ManagedSettings;
  revision: string;
  path: string;
  hasSettings: boolean;
};

export class LatestSettingsRequest {
  private generation = 0;

  begin(): number { return ++this.generation; }
  invalidate(): void { this.generation += 1; }
  isCurrent(request: number): boolean { return request === this.generation; }
}

export async function loadAndCommitLatest<T>(
  guard: LatestSettingsRequest,
  request: number,
  load: () => Promise<T>,
  commit: (value: T) => Promise<void> | void,
): Promise<boolean> {
  const value = await load();
  if (!guard.isCurrent(request)) return false;
  await commit(value);
  return guard.isCurrent(request);
}

export function normalizeManagedSettings(value: unknown): ManagedSettingsResponse {
  if (!value || typeof value !== 'object') throw new Error('invalid managed settings response');
  const response = value as Partial<ManagedSettingsResponse>;
  if (!response.settings || typeof response.settings !== 'object' || typeof response.revision !== 'string' || typeof response.path !== 'string' || typeof response.hasSettings !== 'boolean') {
    throw new Error('invalid managed settings response');
  }
  const settings = response.settings as Partial<ManagedSettings>;
  return {
    settings: {
      defaultPreset: typeof settings.defaultPreset === 'string' && settings.defaultPreset.length > 0 ? settings.defaultPreset : null,
      smoothScrollback: typeof settings.smoothScrollback === 'boolean' ? settings.smoothScrollback : null,
    },
    revision: response.revision,
    path: response.path,
    hasSettings: response.hasSettings,
  };
}

export function effectiveManagedSettings(response: ManagedSettingsResponse, legacySmoothScrollback: boolean, legacyValueAvailable = true) {
  return {
    defaultPreset: response.hasSettings ? response.settings.defaultPreset ?? 'default' : 'default',
    smoothScrollback: response.hasSettings ? response.settings.smoothScrollback ?? true : legacyValueAvailable ? legacySmoothScrollback : true,
  };
}
