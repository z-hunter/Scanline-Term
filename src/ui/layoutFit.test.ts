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
    // availableHeight = 1026, naturalWidth = 1026 * 4/3 = 1368
    // contentWidth = 2524, undisturbedWidth = 1368
    // spaceRight = (2524 - 1368) / 2 = 578px
    // neededSpace for Settings = 320px
    // 578 >= 320 -> true
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
    // availableHeight = 906, naturalWidth = 1208
    // contentWidth = 1404, spaceRight = (1404 - 1208) / 2 = 98px
    // neededSpace for Settings = 320px
    // 98 < 320 -> false
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
    // availableHeight = 1386, naturalWidth = 1386 * 4/3 = 1848
    // contentWidth = 3404, spaceRight = (3404 - 1848) / 2 = 778px
    // neededSpace for both = 360 + 18 + 320 = 698px
    // 778 >= 698 -> true
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
    // neededSpace for both is 698px -> 326 < 698 -> false
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
    // Window 2560x1080: spaceRight is 578px
    // With settingsScale = 1: neededSpace is 320px -> fits
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

    // With settingsScale = 2: neededSpace is 320 * 2 = 640px
    // 578 < 640 -> does not fit
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

  it('uses measuredTerminalWidth when provided', () => {
    // Window width 1920, contentWidth = 1884.
    // If measuredTerminalWidth is 1200:
    // spaceRight = (1884 - 1200) / 2 = 342px.
    // Panel width at 90% scale = 288px.
    // 342 >= 288 -> fits!
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 1920,
        windowHeight: 1080,
        resolutionId: '1024x768',
        resolutionWidth: 1024,
        resolutionHeight: 768,
        tabPlacement: 'top',
        settingsScale: 0.9,
        aiVisible: false,
        settingsVisible: true,
        measuredTerminalWidth: 1200,
      }),
    ).toBe(true);

    // If measuredTerminalWidth is 1400:
    // spaceRight = (1884 - 1400) / 2 = 242px.
    // Panel width 288px.
    // 242 < 288 -> false!
    expect(
      canPanelsFitWithoutShift({
        windowWidth: 1920,
        windowHeight: 1080,
        resolutionId: '1024x768',
        resolutionWidth: 1024,
        resolutionHeight: 768,
        tabPlacement: 'top',
        settingsScale: 0.9,
        aiVisible: false,
        settingsVisible: true,
        measuredTerminalWidth: 1400,
      }),
    ).toBe(false);
  });
});
