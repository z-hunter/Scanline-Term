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
