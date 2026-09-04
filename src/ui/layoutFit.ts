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

  const neededSpace = totalPanelsWidth + APP_SHELL_GAP;
  const contentWidth = Math.max(0, windowWidth - APP_SHELL_PADDING_H);
  const availableHeight = Math.max(0, windowHeight - APP_SHELL_PADDING_V);

  const ratio =
    resolutionWidth && resolutionHeight
      ? resolutionWidth / resolutionHeight
      : 4 / 3;

  const naturalWidth = Math.round(availableHeight * ratio);
  const maxAllowedWidth =
    tabPlacement === 'left'
      ? Math.max(0, contentWidth - 2 * tabSpace)
      : contentWidth;

  const undisturbedTerminalWidth = Math.max(
    0,
    Math.min(contentWidth, naturalWidth, maxAllowedWidth),
  );

  const spaceRight = (contentWidth - undisturbedTerminalWidth) / 2;

  const tabsSpaceRight =
    tabPlacement === 'top'
      ? (contentWidth - Math.min(contentWidth, 980)) / 2
      : spaceRight;

  const effectiveSpaceRight = Math.min(spaceRight, tabsSpaceRight);

  return effectiveSpaceRight >= neededSpace;
}
