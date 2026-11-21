export type BrowserViewportRect = { x: number; y: number; width: number; height: number };

export function browserFullscreenBounds(screen: BrowserViewportRect, panels: BrowserViewportRect[]): BrowserViewportRect {
  let bounds = { ...screen };
  if (screen.width <= 0 || screen.height <= 0) return bounds;
  for (const panel of panels) {
    if (panel.x + panel.width <= bounds.x || panel.x >= bounds.x + bounds.width || panel.y + panel.height <= bounds.y || panel.y >= bounds.y + bounds.height) continue;
    const candidates = [
      { x: bounds.x, y: bounds.y, width: Math.max(0, panel.x - bounds.x), height: bounds.height },
      { x: Math.max(bounds.x, panel.x + panel.width), y: bounds.y, width: Math.max(0, bounds.x + bounds.width - panel.x - panel.width), height: bounds.height },
      { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.max(0, panel.y - bounds.y) },
      { x: bounds.x, y: Math.max(bounds.y, panel.y + panel.height), width: bounds.width, height: Math.max(0, bounds.y + bounds.height - panel.y - panel.height) },
    ];
    bounds = candidates.reduce((best, candidate) =>
      Math.min(candidate.width / screen.width, candidate.height / screen.height) > Math.min(best.width / screen.width, best.height / screen.height) ? candidate : best);
  }
  return bounds;
}

export function browserViewportPoint(
  point: { x: number; y: number },
  source: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(viewport.width, point.x / source.width * viewport.width)),
    y: Math.max(0, Math.min(viewport.height, point.y / source.height * viewport.height)),
  };
}
