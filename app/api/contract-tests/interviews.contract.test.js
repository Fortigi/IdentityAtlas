// Contract test — the Interviews API (/api/v1/interviews) against a real PostgreSQL 16
// schema: the mention search's trigram SQL and scope CTE, the team context read, the
// append-only triggers of migration 084, and the rule that nothing an interview does
// writes to the canonical tables.
//
// Self-contained: seeds its own system, three people and one team context.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
const ids = { william: randomUUID(), peterA: randomUUID(), peterB: randomUUID(), team: randomUUID() };
const sha = (s) => createHash('sha256').update(s.normalize('NFC'), 'utf8').digest('hex');

async function canonicalCounts() {
  const { rows } = await pool.query(`SELECT
      (SELECT count(*) FROM "Resources") AS r, (SELECT count(*) FROM "ResourceAssignments") AS ra,
      (SELECT count(*) FROM "Identities") AS i, (SELECT count(*) FROM "Contexts") AS c,
      (SELECT count(*) FROM "ContextMembers") AS cm`);
  return rows[0];
}

beforeAll(async () => {
  process.env.FEATURE_INTERVIEWS = 'true';
  ({ agent, pool } = await bootContractApp());
  systemId = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-interviews') RETURNING "id"`)).rows[0].id;
  const person = (id, name, title, dept) => pool.query(
    `INSERT INTO "Identities" ("id", "displayName", "jobTitle", "department") VALUES ($1, $2, $3, $4)`, [id, name, title, dept]);
  await person(ids.william, 'William de Boer', 'Platform engineer', 'ICT Beheer');
  await person(ids.peterA, 'Peter Jansen', 'Database administrator', 'ICT Beheer');
  await person(ids.peterB, 'Peter de Vries', 'Controller', 'Finance');
  await pool.query(`INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId")
                    VALUES ($1, 'manual', 'Identity', 'Team', 'ICT Beheer (contract)', $2)`, [ids.team, systemId]);
  for (const m of [ids.william, ids.peterA]) {
    await pool.query(`INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy") VALUES ($1, 'Identity', $2, 'analyst')`, [ids.team, m]);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Interviews" WHERE "title" = 'contract-interviews'`);
  await pool.query(`DELETE FROM "Contexts" WHERE "id" = $1`, [ids.team]);
  await pool.query(`DELETE FROM "Identities" WHERE "id" = ANY($1::uuid[])`, [[ids.william, ids.peterA, ids.peterB]]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL;
  delete process.env.FEATURE_INTERVIEWS;
});

describe('GET /api/v1/interviews/entities/search — real SQL', () => {
  it('finds one William, in the team, and only suggests him', async () => {
    const res = await agent.get(`/api/v1/interviews/entities/search?q=William&scopeContextId=${ids.team}`);
    expect(res.status).toBe(200);
    expect(res.body.candidates.map(c => [c.id, c.inScope])).toEqual([[ids.william, true]]);
    expect(res.body.outcome).toEqual({ state: 'suggested', entityId: ids.william, reason: 'single-candidate' });
  });

  it('keeps two Peters ambiguous without a scope, both with distinguishing labels', async () => {
    const res = await agent.get('/api/v1/interviews/entities/search?q=Peter');
    const ours = res.body.candidates.filter(c => [ids.peterA, ids.peterB].includes(c.id));
    expect(ours.map(c => c.label).sort()).toEqual(['Controller · Finance', 'Database administrator · ICT Beheer']);
    expect(res.body.outcome.state).toBe('unresolved');
  });

  it('with the team as scope, ranks the Peter in the team first', async () => {
    const res = await agent.get(`/api/v1/interviews/entities/search?q=Peter&scopeContextId=${ids.team}`);
    expect(res.body.candidates[0]).toMatchObject({ id: ids.peterA, inScope: true });
  });

  it('reports a resource nobody has as not_found', async () => {
    const res = await agent.get('/api/v1/interviews/entities/search?q=productieomgeving-contract&kind=resource');
    expect(res.body).toMatchObject({ candidates: [], outcome: { state: 'not_found' } });
  });
});

describe('GET /api/v1/interviews/context — real SQL', () => {
  it('lists the team members', async () => {
    const res = await agent.get(`/api/v1/interviews/context?subjectIdentityId=${ids.peterA}&scopeContextId=${ids.team}`);
    expect(res.status).toBe(200);
    expect(res.body.subject.displayName).toBe('Peter Jansen');
    expect(res.body.scope.members.items.map(m => m.displayName)).toEqual(['Peter Jansen', 'William de Boer']);
    expect(res.body.scope.members).toMatchObject({ total: 2, truncated: false });
  });
});

describe('the interview store — real SQL', () => {
  it('runs a whole interview without changing a canonical table, and keeps evidence immutable', async () => {
    const before = await canonicalCounts();
    const iv = await agent.post('/api/v1/interviews').send({ interviewType: 'role-mining', title: 'contract-interviews', noticeConfirmed: true, noticeVersion: 'nl-1' });
    expect(iv.status).toBe(201);
    const base = `/api/v1/interviews/${iv.body.id}`;

    const m = await agent.post(`${base}/mentions`).send({ mentions: [{ segmentId: 's1', literalText: 'William', startMs: 0, endMs: 500, spanStart: 0, spanEnd: 7 }] });
    expect(m.status).toBe(201);
    const mentionId = m.body.data[0].id;
    expect((await agent.post(`${base}/mentions/${mentionId}/resolutions`).send({ state: 'suggested', origin: 'detector', entityKind: 'identity', entityId: ids.william, matchScore: 0.71, candidateCount: 1 })).status).toBe(201);
    expect((await agent.post(`${base}/mentions/${mentionId}/resolutions`).send({ state: 'confirmed', entityKind: 'identity', entityId: ids.william })).status).toBe(201);

    const excerpt = 'William beheert de productieomgeving';
    const ev = { segmentId: 's1', startMs: 0, endMs: 3000, spanStart: 0, spanEnd: excerpt.length, excerptHash: sha(excerpt) };
    const s1 = await agent.post(`${base}/statements`).send({ subject: { mentionId }, predicate: 'beheert', object: { literal: 'productieomgeving' }, evidence: [ev] });
    expect(s1.status).toBe(201);
    const p1 = await agent.post(`${base}/proposals`).send({ proposalKind: 'responsibility', statementId: s1.body.id, summary: 'William beheert productie' });
    const s2 = await agent.post(`${base}/statements/${s1.body.id}/revisions`).send({ subject: { mentionId }, predicate: 'is eigenaar van', object: { literal: 'productieomgeving' }, evidence: [{ ...ev, startMs: 100 }] });
    expect(s2.body).toMatchObject({ lineageId: s1.body.id, version: 2 });

    // Approving the proposal on version 1 is refused now that version 2 exists.
    expect((await agent.post(`${base}/proposals/${p1.body.id}/reviews`).send({ action: 'approve', targetVersion: 1 })).status).toBe(409);
    const p2 = await agent.post(`${base}/proposals`).send({ proposalKind: 'responsibility', statementId: s2.body.id, summary: 'William is eigenaar' });
    const approved = await agent.post(`${base}/proposals/${p2.body.id}/reviews`).send({ action: 'approve', targetVersion: 2 });
    expect(approved.body).toMatchObject({ reviewState: 'approved', promoted: false });

    // The first version's evidence is still there, unchanged, and the database refuses to change it.
    const old = await pool.query(`SELECT "startMs" FROM "InterviewEvidence" WHERE "statementId" = $1`, [s1.body.id]);
    expect(old.rows).toEqual([{ startMs: 0 }]);
    await expect(pool.query(`UPDATE "InterviewEvidence" SET "startMs" = 5 WHERE "statementId" = $1`, [s1.body.id])).rejects.toThrow(/append-only/);

    const detail = await agent.get(base);
    expect(detail.body.mentions[0]).toMatchObject({ state: 'confirmed', entityId: ids.william });
    expect(detail.body.proposals.map(p => p.reviewState)).toEqual(['proposed', 'approved']);

    expect(await canonicalCounts()).toEqual(before);

    const del = await agent.delete(base);
    expect(del.body).toEqual({ deleted: true, removed: { mentions: 1, statements: 2, proposals: 2 } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM "InterviewEvidence" WHERE "statementId" = $1`, [s1.body.id])).rows[0].n).toBe(0);
    const events = await pool.query(`SELECT "action" FROM "InterviewEvents" WHERE "interviewId" = $1 ORDER BY "id"`, [iv.body.id]);
    expect(events.rows.at(-1).action).toBe('deleted');
    await expect(pool.query(`DELETE FROM "InterviewEvents" WHERE "interviewId" = $1`, [iv.body.id])).rejects.toThrow(/append-only/);
  });
});
