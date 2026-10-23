// Contract test — survey templates against real PostgreSQL (migration 100).
// The unit tests are SQL-blind; this file runs the survey flow end to end on a
// migrated schema: a template and its versions, a scoped template, sending to a
// unit's Accountable down a tree, the rows a per-row question reads, a draft, a
// submit (one interview + its claims, proposed by the respondent), and a
// confirmed claim about a resource that changes nothing but the claim.
//
// Isolation on the shared contract DB: one private system, template keys under
// 'contract-'; everything this file creates is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const svc = await import('../src/contexts/surveys/service.js');
const store = await import('../src/contexts/surveys/store.js');
const interviewStore = await import('../src/contexts/interviews/store.js');
const { decideClaim } = await import('../src/contexts/interviews/decide.js');
const { SEED_TEMPLATES } = await import('../src/contexts/surveys/seedTemplates.js');

let pool;
let sysId;
const P = {};
const C = {};
let resId;

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
const deps = { db };

async function principal(key, displayName, extra = {}) {
  const r = await pool.query(
    `INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType", "jobTitle", department)
     VALUES (gen_random_uuid(), $1, $2, $3, 'User', $4, $5) RETURNING id`,
  [sysId, `srv-${key}`, displayName, extra.jobTitle ?? null, extra.department ?? null]);
  P[key] = r.rows[0].id;
}

async function context(key, { category, targetType = 'Principal', parent = null }) {
  const r = await pool.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "scopeSystemId", "parentContextId")
     VALUES (gen_random_uuid(), 'manual', $1, $2, $3, $2, $4, $5) RETURNING id`,
  [targetType, category, `srv-${key}`, sysId, parent]);
  C[key] = r.rows[0].id;
}

const seed = (key) => SEED_TEMPLATES.find(t => t.key === key);
const template = {};
const analyst = { me: null, canWrite: true, user: 'analyst@example.test' };

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  sysId = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('SurveyTest', 'surveys-1') RETURNING id`)).rows[0].id;
  await principal('anna', 'Anna Enquête');
  await principal('piet', 'Piet Enquête');
  await principal('kim', 'Kim Enquête', { jobTitle: 'Data scientist', department: 'Innovation' });
  await principal('tom', 'Tom Enquête', { jobTitle: 'Intern' });

  await context('customers', { category: 'OrganizationalUnit' });
  await context('acme', { category: 'OrganizationalUnit', parent: C.customers });
  await context('globex', { category: 'OrganizationalUnit', parent: C.customers });
  await context('elsewhere', { category: 'OrganizationalUnit' });
  await context('payroll', { category: 'LogicalApplication', targetType: 'Resource' });
  for (const k of ['kim', 'tom']) {
    await pool.query(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Principal', 'analyst')`, [C.acme, P[k]]);
  }
  await pool.query(`INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Accountable', 'analyst')`, [C.acme, P.anna]);
  await pool.query(`INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Accountable', 'analyst')`, [C.customers, P.piet]);

  resId = (await pool.query(
    `INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType", "extendedAttributes")
     VALUES (gen_random_uuid(), $1, 'srv-Payroll admins', 'Group', '{"owner": "Piet Enquête", "certificationFrequency": "yearly"}'::jsonb) RETURNING id`,
    [sysId])).rows[0].id;
  await pool.query(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Resource', 'analyst')`, [C.payroll, resId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "SurveyTemplates" WHERE key LIKE 'contract-%'`);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [sysId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [sysId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [sysId]);
  await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [sysId]);
  await pool.end();
});

describe('templates', () => {
  it('creates a template at version 1, and a changed definition becomes version 2', async () => {
    const t = await svc.createTemplate({ ...seed('customer-check'), key: 'contract-customer', scopeRootContextId: C.customers }, 'contract', deps);
    expect(t).toMatchObject({ key: 'contract-customer', currentVersion: 1, scopeRootName: 'srv-customers', contextCategory: 'OrganizationalUnit' });
    expect(t.definition).toEqual(seed('customer-check').definition);
    const changed = { ...t.definition, title: 'Changed' };
    const t2 = await svc.updateTemplate(t.id, { definition: changed }, 'contract', deps);
    expect(t2.currentVersion).toBe(2);
    expect(t2.versions.map(v => v.version)).toEqual([2, 1]);
    template.customer = t.id;
    template.roster = (await svc.createTemplate({ ...seed('unit-roster'), key: 'contract-roster' }, 'contract', deps)).id;
    template.review = (await svc.createTemplate({ ...seed('application-entitlement-review'), key: 'contract-review' }, 'contract', deps)).id;
  });

  it('a scoped template applies to its root and below, not elsewhere; another category never', async () => {
    const ids = async (ctx) => (await store.applicableTemplates(db, ctx)).map(t => t.id);
    expect(await ids(C.acme)).toEqual(expect.arrayContaining([template.customer, template.roster]));
    expect(await ids(C.elsewhere)).not.toContain(template.customer);
    expect(await ids(C.elsewhere)).toContain(template.roster);
    expect(await ids(C.payroll)).not.toContain(template.roster);
  });

  it('archiving hides it from the picker but keeps it in the full list', async () => {
    await svc.updateTemplate(template.customer, { archived: true }, 'contract', deps);
    expect((await store.applicableTemplates(db, C.acme)).map(t => t.id)).not.toContain(template.customer);
    expect((await store.listTemplates(db, { includeArchived: true })).map(t => t.id)).toContain(template.customer);
    await svc.updateTemplate(template.customer, { archived: false }, 'contract', deps);
  });
});

describe('sending and answering', () => {
  let requestId;

  it('sends down the tree to each unit\'s Accountable, skipping a unit without one', async () => {
    const r = await svc.sendSurvey(C.customers, { templateId: template.customer, toAccountable: true, includeSubContexts: true, dueAt: '2026-12-01' }, 'analyst', deps);
    expect(r.sent.map(s => [s.contextName, s.recipientName]).sort()).toEqual([['srv-acme', 'Anna Enquête'], ['srv-customers', 'Piet Enquête']]);
    expect(r.skipped.map(s => s.contextName)).toEqual(['srv-globex']);
    const rows = await store.listContextRequests(db, C.acme);
    expect(rows[0]).toMatchObject({ templateVersion: 2, status: 'sent', dueAt: '2026-12-01', recipientName: 'Anna Enquête' });
    requestId = rows[0].id;
    expect(await store.hasSurvey(db, P.anna, null)).toBe(true);
    expect((await store.requestsFor(db, P.anna, null)).map(x => x.id)).toEqual([requestId]);
    expect(await store.isRecipient(db, requestId, P.piet, null)).toBe(false);
  });

  it('opens with the unit\'s members as rows, and keeps a draft', async () => {
    const form = await svc.openSurvey(requestId, analyst, deps);
    expect(form.rows.belongs.map(r => [r.displayName, r.columns.jobTitle])).toEqual([['Kim Enquête', 'Data scientist'], ['Tom Enquête', 'Intern']]);
    await svc.saveDraft(requestId, { active: 'yes' }, analyst, deps);
    expect((await store.getRequest(db, requestId)).answers).toEqual({ active: 'yes' });
  });

  it('a submit is one interview from the survey and its claims, proposed by the respondent', async () => {
    const r = await svc.submitSurvey(requestId, {
      answers: { active: 'yes', isOwner: 'no', realOwner: { principalId: P.piet, displayName: 'Piet Enquête' }, belongs: { [P.kim]: 'yes', [P.tom]: 'no' } },
    }, analyst, deps);
    expect(r.claims).toBe(5);
    const req = await store.getRequest(db, requestId);
    expect(req).toMatchObject({ status: 'submitted', onBehalf: true, interviewId: r.interviewId, submittedBy: 'analyst@example.test' });
    const [iv] = await interviewStore.listInterviews(db, C.acme);
    expect(iv).toMatchObject({ id: r.interviewId, surveyRequestId: requestId, extractionStatus: 'done', principalId: P.anna });
    const claims = await interviewStore.listClaims(db, C.acme, ['proposed']);
    expect(claims.map(c => [c.surveyQuestionId, c.claimKind, c.attribute, c.subjectDisplayName, c.proposedBy, c.surveyRequestId]).sort()).toEqual([
      ['active', 'property', 'activeCustomer', null, 'respondent', requestId],
      ['belongs', 'membership', 'current', 'Kim Enquête', 'respondent', requestId],
      ['belongs', 'membership', 'former', 'Tom Enquête', 'respondent', requestId],
      ['isOwner', 'role', 'notOwner', 'Anna Enquête', 'respondent', requestId],
      ['realOwner', 'role', 'owner', 'Piet Enquête', 'respondent', requestId],
    ]);
    const { transcript } = await interviewStore.getInterview(db, C.acme, r.interviewId, { withTranscript: true });
    for (const c of claims) expect(transcript.slice(c.quoteStart, c.quoteEnd)).toBe(c.quote);
    await expect(svc.submitSurvey(requestId, { answers: {} }, analyst, deps)).rejects.toMatchObject({ status: 409 });
  });

  it('an entitlement review: rows are the application\'s resources with their owner; a confirmed claim about one changes nothing else', async () => {
    const sent = await svc.sendSurvey(C.payroll, { templateId: template.review, recipient: { principalId: P.anna } }, 'analyst', deps);
    const id = sent.sent[0].id;
    const form = await svc.openSurvey(id, analyst, deps);
    expect(form.rows.entitlementOwner).toEqual([expect.objectContaining({ id: resId, kind: 'Resource', columns: expect.objectContaining({ owner: 'Piet Enquête', certificationFrequency: 'yearly' }) })]);
    await svc.submitSurvey(id, { answers: { entitlementOwner: { [resId]: { ok: false, value: 'Anna Enquête' } } } }, analyst, deps);
    const [claim] = await interviewStore.listClaims(db, C.payroll, ['proposed']);
    expect(claim).toMatchObject({ subjectKind: 'Resource', resourceId: resId, subjectDisplayName: 'srv-Payroll admins', attribute: 'owner', value: 'Anna Enquête' });
    const before = await pool.query(`SELECT "extendedAttributes" FROM "Contexts" WHERE id = $1`, [C.payroll]);
    const r = await decideClaim(db, claim.id, { status: 'confirmed' }, 'analyst');
    expect(r.effect).toEqual({ kind: 'none' });
    expect((await pool.query(`SELECT "extendedAttributes" FROM "Contexts" WHERE id = $1`, [C.payroll])).rows).toEqual(before.rows);
    expect((await pool.query(`SELECT "extendedAttributes"->>'owner' AS o FROM "Resources" WHERE id = $1`, [resId])).rows[0].o).toBe('Piet Enquête');
  });

  it('withdrawing: only an unanswered request, and a withdrawn one no longer counts', async () => {
    const sent = await svc.sendSurvey(C.elsewhere, { templateId: template.roster, recipient: { principalId: P.tom } }, 'analyst', deps);
    expect(await store.hasSurvey(db, P.tom, null)).toBe(true);
    await svc.cancelSurvey(sent.sent[0].id, deps);
    expect(await store.hasSurvey(db, P.tom, null)).toBe(false);
    await expect(svc.cancelSurvey(sent.sent[0].id, deps)).rejects.toMatchObject({ status: 404 });
  });
});
