import type { CRTColorMode, CRTSettings } from './CRTFilter';

export const DEFAULT_CRT_SETTINGS: Readonly<CRTSettings> = Object.freeze({
  curvature: 0.16,
  scanlineCount: 200,
  scanlineIntensity: 0.4,
  aberration: 0.2,
  vignette: 0.9,
  phosphor: 1,
  bezelGlow: true,
  bloom: 0.05,
  glow: 0.2,
  persistence: 0,
  persistenceIntensity: 1,
  beamModulation: 0,
  breathing: 0,
  antiAliasedPixels: true,
  colorMode: 'color',
});

export const RESOLUTIONS = [
  { id: '320x240', label: 'QVGA — 320×240', width: 320, height: 240 },
  { id: '640x480', label: 'VGA — 640×480', width: 640, height: 480 },
  { id: '800x600', label: 'SVGA — 800×600', width: 800, height: 600 },
  { id: '1024x768', label: 'XGA — 1024×768', width: 1024, height: 768 },
] as const;

export type ResolutionId = (typeof RESOLUTIONS)[number]['id'];

export const DEFAULT_RESOLUTION: ResolutionId = '640x480';

export type StoredSettings = {
  version: 1;
  resolution: ResolutionId;
  crt: CRTSettings;
};

const numericRanges = {
  curvature: [0, 0.5],
  scanlineCount: [0, 768],
  scanlineIntensity: [0, 1],
  aberration: [0, 5],
  vignette: [0, 1],
  phosphor: [0, 1],
  bloom: [0, 1],
  glow: [0, 1],
  persistence: [0, 1],
  persistenceIntensity: [0, 4],
  beamModulation: [0, 1],
  breathing: [0, 1],
} as const;

const isResolution = (value: unknown): value is ResolutionId =>
  RESOLUTIONS.some((resolution) => resolution.id === value);

const isColorMode = (value: unknown): value is CRTColorMode =>
  value === 'color' || value === 'bw' || value === 'green' || value === 'amber' || value === 'blue';

const numberInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function loadStoredSettings(raw: string | null): StoredSettings {
  const result: StoredSettings = {
    version: 1,
    resolution: DEFAULT_RESOLUTION,
    crt: { ...DEFAULT_CRT_SETTINGS },
  };
  if (!raw) return result;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return result;
    const value = parsed as { resolution?: unknown; crt?: Record<string, unknown> };
    if (isResolution(value.resolution)) result.resolution = value.resolution;
    if (!value.crt || typeof value.crt !== 'object') return result;

    for (const [key, range] of Object.entries(numericRanges)) {
      const candidate = value.crt[key];
      if (numberInRange(candidate, range[0], range[1])) {
        result.crt[key as keyof typeof numericRanges] = candidate as never;
      }
    }
    if (typeof value.crt.bezelGlow === 'boolean') result.crt.bezelGlow = value.crt.bezelGlow;
    if (typeof value.crt.antiAliasedPixels === 'boolean') {
      result.crt.antiAliasedPixels = value.crt.antiAliasedPixels;
    }
    if (isColorMode(value.crt.colorMode)) result.crt.colorMode = value.crt.colorMode;
  } catch {
    // Corrupt localStorage must never prevent the demo from starting.
  }
  return result;
}
