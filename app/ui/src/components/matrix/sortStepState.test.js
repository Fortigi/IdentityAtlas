// Inputs are chosen to DISCRIMINATE: each case is one a wrong implementation
// would get wrong, not one that any implementation passes. So the column lists
// mix a dropped column with a kept one (a filter that drops nothing fails), the
// fold cases sit on both sides of the threshold AND on it, and the row helpers
// act on the middle of a three-row list (an off-by-one that hits the first or
// last row fails).
import { describe, it, expect } from 'vitest';
import { DEFAULT_SORT } from '@ui/utils/matrixFilter';
import { FOLD_AUTO_THRESHOLD } from './MatrixFilterWizard.helpers';
import {
  MAX_SORT_ROWS, attributeOptions, sortRows, autoFolds, foldOnLoadChecked,
  canAddSortRow, addSortRow, updateSortRow, removeSortRow, toggleDir,
} from './sortStepState';

const rowsOf = (...names) => names.map(a => ({ attribute: a, dir: 'asc' }));

describe('attributeOptions', () => {
  it('keeps the sortable columns in the order given, and only those', () => {
    // displayName sits in the MIDDLE so a slice/pop cannot pass for a filter,
    // and the entries around it are both real: a "return []" also fails.
    const options = attributeOptions([
      { column: 'department' },
      { column: 'displayName' },
      { column: 'jobTitle' },
    ]);
    expect(options).toEqual(['department', 'jobTitle']);
  });

  it('drops columns with no addressable name', () => {
    expect(attributeOptions([
      { column: 'department' },
      { column: '' },
      { label: 'Manager' },
      { column: 'city' },
    ])).toEqual(['department', 'city']);
  });

  it('returns nothing when the columns response is not a list', () => {
    // The step renders before /matrix/columns answers; null must not throw.
    for (const notAList of [null, undefined, {}, 'department']) {
      expect(attributeOptions(notAList)).toEqual([]);
    }
  });
});

describe('sortRows', () => {
  it('shows the saved sort when there is one', () => {
    const saved = rowsOf('city', 'jobTitle');
    expect(sortRows(saved)).toBe(saved);
  });

  it('falls back to the default sort when nothing was ever chosen', () => {
    expect(sortRows([])).toEqual(DEFAULT_SORT);
    expect(sortRows(undefined)).toEqual(DEFAULT_SORT);
    expect(sortRows(null)).toEqual(DEFAULT_SORT);
    // The default is one real level, not an empty list dressed up as one.
    expect(sortRows([])).toHaveLength(1);
  });
});

describe('fold on load', () => {
  it('auto folds at the threshold and above, not below it', () => {
    expect(autoFolds(FOLD_AUTO_THRESHOLD - 1)).toBe(false);
    expect(autoFolds(FOLD_AUTO_THRESHOLD)).toBe(true);       // boundary: >= not >
    expect(autoFolds(FOLD_AUTO_THRESHOLD + 1)).toBe(true);
  });

  it('treats a missing count as an empty matrix rather than a huge one', () => {
    expect(autoFolds(undefined)).toBe(false);
    expect(autoFolds(0)).toBe(false);
  });

  it("resolves 'auto' against the assignment count", () => {
    expect(foldOnLoadChecked('auto', FOLD_AUTO_THRESHOLD)).toBe(true);
    expect(foldOnLoadChecked('auto', 10)).toBe(false);
  });

  it('honours an explicit choice whatever the count says', () => {
    // Both rows contradict the count, which is the point: an implementation that
    // consulted the count anyway would flip each of them.
    expect(foldOnLoadChecked(false, FOLD_AUTO_THRESHOLD * 10)).toBe(false);
    expect(foldOnLoadChecked(true, 0)).toBe(true);
  });
});

describe('adding a sort level', () => {
  it('offers another level while an unused attribute is left', () => {
    expect(canAddSortRow(rowsOf('department'), ['department', 'city'])).toBe(true);
  });

  it('stops offering once every attribute is sorted on', () => {
    expect(canAddSortRow(rowsOf('department', 'city'), ['department', 'city'])).toBe(false);
  });

  it('stops at the maximum even with attributes to spare', () => {
    const full = rowsOf(...Array.from({ length: MAX_SORT_ROWS }, (_, i) => `a${i}`));
    const plenty = Array.from({ length: MAX_SORT_ROWS + 3 }, (_, i) => `a${i}`);
    expect(canAddSortRow(full, plenty)).toBe(false);
    expect(canAddSortRow(full.slice(0, MAX_SORT_ROWS - 1), plenty)).toBe(true);
  });

  it('adds the first attribute not already sorted on, ascending', () => {
    // 'city' is used but is NOT first in options, so "take options[0]" and "take
    // the first unused" give different answers here.
    const next = addSortRow(rowsOf('city'), ['city', 'department', 'jobTitle']);
    expect(next).toEqual([
      { attribute: 'city', dir: 'asc' },
      { attribute: 'department', dir: 'asc' },
    ]);
  });

  it('leaves the levels untouched when there is nothing to add', () => {
    const rows = rowsOf('city');
    expect(addSortRow(rows, [])).toBe(rows);
  });
});

describe('editing sort levels', () => {
  it('patches only the level addressed, keeping its other fields', () => {
    const rows = [
      { attribute: 'department', dir: 'asc' },
      { attribute: 'city', dir: 'asc' },
      { attribute: 'jobTitle', dir: 'desc' },
    ];
    expect(updateSortRow(rows, 1, { dir: 'desc' })).toEqual([
      { attribute: 'department', dir: 'asc' },
      { attribute: 'city', dir: 'desc' },
      { attribute: 'jobTitle', dir: 'desc' },
    ]);
  });

  it('does not mutate the levels it was given', () => {
    const rows = rowsOf('department', 'city');
    updateSortRow(rows, 0, { attribute: 'city' });
    removeSortRow(rows, 0);
    expect(rows).toEqual(rowsOf('department', 'city'));
  });

  it('removes the level addressed and no other', () => {
    const rows = rowsOf('department', 'city', 'jobTitle');
    expect(removeSortRow(rows, 1)).toEqual(rowsOf('department', 'jobTitle'));
    expect(removeSortRow(rows, 0)).toEqual(rowsOf('city', 'jobTitle'));
    expect(removeSortRow(rows, 2)).toEqual(rowsOf('department', 'city'));
  });
});

describe('toggleDir', () => {
  it('flips between the two directions', () => {
    expect(toggleDir('asc')).toBe('desc');
    expect(toggleDir('desc')).toBe('asc');
  });

  it('lands on ascending from an unset direction', () => {
    // Anything that isn't 'asc' is shown as Z→A, including a level saved without
    // a dir, so the click has to move it to 'asc' — not leave it where it was.
    expect(toggleDir(undefined)).toBe('asc');
  });
});
