import { describe, expect, it } from 'vitest';
import { adjacentTabId, tabIdAtOrdinal, type TerminalTab } from './useTerminal';

const tabs: TerminalTab[] = [
  { id: 'one', ordinal: 1, title: '1. cmd.exe', status: 'running' },
  { id: 'two', ordinal: 2, title: '2. cmd.exe', status: 'running' },
  { id: 'three', ordinal: 3, title: '3. cmd.exe', status: 'running' },
];

describe('adjacentTabId', () => {
  it('selects the right neighbor, then the left, when closing a tab', () => {
    expect(adjacentTabId(tabs, 'two')).toBe('three');
    expect(adjacentTabId(tabs, 'three')).toBe('two');
    expect(adjacentTabId([tabs[0]], 'one')).toBeNull();
  });
});

describe('tabIdAtOrdinal', () => {
  it('maps Menu+digit ordinals to tabs', () => {
    expect(tabIdAtOrdinal(tabs, 2)).toBe('two');
    expect(tabIdAtOrdinal([tabs[0], tabs[2]], 3)).toBe('three');
    expect(tabIdAtOrdinal(tabs, 9)).toBeNull();
  });
});
