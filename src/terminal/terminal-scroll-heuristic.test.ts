import { describe, expect, it } from 'vitest';
import { detectVerticalScroll, inspectVerticalScroll } from './terminal-scroll-heuristic';

describe('terminal scroll heuristic', () => {
  it('accepts an unambiguous shift in either direction', () => {
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F'], ['B', 'C', 'D', 'E', 'F', 'G'])).toMatchObject({ deltaRows: 1, topRow: 0, bottomRow: 6 });
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F'], ['Z', 'A', 'B', 'C', 'D', 'E'])).toMatchObject({ deltaRows: -1, topRow: 0, bottomRow: 6 });
  });
  it('rejects weak evidence and preserves presentation-only changes', () => {
    expect(inspectVerticalScroll(['A', 'B', 'C'], ['B', 'C', 'D']).candidate).toBeNull();
    expect(detectVerticalScroll(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], ['B', 'C', 'D*', 'E', 'F', 'G', 'H', 'I'], ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])).toMatchObject({ deltaRows: 1, presentationMismatchRows: [2] });
  });
  it('rejects partial regions but keeps a full viewport shift with a status bar', () => {
    const previous = Array.from({ length: 35 }, (_, row) => `old-${row}`);
    const partial = Array.from({ length: 35 }, (_, row) => row < 17 ? previous[row + 3] : `partial-${row}`);
    const full = Array.from({ length: 35 }, (_, row) => row < 30 ? previous[row + 3] : `full-${row}`);
    expect(inspectVerticalScroll(previous, partial)).toMatchObject({ candidate: null, rejection: 'region-too-small' });
    expect(detectVerticalScroll(previous, full)).toMatchObject({ deltaRows: 3, topRow: 0, bottomRow: 33 });
  });
});
