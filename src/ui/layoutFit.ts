import type { TabPlacement } from '../crt/settings';

export interface LayoutFitParams {
  windowWidth: number;
  windowHeight: number;
  resolutionId: string;
  resolutionWidth?: number;
  resolutionHeight?: number;
  tabPlacement: TabPlacement;
  tabSpace?: number;
  settingsScale?: number;
  aiVisible: boolean;
  settingsVisible: boolean;
  measuredTerminalWidth?: number;
}

export const AI_PANEL_WIDTH = 360;
export const SETTINGS_PANEL_BASE_WIDTH = 320;
export const APP_SHELL_GAP = 18;
export const APP_SHELL_PADDING_H = 36; // 18px left + 18px right
export const APP_SHELL_PADDING_V = 36; // 100vh - 36px vertical constraint

/**
 * Determines whether opening side panels (AI Assist and/or Settings) can fit in the
 * available horizontal space to the side of the centered virtual terminal screen without
 * needing to shift or resize the terminal display.
 */
export function canPanelsFitWithoutShift({
  windowWidth,
  windowHeight,
  resolutionId,
  resolutionWidth,
  resolutionHeight,
  tabPlacement,
  tabSpace = 36,
  settingsScale = 1,
  aiVisible,
  settingsVisible,
  measuredTerminalWidth,
}: LayoutFitParams): boolean {
  if (!aiVisible && !settingsVisible) return false;
  if (resolutionId === 'physical') return false;
  if (windowWidth <= 850) return false;

  let totalPanelsWidth = 0;
  if (aiVisible && settingsVisible) {
    totalPanelsWidth =
      AI_PANEL_WIDTH + APP_SHELL_GAP + SETTINGS_PANEL_BASE_WIDTH * settingsScale;
  } else if (aiVisible) {
    totalPanelsWidth = AI_PANEL_WIDTH;
  } else if (settingsVisible) {
    totalPanelsWidth = SETTINGS_PANEL_BASE_WIDTH * settingsScale;
  }

  if (totalPanelsWidth <= 0) return false;

  const contentWidth = Math.max(0, windowWidth - APP_SHELL_PADDING_H);

  let terminalWidth: number;
  if (measuredTerminalWidth && measuredTerminalWidth > 0) {
    terminalWidth = measuredTerminalWidth;
  } else {
    const tabHeight = tabPlacement === 'top' ? (tabSpace || 36) : 0;
    const availableHeight = Math.max(0, windowHeight - APP_SHELL_PADDING_V - tabHeight);
    const ratio =
      resolutionWidth && resolutionHeight
        ? resolutionWidth / resolutionHeight
        : 4 / 3;

    const naturalWidth = Math.round(availableHeight * ratio);
    const maxAllowedWidth =
      tabPlacement === 'left'
        ? Math.max(0, contentWidth - 2 * tabSpace)
        : contentWidth;

    terminalWidth = Math.max(
      0,
      Math.min(contentWidth, naturalWidth, maxAllowedWidth),
    );
  }

  // Actual space between centered terminal right edge and the right edge of the window
  const spaceRight = (windowWidth - terminalWidth) / 2;

  // The panel fits without shifting the terminal if the available space
  // on the right side of the centered terminal is at least the width of the panels.
  return spaceRight >= totalPanelsWidth;
}
