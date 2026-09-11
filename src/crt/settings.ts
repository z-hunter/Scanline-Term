import type { BezelGlowMode, BloomAlgorithm, CRTColorMode, CRTMaskType, CRTSettings, CursorStyle } from './CRTFilter';
import { DEFAULT_COLOR_PROFILE_ID, isColorProfile } from '../terminal-color-profiles';

export const DEFAULT_CRT_SETTINGS: Readonly<CRTSettings> = Object.freeze({
  crtEmulation: true,
  colorProfile: DEFAULT_COLOR_PROFILE_ID,
  consoleFont: 'Consolas',
  consoleFontSize: 16,
  curvature: 0.13,
  scanlineCount: 120,
  scanlineIntensity: 0.5,
  aberration: 0,
  vignette: 0.5,
  phosphor: 1,
  bezelGlow: true,
  bezelGlowMode: 'spill',
  showBezel: false,
  bloom: 0.1,
  bloomAlgorithm: 'spiral',
  glow: 1,
  persistence: 0.9,
  persistenceIntensity: 1.8,
  imageBrightness: 1,
  imageContrast: 1,
  backgroundDesaturation: 0.5,
  beamModulation: 0.5,
  breathing: 1,
  ambientGlassLight: 0,
  bezelHighlight: 0.35,
  bezelThickness: 0,
  imperfectSignal: 0,
  humBar: 0,
  channelSwitchEffect: true,
  antiAliasedPixels: true,
  colorMode: 'color',
  maskType: 'off',
  maskStrength: 0.3,
  cursorStyle: 'block',
});

export const RESOLUTIONS = [
  { id: 'physical', label: 'Physical Window — fill available space' },
  { id: 'physical-4x3', label: 'Physical 4:3 — window pixels', width: 4, height: 3 },
  { id: 'physical-8x5', label: 'Physical 8:5 — window pixels', width: 8, height: 5 },
  { id: '420x300', label: 'VGA-X — 420×300 (14:10)', width: 420, height: 300 },
  { id: '640x480', label: 'VGA — 640×480 (4:3)', width: 640, height: 480 },
  { id: '800x600', label: 'SVGA — 800×600 (4:3)', width: 800, height: 600 },
  { id: '1024x768', label: 'XGA — 1024×768 (4:3)', width: 1024, height: 768 },
  { id: '1280x800', label: '1280×800 (16:10)', width: 1280, height: 800 },
] as const;

export type ResolutionId = (typeof RESOLUTIONS)[number]['id'];
export type TabPlacement = 'top' | 'left';

export const DEFAULT_RESOLUTION: ResolutionId = '1024x768';

export type StoredSettings = {
  version: 1;
  resolution: ResolutionId;
  tabPlacement: TabPlacement;
  hideTabsWhenSingleSession: boolean;
  globalHotkeyEnabled: boolean;
  autoUpdateEnabled: boolean;
  settingsScale: number;
  showSettingsPanel: boolean;
  showAiPanel: boolean;
  defaultShell: string;
  crt: CRTSettings;
};

const numericRanges = {
  consoleFontSize: [6, 32],
  curvature: [0, 0.5],
  scanlineCount: [0, 768],
  scanlineIntensity: [0, 1],
  aberration: [0, 5],
  vignette: [0, 1],
  phosphor: [0, 1],
  bloom: [0, 1],
  glow: [0, 2],
  persistence: [0, 1],
  persistenceIntensity: [0, 4],
  imageBrightness: [0.5, 1.5],
  imageContrast: [0.5, 1.5],
  backgroundDesaturation: [0, 1],
  beamModulation: [0, 1],
  breathing: [0, 1],
  ambientGlassLight: [0, 1],
  bezelHighlight: [0, 1],
  bezelThickness: [0, 10],
  imperfectSignal: [0, 1],
  humBar: [0, 1],
  maskStrength: [0, 1],
} as const;

const isResolution = (value: unknown): value is ResolutionId =>
  RESOLUTIONS.some((resolution) => resolution.id === value);

const isColorMode = (value: unknown): value is CRTColorMode =>
  value === 'color' || value === 'bw' || value === 'green' || value === 'amber' || value === 'blue';
const isMaskType = (value: unknown): value is CRTMaskType =>
  value === 'off' || value === 'aperture' || value === 'slot' || value === 'shadow';

const isBloomAlgorithm = (value: unknown): value is BloomAlgorithm => value === 'soft' || value === 'spiral';
const isBezelGlowMode = (value: unknown): value is BezelGlowMode => value === 'spill' || value === 'reflection';

const isCursorStyle = (value: unknown): value is CursorStyle =>
  value === 'block' || value === 'underline' || value === 'bar';

const numberInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function loadStoredSettings(raw: string | null): StoredSettings {
  const result: StoredSettings = {
    version: 1,
    resolution: DEFAULT_RESOLUTION,
    tabPlacement: 'top',
    hideTabsWhenSingleSession: false,
    globalHotkeyEnabled: true,
    autoUpdateEnabled: true,
    settingsScale: 0.9,
    showSettingsPanel: false,
    showAiPanel: false,
    defaultShell: '',
    crt: { ...DEFAULT_CRT_SETTINGS },
  };
  if (!raw) return result;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return result;
    const value = parsed as {
      resolution?: unknown;
      tabPlacement?: unknown;
      hideTabsWhenSingleSession?: unknown;
      globalHotkeyEnabled?: unknown;
      autoUpdateEnabled?: unknown;
      settingsScale?: unknown;
      showSettingsPanel?: unknown;
      showAiPanel?: unknown;
      defaultShell?: unknown;
      crt?: Record<string, unknown>;
    };
    if (isResolution(value.resolution)) result.resolution = value.resolution;
    if (value.tabPlacement === 'top' || value.tabPlacement === 'left') result.tabPlacement = value.tabPlacement;
    if (typeof value.hideTabsWhenSingleSession === 'boolean') result.hideTabsWhenSingleSession = value.hideTabsWhenSingleSession;
    if (typeof value.globalHotkeyEnabled === 'boolean') result.globalHotkeyEnabled = value.globalHotkeyEnabled;
    if (typeof value.autoUpdateEnabled === 'boolean') result.autoUpdateEnabled = value.autoUpdateEnabled;
    if (numberInRange(value.settingsScale, 0.75, 1.5)) result.settingsScale = value.settingsScale;
    if (typeof value.showSettingsPanel === 'boolean') result.showSettingsPanel = value.showSettingsPanel;
    if (typeof value.showAiPanel === 'boolean') result.showAiPanel = value.showAiPanel;
    if (typeof value.defaultShell === 'string' && value.defaultShell.length <= 1024) result.defaultShell = value.defaultShell;
    if (!value.crt || typeof value.crt !== 'object') return result;

    for (const [key, range] of Object.entries(numericRanges)) {
      const candidate = value.crt[key];
      if (numberInRange(candidate, range[0], range[1])) {
        result.crt[key as keyof typeof numericRanges] = candidate as never;
      }
    }
    if (typeof value.crt.bezelGlow === 'boolean') result.crt.bezelGlow = value.crt.bezelGlow;
    if (isBezelGlowMode(value.crt.bezelGlowMode)) result.crt.bezelGlowMode = value.crt.bezelGlowMode;
    if (typeof value.crt.showBezel === 'boolean') result.crt.showBezel = value.crt.showBezel;
    if (typeof value.crt.crtEmulation === 'boolean') result.crt.crtEmulation = value.crt.crtEmulation;
    if (typeof value.crt.channelSwitchEffect === 'boolean') result.crt.channelSwitchEffect = value.crt.channelSwitchEffect;
    if (value.crt.colorProfile === 'zx-spectrum' || value.crt.colorProfile === 'retrowave') result.crt.colorProfile = 'cyberpunk';
    else if (isColorProfile(value.crt.colorProfile)) result.crt.colorProfile = value.crt.colorProfile;
    if (typeof value.crt.consoleFont === 'string' && value.crt.consoleFont.length > 0 && value.crt.consoleFont.length <= 128) {
      result.crt.consoleFont = value.crt.consoleFont;
    }
    if (typeof value.crt.antiAliasedPixels === 'boolean') {
      result.crt.antiAliasedPixels = value.crt.antiAliasedPixels;
    }
    if (isColorMode(value.crt.colorMode)) result.crt.colorMode = value.crt.colorMode;
    if (isMaskType(value.crt.maskType)) result.crt.maskType = value.crt.maskType;
    if (isBloomAlgorithm(value.crt.bloomAlgorithm)) result.crt.bloomAlgorithm = value.crt.bloomAlgorithm;
    if (isCursorStyle(value.crt.cursorStyle)) result.crt.cursorStyle = value.crt.cursorStyle;
  } catch {
    // Corrupt localStorage must never prevent the demo from starting.
  }
  return result;
}
