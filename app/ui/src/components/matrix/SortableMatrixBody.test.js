// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sortableRowIds } from './SortableMatrixBody';

// A resource granted by two business roles has a row under each of them, and
// both rows carry the resource's own id — so only the rows that own their
// position may be registered with the drag layer (requestor feedback on #370).
describe('sortableRowIds', () => {
  it('keeps the rows that own their position', () => {
    expect(sortableRowIds([
      { id: 'BR1' },
      { id: 'G1', roleParentId: 'BR1' },
      { id: 'G1__nested__X', isNestedRow: true },
      { id: 'BR2' },
      { id: 'G1', roleParentId: 'BR2' },
      { id: 'G4' },
    ])).toEqual(['BR1', 'BR2', 'G4']);
  });

  it('never registers the same id twice', () => {
    const ids = sortableRowIds([{ id: 'G1' }, { id: 'G1', roleParentId: 'BR1' }]);
    expect(ids).toEqual(['G1']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tolerates a missing row list', () => {
    expect(sortableRowIds(undefined)).toEqual([]);
  });
});
