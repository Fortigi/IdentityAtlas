import { describe, it, expect } from 'vitest';
import { buildSortKeys, makeUserComparator, computeAttributeSpans } from './sortUsers.js';

// Build a subject the way MatrixView does: a row's attributes plus a precomputed
// sortKeys array aligned to the sort attributes.
const make = (displayName, row, sortAttributes) => ({ displayName, sortKeys: buildSortKeys(row, sortAttributes) });
const DEPT = [{ attribute: 'department', dir: 'asc' }];
const DEPT_TITLE = [{ attribute: 'department', dir: 'asc' }, { attribute: 'jobTitle', dir: 'asc' }];

describe('buildSortKeys', () => {
  it('reads attribute values in order as strings', () => {
    expect(buildSortKeys({ department: 'Eng', jobTitle: 'SWE' }, DEPT_TITLE)).toEqual(['Eng', 'SWE']);
  });
  it('maps missing values to empty strings', () => {
    expect(buildSortKeys({ department: 'Eng' }, DEPT_TITLE)).toEqual(['Eng', '']);
    expect(buildSortKeys(null, DEPT)).toEqual(['']);
  });
});

describe('makeUserComparator', () => {
  it('sorts by a single attribute ascending, tiebreak on displayName', () => {
    const users = [
      make('Bob', { department: 'Sales' }, DEPT),
      make('Ann', { department: 'Eng' }, DEPT),
      make('Cy', { department: 'Eng' }, DEPT),
    ];
    expect([...users].sort(makeUserComparator(DEPT)).map(u => u.displayName)).toEqual(['Ann', 'Cy', 'Bob']);
  });

  it('sorts by department then jobTitle', () => {
    const users = [
      make('A', { department: 'Eng', jobTitle: 'Manager' }, DEPT_TITLE),
      make('B', { department: 'Eng', jobTitle: 'Engineer' }, DEPT_TITLE),
      make('C', { department: 'Sales', jobTitle: 'Rep' }, DEPT_TITLE),
    ];
    expect([...users].sort(makeUserComparator(DEPT_TITLE)).map(u => u.displayName)).toEqual(['B', 'A', 'C']);
  });

  it('honours descending direction', () => {
    const users = [
      make('A', { department: 'Eng' }, DEPT),
      make('B', { department: 'Sales' }, DEPT),
    ];
    expect([...users].sort(makeUserComparator([{ attribute: 'department', dir: 'desc' }])).map(u => u.displayName)).toEqual(['B', 'A']);
  });

  it('pushes empty attribute values to the end regardless of direction', () => {
    const users = [make('A', { department: '' }, DEPT), make('B', { department: 'Eng' }, DEPT)];
    expect([...users].sort(makeUserComparator([{ attribute: 'department', dir: 'asc' }])).map(u => u.displayName)).toEqual(['B', 'A']);
    expect([...users].sort(makeUserComparator([{ attribute: 'department', dir: 'desc' }])).map(u => u.displayName)).toEqual(['B', 'A']);
  });
});

describe('computeAttributeSpans', () => {
  it('groups contiguous equal values into spans', () => {
    const users = ['Eng', 'Eng', 'Sales', 'Sales', 'HR'].map((d, i) => make(`U${i}`, { department: d }, DEPT));
    expect(computeAttributeSpans(users, 0)).toEqual([
      { value: 'Eng', start: 0, span: 2 },
      { value: 'Sales', start: 2, span: 2 },
      { value: 'HR', start: 4, span: 1 },
    ]);
  });

  it('represents empty values as an empty-string span', () => {
    const users = [make('A', { department: '' }, DEPT), make('B', { department: '' }, DEPT)];
    expect(computeAttributeSpans(users, 0)).toEqual([{ value: '', start: 0, span: 2 }]);
  });

  it('does not merge non-contiguous equal values', () => {
    const users = ['Eng', 'Sales', 'Eng'].map((d, i) => make(`U${i}`, { department: d }, DEPT));
    expect(computeAttributeSpans(users, 0).map(s => s.value)).toEqual(['Eng', 'Sales', 'Eng']);
  });
});
