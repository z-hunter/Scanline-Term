import type { IBufferCell, Terminal } from '@xterm/xterm';
import type { CRTColorMode } from 'scanline-virtual-screen/core';
import { profileColor, remapLegacyRgb, type TerminalColorProfile } from 'scanline-virtual-screen/core';

export type TabColor = { background: string; foreground: string };
function rgb(value: string): [number, number, number] { return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16)]; }
function cellColor(cell: IBufferCell, foreground: boolean, profile: TerminalColorProfile): string {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return remapLegacyRgb(profile, `#${value.toString(16).padStart(6, '0')}`);
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return profileColor(profile, value);
  return foreground ? profile.foreground : profile.background;
}
export function applyTabColorMode(color: string, mode: CRTColorMode, backgroundDesaturation = 0.5): string {
  if (mode === 'color') return color;
  const [red, green, blue] = rgb(color); const luma = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
  const tint: Record<string, number[]> = { bw: [1, 1, 1], green: [.45, 1, .62], 'green-p39': [.25, 1, .15], amber: [1.1, .68, .2], blue: [.42, .72, 1] };
  const desaturation = Math.min(1, Math.max(0, backgroundDesaturation));
  const channels = (tint[mode] ?? [1, 1, 1]).map((channel) => Math.round(Math.min(1, luma * channel * (1 - desaturation) + luma * desaturation) * 255));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
export function terminalAverageColor(terminal: Terminal, profile: TerminalColorProfile, colorMode: CRTColorMode = 'color', backgroundDesaturation = 0.5): TabColor {
  const buffer = terminal.buffer.active; const cell = buffer.getNullCell(); const total = [0, 0, 0]; let count = 0;
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row); if (!line) continue;
    for (let column = 0; column < terminal.cols; column += 1) {
      const current = line.getCell(column, cell); if (!current) continue;
      let bg = rgb(cellColor(current, false, profile)); let fg = rgb(cellColor(current, true, profile)); if (current.isInverse()) [bg, fg] = [fg, bg];
      const ink = current.getChars() ? .22 : 0; for (let channel = 0; channel < 3; channel += 1) total[channel] += bg[channel] * (1 - ink) + fg[channel] * ink; count += 1;
    }
  }
  const average = total.map((channel) => Math.round(channel / Math.max(1, count))); const background = applyTabColorMode(`#${average.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`, colorMode, backgroundDesaturation); const [red, green, blue] = rgb(background); const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return { background, foreground: luminance > 145 ? '#101a14' : '#d7f5df' };
}
