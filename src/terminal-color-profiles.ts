export const COLOR_PROFILE_IDS = ['dos-vga', 'windows-legacy', 'windows-campbell', 'xterm-x11', 'solarized-dark', 'ibm-3279', 'commodore-64', 'retrowave'] as const;

export type ColorProfileId = (typeof COLOR_PROFILE_IDS)[number];

export type TerminalColorProfile = {
  id: ColorProfileId;
  label: string;
  foreground: string;
  background: string;
  cursor?: string;
  colors: string[];
};

const xtermCube = (): string[] => {
  const colors: string[] = [];
  const level = [0, 95, 135, 175, 215, 255];
  for (let index = 16; index < 232; index += 1) {
    const color = index - 16;
    colors.push(`rgb(${level[Math.floor(color / 36)]} ${level[Math.floor(color / 6) % 6]} ${level[color % 6]})`);
  }
  for (let index = 232; index < 256; index += 1) {
    const gray = 8 + (index - 232) * 10;
    colors.push(`rgb(${gray} ${gray} ${gray})`);
  }
  return colors;
};

const xtermExtended = xtermCube();

const profiles: TerminalColorProfile[] = [
  {
    id: 'dos-vga', label: 'DOS VGA', foreground: '#aaaaaa', background: '#000000',
    colors: ['#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa', '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff'],
  },
  {
    id: 'windows-legacy', label: 'Windows Legacy', foreground: '#c0c0c0', background: '#000000',
    colors: ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0', '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'],
  },
  {
    id: 'windows-campbell', label: 'Windows Campbell', foreground: '#cccccc', background: '#0c0c0c',
    colors: ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc', '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2'],
  },
  {
    id: 'xterm-x11', label: 'xterm / X11', foreground: '#e5e5e5', background: '#000000',
    colors: ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff', ...xtermExtended],
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark', foreground: '#839496', background: '#002b36',
    colors: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
  },
  {
    id: 'ibm-3279', label: 'IBM 3279', foreground: '#00ff00', background: '#000000',
    colors: ['#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff', '#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'],
  },
  {
    id: 'commodore-64', label: 'Commodore 64', foreground: '#5f53fe', background: '#211bae',
    colors: ['#000000', '#be1a24', '#1fd21e', '#dff60a', '#211bae', '#b41ae2', '#30e6c6', '#fdfefc', '#424540', '#fe4a57', '#59fe59', '#b84104', '#5f53fe', '#6a3304', '#70746f', '#a4a7a2'],
  },
  {
    id: 'retrowave', label: 'Retrowave', foreground: '#ffa600', background: '#220036', cursor: '#f949ff',
    colors: ['#580051', '#dc322f', '#ff00f2', '#ff5e00', '#743eca', '#d33682', '#2aa198', '#6a008a', '#59c2ff', '#ff4d00', '#f949ff', '#c20092', '#00d9ff', '#ff00bf', '#e7ffff', '#fdf6e3'],
  },
];

export const DEFAULT_COLOR_PROFILE_ID: ColorProfileId = 'windows-legacy';

export const COLOR_PROFILES = profiles;

export function isColorProfile(value: unknown): value is ColorProfileId {
  return typeof value === 'string' && COLOR_PROFILE_IDS.includes(value as ColorProfileId);
}

export function colorProfile(id: ColorProfileId): TerminalColorProfile {
  return COLOR_PROFILES.find((profile) => profile.id === id) ?? COLOR_PROFILES[1];
}

export function profileColor(profile: TerminalColorProfile, index: number): string {
  return profile.colors[index] ?? xtermExtended[index - 16] ?? profile.background;
}

export function remapLegacyRgb(profile: TerminalColorProfile, color: string): string {
  const legacyIndex = colorProfile('windows-legacy').colors.indexOf(color.toLowerCase());
  return legacyIndex < 0 ? color : profileColor(profile, legacyIndex);
}
