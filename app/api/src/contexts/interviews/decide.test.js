// Deciding a claim: what each confirmation changes, and what it refuses.
import { describe, it, expect, vi } from 'vitest';
import { parseDecision, appendDescription, descriptionHeading, mergeDecision, decideClaim, ClaimError } from './decide.js';

const CLAIM_ID = 'cccccccc-0000-4000-8000-000000000001';
const CTX = 'dddddddd-0000-4000-8000-000000000001';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const ROLE_ID = 'eeeeeeee-0000-4000-8000-000000000001';

const base = {
  id: CLAIM_ID, contextId: CTX, claimKind: 'description', principalId: null, identityId: null, attribute: null,
  value: 'Plans the shifts of the nursing staff', periodFrom: null, periodTo: null, periodText: null, roleSuggestion: null,
  status: 'proposed', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', contextCategory: 'LogicalApplication', description: null,
};

// A transaction client that answers by statement and records every write.
function fakeDb(claim, { accountable = null, holder = { displayName: 'Piet Jansen' } } = {}) {
  const writes = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      if (sql.includes('FOR UPDATE OF c')) return { rows: claim ? [claim] : [] };
      if (sql.includes(`r.role = 'Accountable'`)) return { rows: accountable ? [accountable] : [] };
      if (/^SELECT "displayName" FROM/.test(sql.trim())) return { rows: holder ? [holder] : [] };
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('INSERT INTO "ContextRoles"')) return { rows: [{ id: ROLE_ID }] };
      return { rows: [], rowCount: 1 };
    }),
  };
  return {
    writes,
    tx: async (fn) => fn(client),
    queryOne: vi.fn(async () => ({ id: CLAIM_ID, status: 'listed' })),
  };
}

const decide = (db, body) => decideClaim(db, CLAIM_ID, body, 'analyst@example.test');
const claimUpdate = (db) => db.writes.find(w => w.sql.startsWith('UPDATE "ContextClaims"'));

describe('parseDecision', () => {
  it('takes a status, an edited value, a period and a person', () => {
    expect(parseDecision({ status: 'edited', value: '  architect   CCoE ', periodFrom: '2021', periodTo: '2022-06', periodText: 'now', principalId: PIET.toUpperCase(), replace: true }))
      .toEqual({ status: 'edited', value: 'architect CCoE', period: { periodFrom: '2021-01-01', periodTo: '2022-06-30', periodText: 'now' }, holder: { col: 'principalId', id: PIET }, replace: true });
  });

  it('clears a period with null and leaves out what was not sent', () => {
    expect(parseDecision({ status: 'confirmed', periodTo: null })).toEqual({ status: 'confirmed', value: undefined, period: { periodTo: null }, holder: null, replace: false });
  });

  it('refuses an unknown status, an empty value, a bad period, two holders and a non-uuid', () => {
    expect(parseDecision({ status: 'proposed' }).error).toMatch(/status/);
    expect(parseDecision({ status: 'confirmed', value: ' ' }).error).toMatch(/value/);
    expect(parseDecision({ status: 'confirmed', value: 'x'.repeat(2001) }).error).toMatch(/at most 2000/);
    expect(parseDecision({ status: 'confirmed', periodFrom: 'early on' }).error).toMatch(/periodFrom/);
    expect(parseDecision({ status: 'confirmed', principalId: PIET, identityId: ANNA }).error).toMatch(/not both/);
    expect(parseDecision({ status: 'confirmed', identityId: 'x' }).error).toBe('identityId must be a uuid');
  });
});

describe('appendDescription', () => {
  const h = descriptionHeading('Anna Voorbeeld', '2026-10-01');
  it('starts an empty description with the heading', () => {
    expect(appendDescription(null, h, 'Plans shifts')).toBe('From interview with Anna Voorbeeld, 2026-10-01:\nPlans shifts');
  });

  it('adds a section after an existing description, and a second line under the same interview\'s heading', () => {
    const once = appendDescription('The planning tool.  ', h, 'Plans shifts');
    expect(once).toBe(`The planning tool.\n\n${h}\nPlans shifts`);
    expect(appendDescription(once, h, 'Runs nightly')).toBe(`The planning tool.\n\n${h}\nPlans shifts\nRuns nightly`);
    expect(appendDescription(once, descriptionHeading('Bram Test', '2026-10-02'), 'Old')).toMatch(/Plans shifts\n\nFrom interview with Bram Test, 2026-10-02:\nOld$/);
  });
});

describe('mergeDecision', () => {
  it('counts a changed value or period as an edit, a confirmation as it stands as none', () => {
    const claim = { value: 'junior', periodFrom: '2015-01-01', periodTo: null, periodText: 'early years', principalId: PIET, identityId: null };
    expect(mergeDecision(claim, { period: {} })).toMatchObject({ edited: false, holder: { col: 'principalId', id: PIET } });
    expect(mergeDecision(claim, { value: 'junior', period: { periodText: 'early years' } }).edited).toBe(false);
    expect(mergeDecision(claim, { period: { periodTo: '2017-12-31' } })).toMatchObject({ edited: true, merged: { value: 'junior', periodTo: '2017-12-31', periodText: 'early years' } });
    expect(mergeDecision({ ...claim, principalId: null, identityId: ANNA }, { period: {} }).holder).toEqual({ col: 'identityId', id: ANNA });
  });
});

describe('decideClaim', () => {
  it('confirming a description appends it to the context under the interview heading', async () => {
    const db = fakeDb({ ...base, description: 'The planning tool.' });
    const r = await decide(db, { status: 'confirmed' });
    expect(r.effect).toEqual({ kind: 'description' });
    expect(db.writes[0]).toEqual({ sql: 'UPDATE "Contexts" SET description = $2 WHERE id = $1', params: [CTX, 'The planning tool.\n\nFrom interview with Anna Voorbeeld, 2026-10-01:\nPlans the shifts of the nursing staff'] });
    expect(claimUpdate(db).params.slice(0, 3)).toEqual([CLAIM_ID, 'confirmed', 'Plans the shifts of the nursing staff']);
    expect(claimUpdate(db).params[9]).toBe('analyst@example.test');
  });

  it('an edited property writes the edited value into extendedAttributes and is stored as edited', async () => {
    const db = fakeDb({ ...base, claimKind: 'property', attribute: 'users', value: '400 nurses' });
    const r = await decide(db, { status: 'confirmed', value: '450 nurses' });
    expect(r.effect).toEqual({ kind: 'property', attribute: 'users' });
    expect(db.writes[0].params).toEqual([CTX, 'users', '450 nurses']);
    expect(db.writes[0].sql).toMatch(/\|\| jsonb_build_object\(\$2::text, \$3::text\)/);
    expect(claimUpdate(db).params[1]).toBe('edited');
  });

  it('a Responsible suggestion becomes a role with the claim as its source', async () => {
    const db = fakeDb({ ...base, claimKind: 'role', attribute: 'dayToDay', principalId: PIET, roleSuggestion: 'Responsible' });
    const r = await decide(db, { status: 'confirmed' });
    expect(r.effect).toEqual({ kind: 'role', role: 'Responsible', roleId: ROLE_ID, displayName: 'Piet Jansen' });
    const insert = db.writes.find(w => w.sql.startsWith('INSERT INTO "ContextRoles"'));
    expect(insert.params).toEqual([CTX, PIET, 'Responsible', CLAIM_ID]);
    expect(insert.sql).toMatch(/VALUES \(\$1, \$2, \$3, 'analyst', \$4\)/);
    expect(db.writes.some(w => w.sql.startsWith('DELETE'))).toBe(false);
  });

  it('an Accountable when another person holds it: 409 with the current holder, nothing written', async () => {
    const accountable = { id: 'role-0', principalId: ANNA, identityId: null, displayName: 'Anna Voorbeeld' };
    const db = fakeDb({ ...base, claimKind: 'role', attribute: 'owner', principalId: PIET, roleSuggestion: 'Accountable' }, { accountable });
    const err = await decide(db, { status: 'confirmed' }).catch(e => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect([err.status, err.details]).toEqual([409, { current: { id: 'role-0', displayName: 'Anna Voorbeeld', principalId: ANNA, identityId: null } }]);
    expect(db.writes).toEqual([]);
  });

  it('… and with replace: the old Accountable goes, the new one comes in', async () => {
    const accountable = { id: 'role-0', principalId: ANNA, identityId: null, displayName: 'Anna Voorbeeld' };
    const db = fakeDb({ ...base, claimKind: 'role', attribute: 'owner', principalId: PIET, roleSuggestion: 'Accountable' }, { accountable });
    await decide(db, { status: 'confirmed', replace: true });
    expect(db.writes.map(w => w.sql.slice(0, 26))).toEqual(['DELETE FROM "ContextRoles"', 'INSERT INTO "ContextRoles"', 'UPDATE "ContextClaims" SET']);
    expect(db.writes[0].params).toEqual(['role-0']);
  });

  it('an Accountable the same person already holds is linked, not a conflict', async () => {
    const accountable = { id: 'role-0', principalId: PIET, identityId: null, displayName: 'Piet Jansen' };
    const db = fakeDb({ ...base, claimKind: 'role', attribute: 'owner', principalId: PIET, roleSuggestion: 'Accountable' }, { accountable });
    const r = await decide(db, { status: 'confirmed' });
    expect(r.effect.kind).toBe('role');
    expect(db.writes.some(w => w.sql.startsWith('DELETE'))).toBe(false);
  });

  it('a role claim without its person must be given one; the chosen person is stored as a direct match', async () => {
    const claim = { ...base, claimKind: 'role', attribute: 'dayToDay', roleSuggestion: 'Responsible' };
    await expect(decide(fakeDb(claim), { status: 'confirmed' })).rejects.toMatchObject({ status: 400, message: /Choose who/ });
    const db = fakeDb(claim);
    await decide(db, { status: 'confirmed', principalId: PIET });
    expect(claimUpdate(db).params.slice(6, 9)).toEqual([PIET, null, true]);
  });

  it('refuses a role on a template without roles, and a person who does not exist', async () => {
    const claim = { ...base, claimKind: 'role', attribute: 'owner', principalId: PIET, roleSuggestion: 'Accountable' };
    await expect(decide(fakeDb({ ...claim, contextCategory: 'Tag' }), { status: 'confirmed' })).rejects.toMatchObject({ status: 400 });
    await expect(decide(fakeDb(claim, { holder: null }), { status: 'confirmed' })).rejects.toMatchObject({ status: 404, message: 'Principal not found' });
  });

  it('a roleHistory claim, and any rejection, change nothing but the claim', async () => {
    const db = fakeDb({ ...base, claimKind: 'roleHistory', attribute: 'member', principalId: PIET, value: 'junior' });
    expect((await decide(db, { status: 'confirmed' })).effect).toEqual({ kind: 'none' });
    expect(db.writes.map(w => w.sql.slice(0, 22))).toEqual(['UPDATE "ContextClaims"']);
    const rejected = fakeDb({ ...base, claimKind: 'role', attribute: 'owner', principalId: PIET, roleSuggestion: 'Accountable' });
    await decide(rejected, { status: 'rejected', value: 'changed' });
    expect(rejected.writes).toHaveLength(1);
    expect(claimUpdate(rejected).params[1]).toBe('rejected');
  });

  it('refuses a decided claim (409), an unknown one (404), a bad id and a bad body (400)', async () => {
    await expect(decide(fakeDb({ ...base, status: 'confirmed' }), { status: 'rejected' })).rejects.toMatchObject({ status: 409 });
    await expect(decide(fakeDb(null), { status: 'rejected' })).rejects.toMatchObject({ status: 404 });
    await expect(decideClaim(fakeDb(base), 'nope', { status: 'rejected' }, 'u')).rejects.toMatchObject({ status: 400 });
    await expect(decide(fakeDb(base), { status: 'maybe' })).rejects.toMatchObject({ status: 400 });
  });
});
