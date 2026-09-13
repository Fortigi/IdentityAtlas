// Unit tests for the share snapshot's display-mode helpers (#1166).
//
// The pair has to round-trip: whatever displayModeOf() records at share time
// must be what applyDisplayMode() reproduces for the recipient, or a rotated
// matrix arrives as a grid.

import { describe, it, expect } from 'vitest';
import { displayModeOf, applyDisplayMode, ROTATED_ORIENTATION } from './sharedSnapshot';

const GRID = { rowType: 'user', subject: { include: [] } };
const ROTATED = { ...GRID, orientation: ROTATED_ORIENTATION };
const ATTR_ROLLUP = { ...GRID, rollup: 'department' };
const CONTEXT_ROLLUP = { ...GRID, rollupKind: 'context', rollupContextId: 'ctx-1' };

describe('displayModeOf', () => {
  it('recognises the grid, rotated and roll-up shapes', () => {
    expect(displayModeOf(GRID)).toBe('grid');
    expect(displayModeOf(ROTATED)).toBe('rotated');
    expect(displayModeOf(ATTR_ROLLUP)).toBe('rollup');
    expect(displayModeOf(CONTEXT_ROLLUP)).toBe('rollup');
  });

  it('does not call a context roll-up without its id a roll-up', () => {
    // rollupKind alone doesn't drive the roll-up view — the id does.
    expect(displayModeOf({ ...GRID, rollupKind: 'context' })).toBe('grid');
  });

  it('treats a roll-up as a roll-up even when it is also rotated', () => {
    expect(displayModeOf({ ...ROTATED, rollup: 'department' })).toBe('rollup');
  });

  it('defaults to grid for a missing filter', () => {
    expect(displayModeOf(null)).toBe('grid');
    expect(displayModeOf(undefined)).toBe('grid');
  });
});

describe('applyDisplayMode', () => {
  it('rotates a filter that was shared from the rotated view', () => {
    expect(applyDisplayMode(GRID, 'rotated')).toEqual(ROTATED);
  });

  it('un-rotates a filter that was shared from the grid view', () => {
    const result = applyDisplayMode(ROTATED, 'grid');
    expect(result).toEqual(GRID);
    expect('orientation' in result).toBe(false);
  });

  it('leaves a filter alone when the stored mode already matches', () => {
    expect(applyDisplayMode(ROTATED, 'rotated')).toEqual(ROTATED);
    expect(applyDisplayMode(GRID, 'grid')).toBe(GRID);
  });

  it('leaves the filter untouched for a roll-up or an unrecorded mode', () => {
    expect(applyDisplayMode(ATTR_ROLLUP, 'rollup')).toBe(ATTR_ROLLUP);
    expect(applyDisplayMode(ROTATED, null)).toBe(ROTATED);
    expect(applyDisplayMode(GRID, undefined)).toBe(GRID);
  });

  it('never mutates the stored snapshot', () => {
    const original = { ...GRID };
    applyDisplayMode(original, 'rotated');
    expect(original).toEqual(GRID);
  });

  it('returns null for a missing filter', () => {
    expect(applyDisplayMode(null, 'rotated')).toBeNull();
  });

  it('round-trips every mode', () => {
    for (const filter of [GRID, ROTATED, ATTR_ROLLUP, CONTEXT_ROLLUP]) {
      const mode = displayModeOf(filter);
      expect(displayModeOf(applyDisplayMode(filter, mode))).toBe(mode);
    }
  });
});
