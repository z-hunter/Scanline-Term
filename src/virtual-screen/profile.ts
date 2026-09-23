import type { CRTSettings, CursorStyle } from '../crt/CRTFilter';
import { DEFAULT_CRT_SETTINGS } from './defaults';
import { isColorProfile, type ColorProfileId } from '../terminal-color-profiles';

type TerminalKeys = 'colorProfile' | 'consoleFont' | 'fallbackFont' | 'consoleFontSize' | 'cellWidthAdjustment' | 'cellHeightAdjustment' | 'cursorStyle' | 'cursorBrightness';

export type TerminalSettings = {
  colorProfile: ColorProfileId;
  fontFamily: string;
  fallbackFont?: string;
  fontSize: number;
  cellWidthAdjustment: number;
  cellHeightAdjustment: number;
  cursorStyle: CursorStyle;
  cursorBrightness: number;
};

export type CRTVisualSettings = Omit<CRTSettings, TerminalKeys>;

export type ScreenProfile = {
  schemaVersion: 1;
  virtualScreen: { modeId: string };
  terminal: TerminalSettings;
  crt: CRTVisualSettings;
};

export type ScreenMode = { id: string; label?: string; width?: number; height?: number };

export type RenderSettings = CRTVisualSettings & {
  colorProfile: ColorProfileId;
  consoleFont: string;
  fallbackFont?: string;
  consoleFontSize: number;
  cellWidthAdjustment: number;
  cellHeightAdjustment: number;
  cursorStyle: CursorStyle;
  cursorBrightness: number;
};

const terminalKeys = new Set<TerminalKeys>([
  'colorProfile', 'consoleFont', 'fallbackFont', 'consoleFontSize', 'cellWidthAdjustment',
  'cellHeightAdjustment', 'cursorStyle', 'cursorBrightness',
]);

export function profileToRenderSettings(profile: ScreenProfile): RenderSettings {
  return {
    ...profile.crt,
    colorProfile: profile.terminal.colorProfile,
    consoleFont: profile.terminal.fontFamily,
    fallbackFont: profile.terminal.fallbackFont,
    consoleFontSize: profile.terminal.fontSize,
    cellWidthAdjustment: profile.terminal.cellWidthAdjustment,
    cellHeightAdjustment: profile.terminal.cellHeightAdjustment,
    cursorStyle: profile.terminal.cursorStyle,
    cursorBrightness: profile.terminal.cursorBrightness,
  };
}

export function profileFromRenderSettings(settings: RenderSettings, modeId: string): ScreenProfile {
  const crt = { ...settings } as Record<string, unknown>;
  for (const key of terminalKeys) delete crt[key];
  return {
    schemaVersion: 1,
    virtualScreen: { modeId },
    terminal: {
      colorProfile: settings.colorProfile,
      fontFamily: settings.consoleFont,
      fallbackFont: settings.fallbackFont,
      fontSize: settings.consoleFontSize,
      cellWidthAdjustment: settings.cellWidthAdjustment,
      cellHeightAdjustment: settings.cellHeightAdjustment,
      cursorStyle: settings.cursorStyle,
      cursorBrightness: settings.cursorBrightness,
    },
    crt: crt as CRTVisualSettings,
  };
}

export function defaultScreenProfile(modeId = '1024x768'): ScreenProfile {
  return profileFromRenderSettings(DEFAULT_CRT_SETTINGS, modeId);
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) ? numberValue(value, fallback, min, max) : fallback;
}

const ranges: Record<string, [number, number]> = {
  curvature: [0, .5], scanlineCount: [0, 768], scanlineIntensity: [0, 1], aberration: [0, 5], aberrationFalloff: [1, 4],
  vignette: [0, 1], phosphor: [0, 1], bloom: [0, 1], glow: [0, 2], glowRadius: [1, 6], persistence: [0, 1],
  persistenceEnergy: [0, .5], persistenceIntensity: [0, 4], imageBrightness: [.5, 1.5], imageContrast: [.5, 1.5],
  backgroundDesaturation: [0, 1], beamModulation: [0, 1], breathing: [0, 1], ambientGlassLight: [0, 1], bezelHighlight: [0, 1],
  bezelThickness: [0, 10], reflexBar: [0, 1], reflexBarPosY: [0, .5], reflexBarWidth: [.95, 1], reflexBarHeight: [.05, .6],
  imperfectSignal: [0, 1], humBar: [0, 1], maskStrength: [0, 1],
};

function normalizeRenderSettings(source: Record<string, unknown>, fallback: RenderSettings): RenderSettings {
  const result = { ...fallback };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const current = result[key as keyof RenderSettings];
    const value = key === 'scanlineCount' || key === 'bezelThickness'
      ? integerValue(source[key], current as number, min, max)
      : numberValue(source[key], current as number, min, max);
    (result as Record<string, unknown>)[key] = value;
  }
  for (const key of ['bezelGlow', 'showBezel', 'reflexBarEnabled', 'channelSwitchEffect', 'antiAliasedPixels'] as const) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  if (source.bezelGlowMode === 'spill' || source.bezelGlowMode === 'reflection') result.bezelGlowMode = source.bezelGlowMode;
  if (source.colorMode === 'color' || source.colorMode === 'bw' || source.colorMode === 'green' || source.colorMode === 'green-p39' || source.colorMode === 'amber' || source.colorMode === 'blue') result.colorMode = source.colorMode;
  if (source.maskType === 'off' || source.maskType === 'aperture' || source.maskType === 'slot' || source.maskType === 'shadow') result.maskType = source.maskType;
  if (source.bloomAlgorithm === 'soft' || source.bloomAlgorithm === 'spiral') result.bloomAlgorithm = source.bloomAlgorithm;
  if (typeof source.crtEmulation === 'boolean') result.crtEmulation = source.crtEmulation;
  return result;
}

function normalizeTerminalSettings(source: Record<string, unknown>, fallback: TerminalSettings): TerminalSettings {
  const color = source.colorProfile === 'zx-spectrum' || source.colorProfile === 'retrowave' ? 'cyberpunk' : source.colorProfile;
  const result = { ...fallback };
  if (isColorProfile(color)) result.colorProfile = color;
  const font = source.fontFamily ?? source.consoleFont;
  if (typeof font === 'string' && font.length > 0 && font.length <= 128) result.fontFamily = font;
  const fallbackFont = source.fallbackFont ?? source.FallbackFont;
  if (typeof fallbackFont === 'string' && fallbackFont.trim().length <= 128) result.fallbackFont = fallbackFont.trim() || undefined;
  result.fontSize = integerValue(source.fontSize ?? source.consoleFontSize, result.fontSize, 6, 32);
  result.cellWidthAdjustment = integerValue(source.cellWidthAdjustment, result.cellWidthAdjustment, -8, 16);
  result.cellHeightAdjustment = integerValue(source.cellHeightAdjustment, result.cellHeightAdjustment, -8, 16);
  if (source.cursorStyle === 'block' || source.cursorStyle === 'underline' || source.cursorStyle === 'bar') result.cursorStyle = source.cursorStyle;
  result.cursorBrightness = numberValue(source.cursorBrightness, result.cursorBrightness, 0, 1);
  return result;
}

export function normalizeProfile(input: unknown, fallback: ScreenProfile = defaultScreenProfile(), availableModes: readonly ScreenMode[] = []): ScreenProfile | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const legacy = value.version === 1 && typeof value.resolution === 'string' && value.crt && typeof value.crt === 'object' && !Array.isArray(value.crt);
  const current = value.schemaVersion === 1 && value.virtualScreen && typeof value.virtualScreen === 'object' && !Array.isArray(value.virtualScreen) && value.terminal && typeof value.terminal === 'object' && !Array.isArray(value.terminal) && value.crt && typeof value.crt === 'object' && !Array.isArray(value.crt);
  if (!legacy && !current) return null;
  const sourceCrt = value.crt as Record<string, unknown>;
  const sourceTerminal = (current ? value.terminal : sourceCrt) as Record<string, unknown>;
  const requestedMode = current ? (value.virtualScreen as Record<string, unknown>).modeId : value.resolution;
  const fallbackMode = availableModes.find((mode) => mode.id === fallback.virtualScreen.modeId)?.id ?? availableModes[0]?.id ?? fallback.virtualScreen.modeId;
  const allowed = availableModes.length === 0 || availableModes.some((mode) => mode.id === requestedMode);
  const modeId = allowed && typeof requestedMode === 'string' ? requestedMode : fallbackMode;
  const render = normalizeRenderSettings(sourceCrt, profileToRenderSettings(fallback));
  const terminal = normalizeTerminalSettings(sourceTerminal, fallback.terminal);
  return profileFromRenderSettings({ ...render, ...terminalToRender(terminal) }, modeId);
}

function terminalToRender(terminal: TerminalSettings): Pick<RenderSettings, TerminalKeys> {
  return {
    colorProfile: terminal.colorProfile,
    consoleFont: terminal.fontFamily,
    fallbackFont: terminal.fallbackFont,
    consoleFontSize: terminal.fontSize,
    cellWidthAdjustment: terminal.cellWidthAdjustment,
    cellHeightAdjustment: terminal.cellHeightAdjustment,
    cursorStyle: terminal.cursorStyle,
    cursorBrightness: terminal.cursorBrightness,
  };
}

export function profileToJSON(profile: ScreenProfile): string { return JSON.stringify(profile); }

export type LegacyPreset = { version: 1; resolution: string; crt: CRTSettings };

export function profileFromLegacyPreset(preset: LegacyPreset, availableModes: readonly ScreenMode[] = []): ScreenProfile {
  return normalizeProfile(preset, defaultScreenProfile(preset.resolution), availableModes) ?? defaultScreenProfile(preset.resolution);
}

export function legacyPresetFromProfile(profile: ScreenProfile): LegacyPreset {
  const settings = profileToRenderSettings(profile);
  return { version: 1, resolution: profile.virtualScreen.modeId, crt: settings };
}
