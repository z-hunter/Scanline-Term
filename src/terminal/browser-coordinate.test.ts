import { describe, expect, it } from 'vitest';
import { browserViewportPoint } from './browser-coordinate';

describe('browserViewportPoint', () => {
  it('maps CRT points into the outer browser viewport with a visible 24px frame difference', () => {
    const source = { width: 1600, height: 1200 };
    const viewport = { width: 124, height: 104 };

    expect(browserViewportPoint({ x: 32, y: 24 }, source, viewport)).toEqual({ x: 2.48, y: 2.08 });
    expect(browserViewportPoint({ x: 800, y: 600 }, source, viewport)).toEqual({ x: 62, y: 52 });
    expect(browserViewportPoint({ x: 1568, y: 1176 }, source, viewport)).toEqual({ x: 121.52, y: 101.92 });
    expect(browserViewportPoint({ x: 50, y: 40 }, { width: 100, height: 80 }, { width: 100, height: 80 })).toEqual({ x: 50, y: 40 });
    expect(browserViewportPoint({ x: 50, y: 40 }, { width: 100, height: 80 }, viewport)).toEqual({ x: 62, y: 52 });
    expect(browserViewportPoint({ x: -1, y: 1210 }, source, viewport)).toEqual({ x: 0, y: 104 });
  });
});
