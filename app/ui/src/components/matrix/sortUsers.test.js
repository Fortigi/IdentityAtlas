import { describe, it, expect } from 'vitest';
import { makeUserComparator, sortUsers, computeAttributeSpans } from './sortUsers.js';

const U = (displayName, department, jobTitle) => ({ displayName, department, jobTitle });

describe('makeUserComparator', () => {
  it('sorts by a single attribute ascending, tiebreak on displayName', () => {
    const users = [U('Bob', 'Sales'), U('Ann', 'Eng'), U('Cy', 'Eng')];
    const out = [...users].sort(makeUserComparator([{ attribute: 'department', dir: 'asc' }]));
    expect(out.map(u => u.displayName)).toEqual(['Ann', 'Cy', 'Bob']);
  });

  it('sorts by department then jobTitle', () => {
    const users = [
      U('A', 'Eng', 'Manager'),
      U('B', 'Eng', 'Engineer'),
      U('C', 'Sales', 'Rep'),
    ];
    const out = [...users].sort(makeUserComparator([
      { attribute: 'department', dir: 'asc' },
      { attribute: 'jobTitle', dir: 'asc' },
    ]));
    expect(out.map(u => u.displayName)).toEqual(['B', 'A', 'C']);
  });

  it('honours descending direction', () => {
    const users = [U('A', 'Eng'), U('B', 'Sales')];
    const out = [...users].sort(makeUserComparator([{ attribute: 'department', dir: 'desc' }]));
    expect(out.map(u => u.displayName)).toEqual(['B', 'A']);
  });

  it('pushes empty attribute values to the end regardless of direction', () => {
    const users = [U('A', ''), U('B', 'Eng')];
    expect([...users].sort(makeUserComparator([{ attribute: 'department', dir: 'asc' }])).map(u => u.displayName)).toEqual(['B', 'A']);
    expect([...users].sort(makeUserComparator([{ attribute: 'department', dir: 'desc' }])).map(u => u.displayName)).toEqual(['B', 'A']);
  });

  it('defaults to department asc when no attributes given', () => {
    const users = [U('A', 'Sales'), U('B', 'Eng')];
    expect(sortUsers(users, []).map(u => u.displayName)).toEqual(['B', 'A']);
  });
});

describe('computeAttributeSpans', () => {
  it('groups contiguous equal values into spans', () => {
    const users = [U('A', 'Eng'), U('B', 'Eng'), U('C', 'Sales'), U('D', 'Sales'), U('E', 'HR')];
    expect(computeAttributeSpans(users, 'department')).toEqual([
      { value: 'Eng', start: 0, span: 2 },
      { value: 'Sales', start: 2, span: 2 },
      { value: 'HR', start: 4, span: 1 },
    ]);
  });

  it('represents empty values as an empty-string span', () => {
    const users = [U('A', ''), U('B', '')];
    expect(computeAttributeSpans(users, 'department')).toEqual([{ value: '', start: 0, span: 2 }]);
  });

  it('does not merge non-contiguous equal values', () => {
    const users = [U('A', 'Eng'), U('B', 'Sales'), U('C', 'Eng')];
    expect(computeAttributeSpans(users, 'department').map(s => s.value)).toEqual(['Eng', 'Sales', 'Eng']);
  });
});
