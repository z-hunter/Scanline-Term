import { describe, expect, it } from 'vitest';
import { canPanelsFitWithoutShift } from './layoutFit';

describe('canPanelsFitWithoutShift', () => {
  it('returns false when no panels are visible', () => {
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 2560,
        windowHeight: 1440,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'top',
        aiVisible: false,
        settingsVisible: false,
      }),
    ).toBe(false);
  });

  it('returns false for physical window resolution mode', () => {
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 3840,
        windowHeight: 1600,
        resolutionId: 'physical',
        tabPlacement: 'top',
        aiVisible: true,
        settingsVisible: false,
      }),
    ).toBe(false);
  });

  it('returns false when window width is at or below 850px breakpoint', () => {
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 850,
        windowHeight: 900,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'top',
        aiVisible: false,
        settingsVisible: true,
      }),
    ).toBe(false);
  });

  it('returns true when window is wide enough for settings panel without shifting terminal', () => {
    // Ultrawide window: 2560x1080, 4:3 resolution
    // availableHeight = 1044, naturalWidth = 1044 * 4/3 = 1392
    // contentWidth = 2524, undisturbedWidth = 1392
    // spaceRight = (2524 - 1392) / 2 = 566px
    // neededSpace for Settings = 320 + 18 = 338px
    // 566 >= 338 -> true
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 2560,
        windowHeight: 1080,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'top',
        aiVisible: false,
        settingsVisible: true,
      }),
    ).toBe(true);
  });

  it('returns false when window is too narrow for settings panel to fit without shifting', () => {
    // 1440x960, 4:3 resolution
    // availableHeight = 924, naturalWidth = 1232
    // contentWidth = 1404, spaceRight = (1404 - 1232) / 2 = 86px
    // neededSpace for Settings = 338px
    // 86 < 338 -> false
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 1440,
        windowHeight: 960,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'top',
        aiVisible: false,
        settingsVisible: true,
      }),
    ).toBe(false);
  });

  it('correctly handles both AI and Settings panels open simultaneously', () => {
    // Window 3440x1440:
    // availableHeight = 1404, naturalWidth = 1404 * 4/3 = 1872
    // contentWidth = 3404, spaceRight = (3404 - 1872) / 2 = 766px
    // neededSpace for both = 360 + 18 + 320 + 18 = 716px
    // 766 >= 716 -> true
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 3440,
        windowHeight: 1440,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'top',
        aiVisible: true,
        settingsVisible: true,
      }),
    ).toBe(true);

    // If window is 2560x1440:
    // contentWidth = 2524, spaceRight = 326px
    // neededSpace for both is 716px -> 326 < 716 -> false
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 2560,
        windowHeight: 1440,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'top',
        aiVisible: true,
        settingsVisible: true,
      }),
    ).toBe(false);
  });

  it('respects settingsScale when computing required panel width', () => {
    // Window 2560x1080: spaceRight is 566px
    // With settingsScale = 1: neededSpace is 338px -> fits
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 2560,
        windowHeight: 1080,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'top',
        settingsScale: 1,
        aiVisible: false,
        settingsVisible: true,
      }),
    ).toBe(true);

    // With settingsScale = 2: neededSpace is 320 * 2 + 18 = 658px
    // 566 < 658 -> does not fit
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 2560,
        windowHeight: 1080,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'top',
        settingsScale: 2,
        aiVisible: false,
        settingsVisible: true,
      }),
    ).toBe(false);
  });

  it('handles left tab placement', () => {
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 2560,
        windowHeight: 1080,
        resolutionId: '640x480',
        resolutionWidth: 640,
        resolutionHeight: 480,
        tabPlacement: 'left',
        tabSpace: 50,
        aiVisible: false,
        settingsVisible: true,
      }),
    ).toBe(true);
  });
});
