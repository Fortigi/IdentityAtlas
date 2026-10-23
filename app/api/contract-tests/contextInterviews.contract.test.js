// Contract test — context interviews against real PostgreSQL (migration 097).
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

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const store = await import('../src/contexts/interviews/store.js');
const { decideClaim } = await import('../src/contexts/interviews/decide.js');
const { resolveSubjects } = await import('../src/contexts/interviews/subjects.js');

let pool;
let sysId;
let ctxId;
const P = {};

// The connection.js surface the feature uses, over this file's pool.
const db = {
  query: (sql, params) => pool.query(sql, params),
  queryOne: async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null,
  tx: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

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

  it('deleting the interview removes its claims and keeps what they changed, the role losing only its link', async () => {
    expect(await store.deleteInterview(db, ctxId, interview.id)).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM "ContextClaims" WHERE "contextId" = $1`, [ctxId])).rows[0].n).toBe(0);
    const roles = (await pool.query(`SELECT role, "sourceClaimId" FROM "ContextRoles" WHERE "contextId" = $1 ORDER BY role`, [ctxId])).rows;
    expect(roles).toEqual([{ role: 'Accountable', sourceClaimId: null }, { role: 'Responsible', sourceClaimId: null }]);
    expect((await pool.query(`SELECT description FROM "Contexts" WHERE id = $1`, [ctxId])).rows[0].description).toMatch(/From interview with Anna Voorbeeldig/);
  });
});
