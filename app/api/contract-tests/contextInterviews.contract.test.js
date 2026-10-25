// Contract test — context interviews against real PostgreSQL (migrations 099, 100).
// The unit tests are SQL-blind; this file runs every statement of
// contexts/interviews/store.js, the first-name lookup of subjects.js and the
// confirm flow of decide.js on a migrated schema, and asserts what landed:
// the claim rows, the description and attribute written, the ContextRole with
// its sourceClaimId, the Accountable conflict, and what deleting an interview
// leaves behind.
//
// Isolation on the shared contract DB: one private system; everything this file
// creates is deleted in afterAll (claims and interviews go with their context).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { poolDb } from './poolDb.js';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const store = await import('../src/contexts/interviews/store.js');
const { decideClaim } = await import('../src/contexts/interviews/decide.js');
const { resolveSubjects, resolveClaimSubjects } = await import('../src/contexts/interviews/subjects.js');

let pool;
let sysId;
let ctxId;
const P = {};

// The connection.js surface the feature uses, over this file's pool.
const db = poolDb(() => pool);

async function principal(key, displayName) {
  const r = await pool.query(
    `INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType")
     VALUES (gen_random_uuid(), $1, $2, $3, 'User') RETURNING id`, [sysId, `ivw-${key}`, displayName]);
  P[key] = r.rows[0].id;
}

let interview;
const claimIds = {};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  sysId = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('InterviewTest', 'interviews-1') RETURNING id`)).rows[0].id;
  await principal('anna', 'Anna Voorbeeldig');
  await principal('piet', 'Piet Proefpersoon');
  await principal('yara', 'Yara Testpersoon');
  await principal('zeldzaam', 'Henk Zeldzaamhuizen');
  await principal('naast', 'Quirijn Naastgelegen');
  await principal('eenling', 'Xandrijn Eenling');
  await principal('zwaan1', 'Zwaantje Eerste');
  await principal('zwaan2', 'Zwaantje Tweede');
  ctxId = (await pool.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId", description)
     VALUES (gen_random_uuid(), 'manual', 'Principal', 'LogicalApplication', 'ivw-Planner', 'LogicalApplication', $1, 'The planning tool.') RETURNING id`,
    [sysId])).rows[0].id;
  await pool.query(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Principal', 'analyst')`, [ctxId, P.piet]);

  interview = await store.insertInterview(db, {
    contextId: ctxId, principalId: P.anna, intervieweeName: 'Anna Voorbeeldig', interviewedAt: '2026-10-01',
    fileName: 'gesprek.vtt', transcript: 'Anna Voorbeeldig: I am the owner, but Piet does the day-to-day.', language: 'en',
    extractionStatus: 'pending', createdBy: 'contract@example.test',
  });
  const ids = await store.insertClaims(db, { interviewId: interview.id, contextId: ctxId, proposedBy: 'model' }, [
    { claimKind: 'description', subjectKind: 'Context', value: 'Schedules the nursing shifts', quote: 'I am the owner', confidence: 0.8 },
    { claimKind: 'property', subjectKind: 'Context', attribute: 'users', value: 'about 400 nurses', quote: 'I am the owner' },
    { claimKind: 'role', subjectKind: 'Person', principalId: P.piet, subjectName: 'Piet', subjectMatch: 'firstName', attribute: 'dayToDay', value: 'does the day-to-day', roleSuggestion: 'Responsible', quote: 'Piet does the day-to-day' },
    { claimKind: 'role', subjectKind: 'Person', principalId: P.yara, subjectName: 'Yara', subjectMatch: 'name', attribute: 'owner', value: 'owner', roleSuggestion: 'Accountable' },
    { claimKind: 'roleHistory', subjectKind: 'Person', principalId: P.piet, subjectName: 'Piet', attribute: 'member', value: 'junior', periodFrom: '2015-01-01', periodText: 'early years' },
  ]);
  [claimIds.description, claimIds.property, claimIds.responsible, claimIds.accountable, claimIds.history] = ids;
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [sysId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [sysId]);
  await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [sysId]);
  await pool.end();
});

describe('context interviews against PostgreSQL', () => {
  it('stores the interview with its date as text and lists it with claim counts', async () => {
    expect(interview).toMatchObject({ interviewedAt: '2026-10-01', extractionStatus: 'pending', principalId: P.anna });
    const [row] = await store.listInterviews(db, ctxId);
    expect(row).toMatchObject({ id: interview.id, proposed: 5, confirmed: 0, rejected: 0 });
    expect(row.transcript).toBeUndefined();
    expect((await store.getInterview(db, ctxId, interview.id, { withTranscript: true })).transcript).toMatch(/day-to-day/);
  });

  it('lists the claims with their source, matched names and dates as text', async () => {
    const claims = await store.listClaims(db, ctxId, ['proposed']);
    const history = claims.find(c => c.id === claimIds.history);
    expect(history).toMatchObject({ periodFrom: '2015-01-01', periodTo: null, subjectDisplayName: 'Piet Proefpersoon', status: 'proposed', proposedBy: 'model', intervieweeName: 'Anna Voorbeeldig', interviewedAt: '2026-10-01' });
    expect(claims.find(c => c.id === claimIds.description).confidence).toBe(0.8);
  });

  it('finds a first name among the context\'s own people', async () => {
    const out = await resolveSubjects(db, ['Piet'], { contextId: ctxId, interviewee: { principalId: P.anna, name: 'Anna Voorbeeldig' } });
    expect(out.get('Piet')).toEqual({ principalId: P.piet, match: 'firstName' });
  });

  it('a first name widens: the people the claims name, a SameUnitAs variant\'s members, then one account org-wide', async () => {
    const variant = (await pool.query(
      `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId")
       VALUES (gen_random_uuid(), 'manual', 'Principal', 'Department', 'ivw-Planner team', 'OrganizationalUnit', $1) RETURNING id`, [sysId])).rows[0].id;
    await pool.query(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Principal', 'analyst')`, [variant, P.naast]);
    await pool.query(`INSERT INTO "ContextRelationships" ("contextId", "relatedContextId", "relationshipType", "addedBy") VALUES ($1, $2, 'SameUnitAs', 'analyst')`, [variant, ctxId]);
    const out = await resolveSubjects(db, ['Yara', 'Quirijn', 'Xandrijn', 'Zwaantje'], { contextId: ctxId, interviewee: { principalId: P.anna, name: 'Anna Voorbeeldig' } });
    expect(out.get('Yara')).toEqual({ principalId: P.yara, match: 'firstName' });
    expect(out.get('Quirijn')).toEqual({ principalId: P.naast, match: 'firstName' });
    expect(out.get('Xandrijn')).toEqual({ principalId: P.eenling, match: 'firstName' });
    expect(out.get('Zwaantje')).toEqual({ match: null });
  });

  it('a surname only one live user account ends in is matched, flagged fuzzy', async () => {
    const out = await resolveClaimSubjects(db, [{ subjectName: 'Zeldzaamhuizen', quote: 'Zeldzaamhuizen does it' }], { contextId: ctxId, interviewee: { principalId: P.anna, name: 'Anna Voorbeeldig' } });
    expect(out).toEqual([{ principalId: P.zeldzaam, match: 'fuzzy', subjectName: 'Zeldzaamhuizen' }]);
  });

  it('confirming writes the description section, the attribute and the Responsible with its source', async () => {
    await decideClaim(db, claimIds.description, { status: 'confirmed' }, 'contract@example.test');
    await decideClaim(db, claimIds.property, { status: 'confirmed', value: 'about 450 nurses' }, 'contract@example.test');
    const r = await decideClaim(db, claimIds.responsible, { status: 'confirmed' }, 'contract@example.test');
    const ctx = (await pool.query(`SELECT description, "extendedAttributes" FROM "Contexts" WHERE id = $1`, [ctxId])).rows[0];
    expect(ctx.description).toBe('The planning tool.\n\nFrom interview with Anna Voorbeeldig, 2026-10-01:\nSchedules the nursing shifts');
    expect(ctx.extendedAttributes.users).toBe('about 450 nurses');
    const role = (await pool.query(`SELECT role, "principalId", "addedBy", "sourceClaimId" FROM "ContextRoles" WHERE id = $1`, [r.effect.roleId])).rows[0];
    expect(role).toEqual({ role: 'Responsible', principalId: P.piet, addedBy: 'analyst', sourceClaimId: claimIds.responsible });
    expect(r.claim).toMatchObject({ status: 'confirmed', appliedRoleId: r.effect.roleId, decidedBy: 'contract@example.test' });
    expect((await store.getClaimRow(db, claimIds.property)).status).toBe('edited');
  });

  it('an Accountable over an existing one is refused until replace, and nothing changes in between', async () => {
    await pool.query(`INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Accountable', 'analyst')`, [ctxId, P.anna]);
    const err = await decideClaim(db, claimIds.accountable, { status: 'confirmed' }, 'u').catch(e => e);
    expect([err.status, err.details.current.principalId]).toEqual([409, P.anna]);
    expect((await store.getClaimRow(db, claimIds.accountable)).status).toBe('proposed');
    await decideClaim(db, claimIds.accountable, { status: 'confirmed', replace: true }, 'u');
    const acc = await store.currentAccountable(db, ctxId);
    expect(acc).toMatchObject({ principalId: P.yara, displayName: 'Yara Testpersoon' });
  });

  it('counts mentions per person over the statuses asked', async () => {
    expect((await store.mentionsOf(db, 'principalId', P.piet, ['proposed', 'confirmed', 'edited']))[0]).toMatchObject({ contextId: ctxId, claims: 2, lastInterviewedAt: '2026-10-01' });
    expect(await store.mentionsOf(db, 'principalId', P.piet, ['rejected'])).toEqual([]);
  });

  // Migration 100: membership and alias claims, the relevance tier, quote offsets.
  it('stores membership and alias claims with their tier and offsets; rejects the low tier in one statement', async () => {
    const [left, alias, low] = await store.insertClaims(db, { interviewId: interview.id, contextId: ctxId, proposedBy: 'model' }, [
      { claimKind: 'membership', subjectKind: 'Person', principalId: P.yara, subjectName: 'Yara', attribute: 'left', value: 'left the team', periodText: 'last month', relevance: 'high', quote: 'I am the owner', quoteStart: 18, quoteEnd: 32 },
      { claimKind: 'alias', subjectKind: 'Context', value: 'Rooster', relevance: 'high' },
      { claimKind: 'description', subjectKind: 'Context', value: 'A nice canteen', relevance: 'low' },
    ]);
    expect(await store.getClaimRow(db, left)).toMatchObject({ claimKind: 'membership', attribute: 'left', relevance: 'high', quoteStart: 18, quoteEnd: 32 });
    expect(await store.rejectProposed(db, ctxId, { relevance: 'low' }, 'u')).toEqual([low]);
    expect((await store.getClaimRow(db, low)).status).toBe('rejected');
    expect((await store.interviewQuotes(db, interview.id)).find(q => q.id === left)).toMatchObject({ quoteStart: 18, quoteEnd: 32 });
    const r = await decideClaim(db, alias, { status: 'confirmed' }, 'u');
    expect(r.effect).toEqual({ kind: 'alias', aliases: ['Rooster'] });
    expect((await pool.query(`SELECT "extendedAttributes"->'aliases' AS a FROM "Contexts" WHERE id = $1`, [ctxId])).rows[0].a).toEqual(['Rooster']);
  });

  // Re-extraction: what is decided on the context, its aliases, and other contexts' names.
  it('reads the decided claims of the context, its aliases for the prompt, and which names are another context\'s', async () => {
    await pool.query(
      `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId", "extendedAttributes")
       VALUES (gen_random_uuid(), 'manual', 'Principal', 'OrganizationalUnit', 'ivw-Kustwacht', 'OrganizationalUnit', $1, '{"aliases": ["ivw-Kustpost"]}'::jsonb),
              (gen_random_uuid(), 'manual', 'Principal', 'OrganizationalUnit', 'ivw-Zonder', 'OrganizationalUnit', $1, '{"aliases": "not a list"}'::jsonb)`, [sysId]);
    expect((await store.loadForExtraction(db, interview.id)).contextAliases).toEqual(['Rooster']);
    const decided = await store.decidedClaims(db, ctxId);
    const said = decided.map(c => `${c.claimKind}:${c.value}`);
    // Confirmed (an alias, the earlier tests' description), edited (the property) and rejected (the low tier) — not a proposed one.
    expect(said).toEqual(expect.arrayContaining(['alias:Rooster', 'description:A nice canteen', 'description:Schedules the nursing shifts', 'property:about 450 nurses']));
    expect(said).not.toContain('roleHistory:junior');
    expect(decided.find(c => c.claimKind === 'role' && c.value === 'owner')).toMatchObject({ principalId: P.yara, identityId: null });
    const names = await store.otherContextNames(db, ctxId, ['ivw kustwacht', 'ivw kustpost', 'rooster', 'ivw zonder', 'ivw nergens']);
    expect(names.sort()).toEqual(['ivw kustpost', 'ivw kustwacht', 'ivw zonder']);
    expect(await store.otherContextNames(db, ctxId, [])).toEqual([]);
  });

  it('reads the person claims set-based for a page of members, and the previous members with their live entitlements', async () => {
    const page = await store.memberClaims(db, ctxId, 'Principal', [P.piet, P.yara], ['proposed', 'confirmed', 'edited']);
    expect(page.map(c => `${c.memberId === P.piet ? 'piet' : 'yara'}:${c.claimKind}`).sort()).toEqual(['piet:role', 'piet:roleHistory', 'yara:membership', 'yara:role']);
    const people = await store.peopleClaims(db, ctxId, ['proposed']);
    expect(people.find(c => c.claimKind === 'membership')).toMatchObject({ principalId: P.yara, isMember: false, accountDeleted: false, subjectDisplayName: 'Yara Testpersoon' });
    expect(people.filter(c => c.principalId === P.piet).every(c => c.isMember)).toBe(true);

    const resource = async (name) => (await pool.query(
      `INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES (gen_random_uuid(), $1, $2, 'Group') RETURNING id`, [sysId, name])).rows[0].id;
    const linked = await resource('ivw-group');
    const other = await resource('ivw-other');
    const gone = await resource('ivw-gone');
    for (const [r, deletedAt] of [[linked, null], [other, null], [gone, '2026-01-01']]) {
      await pool.query(`INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "deletedAt") VALUES ($1, $2, 'Direct', $3, $4)`,
        [r, P.yara, sysId, deletedAt]);
    }
    const variant = (await pool.query(
      `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId")
       VALUES (gen_random_uuid(), 'manual', 'Resource', 'LogicalApplication', 'ivw-Planner groups', 'LogicalApplication', $1) RETURNING id`, [sysId])).rows[0].id;
    await pool.query(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Resource', 'analyst')`, [variant, linked]);
    await pool.query(`INSERT INTO "ContextRelationships" ("contextId", "relatedContextId", "relationshipType", "addedBy") VALUES ($1, $2, 'SameUnitAs', 'analyst')`, [variant, ctxId]);

    const { counts, linkedResources } = await store.entitlementCounts(db, ctxId, [P.yara], []);
    expect(linkedResources).toBe(1);
    expect(counts.get(`principalId:${P.yara}`)).toEqual({ liveEntitlements: 2, linkedEntitlements: 1 });
    await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [sysId]);
    await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [sysId]);
  });

  it('the timeline reads the interview, its extraction count and the decided claims with the role they set', async () => {
    const { interviews, decisions } = await store.timelineRows(db, ctxId, { sinceDays: 30, statuses: ['confirmed', 'edited', 'rejected'], limit: 50, withInterviews: true });
    expect(interviews.find(i => i.id === interview.id)).toMatchObject({ intervieweeName: 'Anna Voorbeeldig', fileName: 'gesprek.vtt', interviewedAt: '2026-10-01' });
    expect(interviews.find(i => i.id === interview.id).extracted).toBeGreaterThan(0);
    const responsible = decisions.find(d => d.id === claimIds.responsible);
    expect(responsible).toMatchObject({ status: 'confirmed', appliedRole: 'Responsible', roleHolderName: 'Piet Proefpersoon', roleHolderIsAccount: true, roleHolderId: P.piet });
    const readerOnly = await store.timelineRows(db, ctxId, { sinceDays: 30, statuses: ['confirmed', 'edited'], limit: 50, withInterviews: false });
    expect(readerOnly.interviews).toEqual([]);
    expect(readerOnly.decisions.every(d => d.status !== 'rejected')).toBe(true);
  });

  it('reads the context, its source and which named people are members for the contradiction check', async () => {
    const { loadContradictions, CONTRADICTION_CONTEXT_SQL } = await import('../src/contexts/interviews/contradictions.js');
    const context = (await pool.query(CONTRADICTION_CONTEXT_SQL, [ctxId])).rows[0];
    expect(context).toMatchObject({ targetType: 'Principal', variant: 'manual', systemName: 'interviews-1' });
    const gone = { id: '00000000-0000-4000-8000-0000000000aa', claimKind: 'membership', attribute: 'left', value: 'left', status: 'proposed', principalId: P.piet, subjectDisplayName: 'Piet Proefpersoon', interviewedAt: '2026-10-01' };
    const out = await loadContradictions(db, ctxId, [gone], null);
    expect(out.map(c => [c.rule, c.other.statement])).toEqual([['leftButMember', 'The member list still lists Piet Proefpersoon as a member']]);
  });

  it('the context timeline leaves out updates that only moved bookkeeping', async () => {
    process.env.USE_SQL = 'true';
    const { timelineHandler } = await import('../src/routes/recentChanges/timeline.js');
    await pool.query(`UPDATE "Contexts" SET "lastCalculatedAt" = now() WHERE id = $1`, [ctxId]);
    await pool.query(`UPDATE "Contexts" SET "displayName" = 'ivw-Planner 2' WHERE id = $1`, [ctxId]);
    let body;
    const res = { json: (b) => { body = b; }, status: () => res };
    await timelineHandler('context')({ params: { id: ctxId }, query: { sinceDays: '30' } }, res);
    const attrs = body.events.filter(e => e.eventKind === 'attribute').map(e => e.attribute?.field);
    expect(attrs).toContain('displayName');
    expect(attrs).not.toContain('lastCalculatedAt');
    expect(body.events.some(e => e.eventKind === 'interview')).toBe(true);
  });

  it('deleting the interview removes its claims and keeps what they changed, the role losing only its link', async () => {
    expect(await store.deleteInterview(db, ctxId, interview.id)).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM "ContextClaims" WHERE "contextId" = $1`, [ctxId])).rows[0].n).toBe(0);
    const roles = (await pool.query(`SELECT role, "sourceClaimId" FROM "ContextRoles" WHERE "contextId" = $1 ORDER BY role`, [ctxId])).rows;
    expect(roles).toEqual([{ role: 'Accountable', sourceClaimId: null }, { role: 'Responsible', sourceClaimId: null }]);
    expect((await pool.query(`SELECT description FROM "Contexts" WHERE id = $1`, [ctxId])).rows[0].description).toMatch(/From interview with Anna Voorbeeldig/);
  });
});
