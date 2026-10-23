// Deciding a claim: what each confirmation changes, and what it refuses.
import { describe, it, expect, vi } from 'vitest';
import { parseDecision, appendDescription, descriptionHeading, mergeDecision, decideClaim, undoClaim, canUndo, ClaimError } from './decide.js';

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
function fakeDb(claim, { accountable = null, holder = { displayName: 'Piet Jansen' }, context = null, rowCount = 1 } = {}) {
  const writes = [];
  const rowsOf = (row) => ({ rows: row ? [row] : [] });
  // Reads: answered, not recorded. The first statement that matches answers.
  const reads = [
    [(sql) => sql.includes('FOR UPDATE OF c'), () => rowsOf(claim)],
    [(sql) => sql.includes('AS "isListed"'), () => rowsOf(context)],
    // The change request a mark raises reads the context again, with the member's name.
    [(sql) => sql.includes('AS "memberName"'), () => rowsOf(context && { displayName: 'Klanten', variant: context.variant, scopeSystemId: 7, systemName: context.systemName, memberName: 'Piet Jansen' })],
    [(sql) => sql.includes(`r.role = 'Accountable'`), () => rowsOf(accountable)],
    [(sql) => /^SELECT "displayName" FROM/.test(sql.trim()), () => rowsOf(holder)],
  ];
  // Writes whose answer a test depends on; every other write answers one row changed.
  const answers = [
    ['INSERT INTO "ContextRoles"', () => ({ rows: [{ id: ROLE_ID }] })],
    ['INSERT INTO "ContextMemberOverrides"', () => ({ rows: [{ id: 'ovr-1' }] })],
    ['INSERT INTO "ChangeRequests"', (params) => ({ rows: [{ id: 'cr-1', summary: 'Remove Piet Jansen from Klanten', targetName: params[2] }] })],
  ];
  const client = {
    query: vi.fn(async (sql, params) => {
      const read = reads.find(([match]) => match(sql));
      if (read) return read[1]();
      if (sql.startsWith('DELETE FROM "ContextMemberOverrides" WHERE "claimId"')) { writes.push({ sql, params }); return { rows: [], rowCount }; }
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const answer = answers.find(([text]) => sql.includes(text));
      return answer ? answer[1](params) : { rows: [], rowCount: 1 };
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

describe('decideClaim — alias and membership', () => {
  it('a confirmed alias is added to the aliases once; a spelling already there is not added again', async () => {
    const db = fakeDb({ ...base, claimKind: 'alias', value: 'PC', currentAliases: ['Port Co'] });
    const out = await decide(db, { status: 'confirmed' });
    expect(out.effect).toEqual({ kind: 'alias', aliases: ['Port Co', 'PC'] });
    const write = db.writes.find(w => w.sql.startsWith('UPDATE "Contexts"'));
    expect(write.sql).toContain(`jsonb_build_object('aliases', $2::jsonb)`);
    expect(write.params).toEqual([CTX, JSON.stringify(['Port Co', 'PC'])]);

    const again = fakeDb({ ...base, claimKind: 'alias', value: 'port  co', currentAliases: ['Port Co'] });
    expect((await decide(again, { status: 'confirmed' })).effect).toEqual({ kind: 'alias', aliases: ['Port Co'] });
  });

  it('an edited alias writes the edited name; no aliases yet starts the list', async () => {
    const db = fakeDb({ ...base, claimKind: 'alias', value: 'P.C.', currentAliases: null });
    expect((await decide(db, { status: 'edited', value: 'PC' })).effect).toEqual({ kind: 'alias', aliases: ['PC'] });
  });

  it('a confirmed membership of someone the list does not have changes nothing but the claim', async () => {
    const db = fakeDb({ ...base, claimKind: 'membership', attribute: 'left', principalId: PIET, value: 'left the account' }, { context: { ...UNIT, isListed: false } });
    const out = await decide(db, { status: 'confirmed' });
    expect(out.effect).toEqual({ kind: 'none' });
    expect(verbs(db)).toEqual(['UPDATE "ContextClaims"']);
  });
});

// The context a person claim's decision reads (memberOverrides.js OVERRIDE_CONTEXT_SQL).
const UNIT = { targetType: 'Principal', variant: 'synced', systemName: 'Klanten (upload)', isListed: true };
const verbs = (db) => db.writes.map(w => w.sql.split(' ').slice(0, 2).join(' '));
const LEFT = { ...base, claimKind: 'membership', attribute: 'former', principalId: PIET, value: 'is a former member', contextCategory: 'OrganizationalUnit' };

describe('decideClaim — the interview is right: marked former, on top of the members', () => {
  it('confirming that a listed person left marks them former, naming the source it overrides', async () => {
    const db = fakeDb(LEFT, { context: UNIT });
    const out = await decide(db, { status: 'confirmed' });
    expect(out.effect).toEqual({
      kind: 'formerMember', overrides: 'Klanten (upload)',
      changeRequest: { id: 'cr-1', summary: 'Remove Piet Jansen from Klanten', targetName: 'Klanten (upload)' },
    });
    expect(verbs(db)).toEqual(['UPDATE "ContextClaims"', 'INSERT INTO', 'SELECT id', 'INSERT INTO']);
    // The source is asked to stop listing them, resting on this claim and the mark.
    expect(db.writes[3].sql).toContain('INSERT INTO "ChangeRequests"');
    expect(db.writes[3].params.slice(0, 2)).toEqual(['RelationshipRemove', 7]);
    expect(db.writes[3].params.slice(8)).toEqual([CLAIM_ID, 'ovr-1', 'analyst@example.test']);
    const mark = db.writes[1];
    expect(mark.sql).toContain('INSERT INTO "ContextMemberOverrides"');
    expect(mark.params).toEqual([CTX, PIET, CLAIM_ID, 'Klanten (upload)', 'analyst@example.test']);
    // ContextMembers is never written: the source would add the row back.
    expect(db.writes.some(w => w.sql.includes('"ContextMembers"') && !w.sql.startsWith('SELECT'))).toBe(false);
  });

  it('a role claim whose words say they left marks them too; a manual list is "The member list"', async () => {
    const db = fakeDb({ ...LEFT, claimKind: 'roleHistory', attribute: null, value: 'worked on it, has since left' }, { context: { ...UNIT, variant: 'manual' } });
    // A list kept by hand is Identity Atlas's own: no source to ask, no change request.
    expect((await decide(db, { status: 'confirmed' })).effect).toEqual({ kind: 'formerMember', overrides: 'The member list', changeRequest: null });
    expect(db.writes.some(w => w.sql.includes('"ChangeRequests"'))).toBe(false);
  });

  it('the list is right (rejected): nothing but the claim; both true at different times (a period): no mark', async () => {
    const rejected = fakeDb(LEFT, { context: UNIT });
    expect((await decide(rejected, { status: 'rejected' })).effect).toEqual({ kind: 'none' });
    expect(verbs(rejected)).toEqual(['UPDATE "ContextClaims"']);

    const both = fakeDb(LEFT, { context: UNIT });
    expect((await decide(both, { status: 'edited', periodText: 'until 2024' })).effect).toEqual({ kind: 'none' });
    expect(verbs(both)).toEqual(['UPDATE "ContextClaims"']);
    expect(claimUpdate(both).params[1]).toBe('edited');
  });

  it('edited without a period is still "the interview is right"', async () => {
    const db = fakeDb(LEFT, { context: UNIT });
    expect((await decide(db, { status: 'edited', value: 'left in the summer' })).effect.kind).toBe('formerMember');
  });

  it('confirming that they are in it clears an earlier mark', async () => {
    const db = fakeDb({ ...LEFT, attribute: 'rejoined', value: 'is back' }, { context: UNIT });
    expect((await decide(db, { status: 'confirmed' })).effect).toEqual({ kind: 'none' });
    expect(db.writes[1].sql).toBe('DELETE FROM "ContextMemberOverrides" WHERE "contextId" = $1 AND "memberId" = $2');
    expect(db.writes[1].params).toEqual([CTX, PIET]);
    expect(db.writes[2].sql).toMatch(/^UPDATE "ChangeRequests" SET "requestStatus" = 'withdrawn'/);
    expect(db.writes[2].params).toEqual([CTX, PIET, 'A later decision says they are in the unit']);
  });

  it('marks nobody in a unit of people for an account, nor without a person', async () => {
    const people = fakeDb(LEFT, { context: { ...UNIT, targetType: 'Identity' } });
    expect((await decide(people, { status: 'confirmed' })).effect).toEqual({ kind: 'none' });
    expect(verbs(people)).toEqual(['UPDATE "ContextClaims"']);
    const nobody = fakeDb({ ...LEFT, principalId: null }, { context: UNIT });
    expect((await decide(nobody, { status: 'confirmed' })).effect).toEqual({ kind: 'none' });
  });
});

describe('canUndo / undoClaim', () => {
  it('undoes a rejection of any kind and a confirmation that changed only the claim', () => {
    expect(canUndo({ status: 'rejected', claimKind: 'description' })).toBe(true);
    expect(canUndo({ status: 'confirmed', claimKind: 'membership' })).toBe(true);
    expect(canUndo({ status: 'edited', claimKind: 'roleHistory' })).toBe(true);
    expect(canUndo({ status: 'confirmed', claimKind: 'role', roleSuggestion: null })).toBe(true);
    expect(canUndo({ status: 'confirmed', claimKind: 'role', roleSuggestion: 'Responsible' })).toBe(false);
    for (const k of ['description', 'property', 'alias']) expect(canUndo({ status: 'confirmed', claimKind: k })).toBe(false);
    expect(canUndo({ status: 'proposed', claimKind: 'membership' })).toBe(false);
  });

  it('puts the claim back to proposed and removes the mark it made', async () => {
    const db = fakeDb({ ...LEFT, status: 'confirmed' });
    const out = await undoClaim(db, CLAIM_ID);
    expect(out.unmarked).toBe(true);
    expect(db.writes[0]).toEqual({ sql: 'DELETE FROM "ContextMemberOverrides" WHERE "claimId" = $1', params: [CLAIM_ID] });
    expect(db.writes[1].sql).toMatch(/^UPDATE "ChangeRequests" SET "requestStatus" = 'withdrawn'.* WHERE "requestStatus" = 'open' AND "basisClaimId" = \$1$/);
    expect(db.writes[1].params).toEqual([CLAIM_ID, 'The decision was undone']);
    expect(db.writes[2].sql).toBe(`UPDATE "ContextClaims" SET "claimStatus" = 'proposed', "decidedBy" = NULL, "decidedAt" = NULL WHERE id = $1`);
  });

  it('refuses a bad id, a missing claim, an undecided one and one that changed the context', async () => {
    await expect(undoClaim(fakeDb(LEFT), 'x')).rejects.toMatchObject({ status: 400 });
    await expect(undoClaim(fakeDb(null), CLAIM_ID)).rejects.toMatchObject({ status: 404 });
    await expect(undoClaim(fakeDb(LEFT), CLAIM_ID)).rejects.toMatchObject({ status: 409, message: 'This claim has not been decided' });
    await expect(undoClaim(fakeDb({ ...base, status: 'confirmed' }), CLAIM_ID)).rejects.toMatchObject({ status: 409, message: /changed the context/ });
  });

  it('a rejected claim had no mark: unmarked is false', async () => {
    const db = fakeDb({ ...LEFT, status: 'rejected' }, { rowCount: 0 });
    expect((await undoClaim(db, CLAIM_ID)).unmarked).toBe(false);
  });
});
