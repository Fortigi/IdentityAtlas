// Contract test — change requests (migration 103), end to end over the real app
// and PostgreSQL: deciding "the interview is right" for a person the uploaded
// list still has raises one open RelationshipRemove for that list, resting on the
// claim and the override; undo withdraws it; deciding again raises a fresh one;
// the list dropping the person (a re-import) resolves it on the next read; a unit
// whose source is gone resolves too; a list kept by hand raises nothing. The
// filters, and one open request per change, are checked against the real schema.
//
// Invented people only. Everything hangs off its own system and is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

const SOURCE = 'Ledenlijst (upload) contract';
let agent;
let pool;
let systemId;
const id = { unit: randomUUID(), gone: randomUUID(), manual: randomUUID(), led: randomUUID(), bea: randomUUID(), iv: randomUUID(), ivGone: randomUUID(), ivManual: randomUUID() };
const claim = { led: randomUUID(), bea: randomUUID(), manual: randomUUID() };
const q = (sql, params) => pool.query(sql, params);

async function context(cid, name, variant) {
  await q(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", "scopeSystemId")
           VALUES ($1, $2, 'Principal', 'Department', 'OrganizationalUnit', $3, $4)`, [cid, variant, name, variant === 'manual' ? null : systemId]);
  await q(`INSERT INTO "ContextInterviews" (id, "contextId", "intervieweeName", "interviewedAt", "fileName", transcript, "extractionStatus")
           VALUES ($1, $2, 'Anna Voorbeeld', '2026-10-01', 'gesprek.txt', 'They have left the team.', 'done')`,
  [cid === id.unit ? id.iv : cid === id.gone ? id.ivGone : id.ivManual, cid]);
}

async function listed(cid, pid, addedBy = 'sync') {
  await q(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Principal', $3)`, [cid, pid, addedBy]);
}

async function leftClaim(cid, interviewId, ctx, pid, name) {
  await q(`INSERT INTO "ContextClaims" (id, "interviewId", "contextId", "claimKind", "subjectKind", "principalId", "subjectName", "subjectMatch",
                                         attribute, value, quote, "proposedBy")
           VALUES ($1, $2, $3, 'membership', 'Person', $4, $5, 'name', 'former', $6, $7, 'model')`,
  [cid, interviewId, ctx, pid, name, `${name} is a former member`, `${name} has left the team`]);
}

beforeAll(async () => {
  process.env.FEATURE_ORG_KNOWLEDGE = 'true'; // decisions and change requests are organisation knowledge
  ({ agent, pool } = await bootContractApp());
  systemId = (await q(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING id`, [SOURCE])).rows[0].id;
  for (const [pid, name] of [[id.led, 'Led Ledeboer'], [id.bea, 'Bea Bakker']]) {
    await q(`INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType") VALUES ($1, $2, $3, $4, 'User')`,
      [pid, systemId, `cr-${pid}`, name]);
  }
  await context(id.unit, 'Contract CR unit', 'synced');
  await context(id.gone, 'Contract CR unit that goes', 'synced');
  await context(id.manual, 'Contract CR unit kept by hand', 'manual');
  await listed(id.unit, id.led);
  await listed(id.gone, id.bea);
  await listed(id.manual, id.bea, 'analyst');
  await leftClaim(claim.led, id.iv, id.unit, id.led, 'Led Ledeboer');
  await leftClaim(claim.bea, id.ivGone, id.gone, id.bea, 'Bea Bakker');
  await leftClaim(claim.manual, id.ivManual, id.manual, id.bea, 'Bea Bakker');
});

afterAll(async () => {
  await q(`DELETE FROM "ChangeRequests" WHERE "targetName" = $1 OR "contextId" = ANY($2::uuid[])`, [SOURCE, [id.unit, id.gone, id.manual]]);
  await q(`DELETE FROM "Contexts" WHERE id = ANY($1::uuid[])`, [[id.unit, id.gone, id.manual]]);
  await q(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL;
  delete process.env.FEATURE_ORG_KNOWLEDGE;
});

const decide = (cid, body) => agent.patch(`/api/contexts/claims/${cid}`).send(body);
const list = async (query = {}) => {
  const res = await agent.get('/api/change-requests').query(query);
  expect(res.status).toBe(200);
  return res.body;
};
const ofUnit = async (cid) => (await list({ contextId: cid })).items;

describe('change requests', () => {
  it('"the interview is right" raises one open RelationshipRemove for the list, on the claim and the override', async () => {
    const res = await decide(claim.led, { status: 'confirmed' });
    expect(res.status).toBe(200);
    expect(res.body.effect.changeRequest).toMatchObject({ summary: 'Remove Led Ledeboer from Contract CR unit', targetName: SOURCE });
    const [request, ...rest] = await ofUnit(id.unit);
    expect(rest).toEqual([]);
    const [override] = (await q(`SELECT id FROM "ContextMemberOverrides" WHERE "contextId" = $1`, [id.unit])).rows;
    expect(request).toMatchObject({
      id: res.body.effect.changeRequest.id, changeKind: 'RelationshipRemove', status: 'open',
      targetSystemId: systemId, targetName: SOURCE, contextId: id.unit, contextName: 'Contract CR unit',
      memberId: id.led, memberName: 'Led Ledeboer', basisClaimId: claim.led, overrideId: override.id,
      closedAt: null, closedReason: null,
    });
    // ContextMembers is the source's: the request asks, it does not remove.
    expect((await q(`SELECT count(*)::int AS n FROM "ContextMembers" WHERE "contextId" = $1`, [id.unit])).rows[0].n).toBe(1);
  });

  it('undo withdraws it, with the reason', async () => {
    expect((await agent.post(`/api/contexts/claims/${claim.led}/undo`)).status).toBe(200);
    const [request] = await ofUnit(id.unit);
    expect(request).toMatchObject({ status: 'withdrawn', closedReason: 'The decision was undone' });
    expect(Number.isNaN(Date.parse(request.closedAt))).toBe(false);
  });

  it('deciding again raises a fresh request; the withdrawn one stays as history', async () => {
    await decide(claim.led, { status: 'confirmed' });
    const items = await ofUnit(id.unit);
    expect(items.map(r => r.status)).toEqual(['open', 'withdrawn']);
    expect((await list({ contextId: id.unit })).counts).toEqual({ open: 1, resolved: 0, withdrawn: 1 });
  });

  it('the database keeps one open request per change', async () => {
    const [open] = (await ofUnit(id.unit)).filter(r => r.status === 'open');
    await expect(q(`INSERT INTO "ChangeRequests" ("changeKind", "targetSystemId", "targetName", "contextId", "memberId", summary)
                    VALUES ('RelationshipRemove', $1, $2, $3, $4, 'duplicate')`, [systemId, SOURCE, id.unit, id.led]))
      .rejects.toMatchObject({ code: '23505' });
    await expect(q(`UPDATE "ChangeRequests" SET "requestStatus" = 'resolved' WHERE id = $1`, [open.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('the list dropping Led (a re-import) resolves it on the next read', async () => {
    await q(`DELETE FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`, [id.unit, id.led]);
    const [request] = await ofUnit(id.unit);
    expect(request).toMatchObject({ status: 'resolved', closedReason: 'The source no longer lists them' });
    expect((await agent.get(`/api/contexts/${id.unit}/members`)).body.overriddenCount).toBe(0);
  });

  it('a unit whose source removed it resolves too, keeping its name', async () => {
    await decide(claim.bea, { status: 'confirmed' });
    expect((await ofUnit(id.gone)).map(r => r.status)).toEqual(['open']);
    const [raised] = (await q(`SELECT id FROM "ChangeRequests" WHERE "contextId" = $1`, [id.gone])).rows;
    await q(`DELETE FROM "Contexts" WHERE id = $1`, [id.gone]);
    const { items } = await list({ systemId });
    const request = items.find(r => r.id === raised.id);
    expect(request).toMatchObject({ status: 'resolved', closedReason: 'The source no longer has this unit', contextId: null, contextName: 'Contract CR unit that goes' });
  });

  it('a unit kept by hand is Identity Atlas\'s own: the decision marks, but asks no source', async () => {
    const res = await decide(claim.manual, { status: 'confirmed' });
    expect(res.body.effect).toMatchObject({ kind: 'formerMember', changeRequest: null });
    expect(await ofUnit(id.manual)).toEqual([]);
  });

  it('filters by status and system, and refuses a bad filter', async () => {
    const resolved = await list({ status: 'resolved', systemId });
    expect(resolved.items.length).toBe(2);
    expect(resolved.items.every(r => r.status === 'resolved' && r.targetSystemId === systemId)).toBe(true);
    expect(resolved.counts).toEqual({ open: 0, resolved: 2, withdrawn: 1 });
    expect((await agent.get('/api/change-requests').query({ status: 'sent' })).status).toBe(400);
    expect((await agent.get('/api/change-requests').query({ contextId: 'nope' })).status).toBe(400);
  });
});
