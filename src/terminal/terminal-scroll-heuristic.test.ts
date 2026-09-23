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
});
