import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';
import {
  setBusinessRoleOwner, removeBusinessRoleOwner, isBusinessRole, loadBusinessRoleOwners,
} from './businessRoleOwners.js';

const ROLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const P2 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const I1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const accountable = (holder, addedBy) => ({ id: 'old', principalId: holder, identityId: null, addedBy });

// Stages the current Accountable, then answers the DELETE and the upsert.
function stage(current) {
  query.mockImplementation(async (sql, params) => {
    if (/FOR UPDATE/.test(sql)) return { rows: current ? [current] : [] };
    if (/^\s*DELETE/.test(sql)) return { rowCount: 1 };
    return { rows: [{ id: 'new', role: params[2], addedBy: params[3] }] };
  });
}
const deletes = () => query.mock.calls.filter(([s]) => /^\s*DELETE/.test(s));
const inserts = () => query.mock.calls.filter(([s]) => /INSERT INTO/.test(s));

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('setBusinessRoleOwner — who may replace the Accountable', () => {
  const set = (addedBy, holderId = P1) => setBusinessRoleOwner(ROLE, { role: 'Accountable', holderCol: 'principalId', holderId }, addedBy);

  it.each([
    ['analyst', 'sync'], ['analyst', 'import'], ['analyst', 'analyst'],
    ['import', 'sync'], ['import', 'import'], ['sync', 'sync'],
  ])('%s replaces a %s Accountable', async (source, existing) => {
    stage(accountable(P2, existing));
    expect(await set(source)).toMatchObject({ id: 'new', addedBy: source });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0][1]).toEqual(['old']);
  });

  it.each([
    ['import', 'analyst'], ['sync', 'analyst'], ['sync', 'import'],
  ])('%s leaves a %s Accountable alone', async (source, existing) => {
    stage(accountable(P2, existing));
    expect(await set(source)).toBeNull();
    expect(deletes()).toHaveLength(0);
    expect(inserts()).toHaveLength(0);
  });

  it('fills an empty place for any source', async () => {
    stage(null);
    expect(await set('sync')).toMatchObject({ addedBy: 'sync' });
    expect(deletes()).toHaveLength(0);
  });

  it('restating the same holder deletes nothing, whoever set it', async () => {
    stage(accountable(P1, 'analyst'));
    await set('sync');
    expect(deletes()).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
  });

  it('keeps the analyst marker when a source restates an analyst holder', async () => {
    stage(accountable(P1, 'analyst'));
    await set('import');
    expect(inserts()[0][0]).toMatch(/CASE WHEN "BusinessRoleOwners"\."addedBy" = 'analyst' THEN 'analyst' ELSE EXCLUDED\."addedBy" END/);
  });

  it('replaces a person holder when an account is chosen', async () => {
    stage({ id: 'old', principalId: null, identityId: I1, addedBy: 'sync' });
    await set('analyst');
    expect(deletes()).toHaveLength(1);
  });
});

describe('setBusinessRoleOwner — Responsible and input', () => {
  it('adds a Responsible without touching anyone else', async () => {
    stage(accountable(P2, 'analyst'));
    await setBusinessRoleOwner(ROLE, { role: 'Responsible', holderCol: 'principalId', holderId: P1 }, 'sync');
    expect(query.mock.calls.some(([s]) => /FOR UPDATE/.test(s))).toBe(false);
    expect(deletes()).toHaveLength(0);
    expect(inserts()[0][1]).toEqual([ROLE, P1, 'Responsible', 'sync']);
  });

  it('writes to the identity column for a person', async () => {
    stage(null);
    await setBusinessRoleOwner(ROLE, { role: 'Responsible', holderCol: 'identityId', holderId: I1 });
    expect(inserts()[0][0]).toMatch(/"resourceId", "identityId", role/);
    expect(inserts()[0][1][3]).toBe('analyst');
  });

  it('refuses a holder column outside the two known ones', async () => {
    await expect(setBusinessRoleOwner(ROLE, { role: 'Responsible', holderCol: 'x"; DROP', holderId: P1 })).rejects.toThrow(/holder column/);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses an unknown source', async () => {
    await expect(setBusinessRoleOwner(ROLE, { role: 'Responsible', holderCol: 'principalId', holderId: P1 }, 'robot')).rejects.toThrow(/owner source/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the other helpers', () => {
  it('loadBusinessRoleOwners puts the Accountable first and scopes to the role', async () => {
    query.mockResolvedValue({ rows: [{ id: 'o1' }] });
    expect(await loadBusinessRoleOwners(ROLE)).toEqual([{ id: 'o1' }]);
    expect(query.mock.calls[0][0]).toMatch(/ORDER BY \(o\.role = 'Accountable'\) DESC/);
    expect(query.mock.calls[0][1]).toEqual([ROLE]);
  });

  it.each([[1, true], [0, false]])('removeBusinessRoleOwner with rowCount %i is %s', async (rowCount, expected) => {
    query.mockResolvedValue({ rowCount });
    expect(await removeBusinessRoleOwner(ROLE, 'o1')).toBe(expected);
    expect(query.mock.calls[0][1]).toEqual(['o1', ROLE]);
  });

  it.each([[{ id: ROLE }, true], [null, false]])('isBusinessRole for %j is %s', async (row, expected) => {
    queryOne.mockResolvedValue(row);
    expect(await isBusinessRole(ROLE)).toBe(expected);
    expect(queryOne.mock.calls[0][0]).toMatch(/"resourceType" = 'BusinessRole'/);
  });
});
