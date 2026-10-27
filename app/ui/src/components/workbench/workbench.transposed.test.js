import { describe, it, expect } from 'vitest';
import { transposedRows, resourceOrder, compactValue, headerColumns, orientationOf, ORIENTATIONS, DEFAULT_ORIENTATION } from './workbench.transposed';
import { viewToSave, viewFromSaved } from './workbench.save';
import { columnByKey } from './workbench.columns';

const col = (id, extra = {}) => ({ id, displayName: id, isRole: false, holders: 1, ...extra });
const r1 = col('r1'); const r2 = col('r2'); const r3 = col('r3'); const low = col('low');
const roleCol = col('br', { isRole: true });
const byId = new Map([r1, r2, r3, low, roleCol].map(c => [c.id, c]));
const role = (id, contains, extra = {}) => ({ id, contains: new Set(contains), idx: 0, holders: new Set(), ...extra });

describe('the rows with people as columns', () => {
  it('puts each role with its entitlements under it, then the access no role contains', () => {
    const rows = transposedRows([role('br', ['r1', 'r2']), role('draft:1', ['r2', 'low'], { draft: true })], [r1, r2, r3], byId);
    expect(rows.map(r => r.key)).toEqual(['role:br', 'br:r1', 'br:r2', 'role:draft:1', 'draft:1:r2', 'draft:1:low', 'others', 'other:r3']);
    expect(rows[0]).toMatchObject({ type: 'role', count: 2, folded: false });
    expect(rows.find(r => r.type === 'others').count).toBe(1);
    // A proposed role's entitlement shows under it although the threshold hides it among the others.
    expect(rows.some(r => r.key === 'draft:1:low')).toBe(true);
  });

  it('hides a folded role\'s entitlements, keeps unknown ids and roles out of a role\'s rows', () => {
    const rows = transposedRows([role('br', ['r1', 'gone', 'br'])], [r1, r2], byId, new Set(['br']));
    expect(rows.map(r => r.key)).toEqual(['role:br', 'others', 'other:r2']);
    expect(rows[0]).toMatchObject({ count: 1, folded: true });
  });

  it('has no Other access heading without roles, and no rows without access', () => {
    expect(transposedRows([], [r1, roleCol], byId).map(r => r.key)).toEqual(['other:r1']);
    expect(transposedRows([], [], byId)).toEqual([]);
    expect(transposedRows([role('br', ['r1'])], [r1], byId).map(r => r.key)).toEqual(['role:br', 'br:r1']);
  });

  it('runs a Shift-click range along the resources in row order, each once', () => {
    const rows = transposedRows([role('a', ['r2', 'r1']), role('b', ['r1'])], [r1, r2, r3], byId);
    expect(resourceOrder(rows)).toEqual(['r2', 'r1', 'r3']);
  });
});

describe('a person in a narrow header cell', () => {
  const person = {
    jobTitle: 'Handler', accounts: [],
    knowledge: [
      { kind: 'activity', name: 'Quotes', state: 'proposed', claims: [] },
      { kind: 'activity', name: 'Claims', state: 'confirmed', claims: [] },
      { kind: 'activity', name: 'Audits', state: 'confirmed', claims: [] },
    ],
  };

  it('shows the strongest value first, how many more, and all of them on hover', () => {
    const v = compactValue(person, columnByKey.get('activity'));
    expect(v.first.label).toBe('Audits');
    expect(v.more).toBe(2);
    expect(v.title).toBe('Audits (confirmed)\nClaims (confirmed)\nQuotes (proposed)');
  });

  it('shows text as it is, and nothing for a blank', () => {
    expect(compactValue(person, columnByKey.get('jobTitle'))).toMatchObject({ first: { label: 'Handler' }, more: 0, title: 'Handler' });
    expect(compactValue({ accounts: [] }, columnByKey.get('department'))).toMatchObject({ first: null, more: 0, title: '' });
  });

  it('puts the name row last, next to the cells', () => {
    const cols = ['displayName', 'jobTitle', 'duty'].map(k => columnByKey.get(k));
    expect(headerColumns(cols).map(c => c.key)).toEqual(['jobTitle', 'duty', 'displayName']);
  });
});

describe('the orientation', () => {
  it('defaults to people as columns, the matrix\'s orientation', () => {
    expect(DEFAULT_ORIENTATION).toBe('columns');
    expect(ORIENTATIONS.map(o => o.label)).toEqual(['People as columns', 'People as rows']);
    expect(orientationOf({ orientation: 'rows' })).toBe('rows');
    expect(orientationOf({ orientation: 'sideways' })).toBe('columns');
    expect(orientationOf(undefined)).toBe('columns');
  });

  it('is saved with the view and comes back; an older save opens in the default', () => {
    const defaults = { orientation: 'columns', columns: ['displayName'], filters: {} };
    expect(viewToSave({ ...defaults, orientation: 'rows' })).toMatchObject({ orientation: 'rows' });
    expect(viewFromSaved({ orientation: 'rows', columns: ['displayName'] }, defaults).orientation).toBe('rows');
    expect(viewFromSaved({ columns: ['displayName'] }, defaults).orientation).toBe('columns');
  });
});
