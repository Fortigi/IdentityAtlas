// Contract test — a member marked former by a decision (migration 099), end to end
// over the real app and PostgreSQL: deciding a "left, but still listed"
// contradiction "the interview is right" leaves ContextMembers as the source has
// it and marks the person former on top of it — the members list leaves them out
// (and says so), Previous members lists them with the decision and the access
// they still hold, the unit report marks them, the timeline says what was
// decided. "The list is right" and "both true, at different times" mark nobody.
// Undo reopens the contradiction and the person is a current member again.
//
// Invented people only. Everything hangs off its own system and is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

const SOURCE = 'Klanten (upload) contract';
let agent;
let pool;
let systemId;
const id = { unit: randomUUID(), led: randomUUID(), bea: randomUUID(), kai: randomUUID(), group: randomUUID(), iv: randomUUID() };
const claim = { led: randomUUID(), bea: randomUUID(), kai: randomUUID() };
const q = (sql, params) => pool.query(sql, params);

async function principal(pid, name) {
  await q(`INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType") VALUES ($1, $2, $3, $4, 'User')`,
    [pid, systemId, `ovr-${pid}`, name]);
  await q(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Principal', 'sync')`, [id.unit, pid]);
}

async function leftClaim(cid, pid, name, attribute = 'former') {
  await q(`INSERT INTO "ContextClaims" (id, "interviewId", "contextId", "claimKind", "subjectKind", "principalId", "subjectName", "subjectMatch",
                                         attribute, value, quote, "proposedBy")
           VALUES ($1, $2, $3, 'membership', 'Person', $4, $5, 'name', $6, $7, $8, 'model')`,
  [cid, id.iv, id.unit, pid, name, attribute, `${name} is a former member`, `${name} has left the team`]);
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  systemId = (await q(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING id`, [SOURCE])).rows[0].id;
  await q(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", "scopeSystemId")
           VALUES ($1, 'synced', 'Principal', 'Department', 'OrganizationalUnit', 'Contract override unit', $2)`, [id.unit, systemId]);
  await principal(id.led, 'Led Ledeboer');
  await principal(id.bea, 'Bea Bakker');
  await principal(id.kai, 'Kai Kuiper');
  // Led still holds access: the decision says nothing about it, the counts show it.
  await q(`INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES ($1, $2, 'Contract override group', 'Group')`, [id.group, systemId]);
  await q(`INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId") VALUES ($1, $2, 'Direct', $3)`, [id.group, id.led, systemId]);
  await q(`INSERT INTO "ContextInterviews" (id, "contextId", "intervieweeName", "interviewedAt", "fileName", transcript, "extractionStatus")
           VALUES ($1, $2, 'Anna Voorbeeld', '2026-10-01', 'gesprek.txt', 'Led has left the team. Bea has left the team. Kai has left the team.', 'done')`,
  [id.iv, id.unit]);
  await leftClaim(claim.led, id.led, 'Led Ledeboer');
  await leftClaim(claim.bea, id.bea, 'Bea Bakker', 'left');
  await leftClaim(claim.kai, id.kai, 'Kai Kuiper');
});

afterAll(async () => {
  await q(`DELETE FROM "ChangeRequests" WHERE "contextId" = $1`, [id.unit]);
  await q(`DELETE FROM "Contexts" WHERE id = $1`, [id.unit]);
  await q(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL;
});

const members = async (query = '') => (await agent.get(`/api/contexts/${id.unit}/members${query}`)).body;
const names = (body) => body.data.map(m => m.displayName);
const decide = (cid, body) => agent.patch(`/api/contexts/claims/${cid}`).send(body);

describe('a member marked former by a decision', () => {
  it('before any decision every listed member is current', async () => {
    const body = await members();
    expect([names(body), body.total, body.overriddenCount]).toEqual([['Bea Bakker', 'Kai Kuiper', 'Led Ledeboer'], 3, 0]);
  });

  it('"the interview is right" marks Led former, naming the source — ContextMembers untouched', async () => {
    const res = await decide(claim.led, { status: 'confirmed' });
    expect(res.status).toBe(200);
    expect(res.body.effect).toEqual({ kind: 'formerMember', overrides: SOURCE,
      changeRequest: { id: expect.any(String), summary: 'Remove Led Ledeboer from Contract override unit', targetName: SOURCE } });
    const listed = await q(`SELECT count(*)::int AS n FROM "ContextMembers" WHERE "contextId" = $1`, [id.unit]);
    expect(listed.rows[0].n).toBe(3);
    const [mark] = (await q(`SELECT "memberId", "claimId", overrides, "decidedBy" FROM "ContextMemberOverrides" WHERE "contextId" = $1`, [id.unit])).rows;
    expect(mark).toMatchObject({ memberId: id.led, claimId: claim.led, overrides: SOURCE });
  });

  it('the members list leaves Led out, says how many it left out, and shows them on request', async () => {
    const current = await members();
    expect([names(current), current.total, current.overriddenCount]).toEqual([['Bea Bakker', 'Kai Kuiper'], 2, 1]);
    expect(current.data.every(m => m.overridden === null)).toBe(true);
    const all = await members('?includeOverridden=true');
    expect([names(all), all.total]).toEqual([['Bea Bakker', 'Kai Kuiper', 'Led Ledeboer'], 3]);
    expect(all.data[2].overridden).toMatchObject({ overrides: SOURCE, claimId: claim.led });
    expect(Number.isNaN(Date.parse(all.data[2].overridden.at))).toBe(false);
    // The search and its count see the same rows.
    expect(await members('?search=led')).toMatchObject({ data: [], total: 0, overriddenCount: 1 });
    const detail = (await agent.get(`/api/contexts/${id.unit}`)).body;
    expect(detail.attributes.overriddenMemberCount).toBe(1);
    expect(detail.members.map(m => m.displayName)).toEqual(['Bea Bakker', 'Kai Kuiper']);
  });

  it('Previous members lists Led with the decision, still listed, and the access still held', async () => {
    const { data } = (await agent.get(`/api/contexts/${id.unit}/previous-members`)).body;
    expect(data.map(p => p.displayName)).toEqual(['Led Ledeboer']);
    expect(data[0]).toMatchObject({ stint: 'left', stillListed: true, nowMember: false, liveEntitlements: 1,
      decision: { overrides: SOURCE, claimId: claim.led } });
  });

  it('"the list is right" and "both true, at different times" leave Bea and Kai current', async () => {
    expect((await decide(claim.bea, { status: 'rejected' })).body.effect).toEqual({ kind: 'none' });
    expect((await decide(claim.kai, { status: 'edited', periodText: 'until 2024' })).body.effect).toEqual({ kind: 'none' });
    expect(names(await members())).toEqual(['Bea Bakker', 'Kai Kuiper']);
    const marks = await q(`SELECT "memberId" FROM "ContextMemberOverrides" WHERE "contextId" = $1`, [id.unit]);
    expect(marks.rows.map(r => r.memberId)).toEqual([id.led]);
  });

  it('the unit report marks Led rather than dropping the row', async () => {
    const res = await agent.get('/api/reports/unit-members/rows').query({ contexts: 'Contract override unit' });
    expect(res.status).toBe(200);
    const status = Object.fromEntries(res.body.rows.map(r => [r.displayName, r.status]));
    expect(status).toEqual({ 'Bea Bakker': 'current', 'Kai Kuiper': 'current', 'Led Ledeboer': 'marked former (decision)' });
  });

  it('the timeline says what was decided', async () => {
    const { events } = (await agent.get(`/api/contexts/${id.unit}/timeline`)).body;
    expect(events.map(e => e.summary)).toContain(`Decided: Led Ledeboer is a former member (overrides ${SOURCE})`);
  });

  it('undo reopens the contradiction and Led is a current member again', async () => {
    const res = await agent.post(`/api/contexts/claims/${claim.led}/undo`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unmarked: true, claim: { id: claim.led, status: 'proposed' } });
    const body = await members();
    expect([names(body), body.total, body.overriddenCount]).toEqual([['Bea Bakker', 'Kai Kuiper', 'Led Ledeboer'], 3, 0]);
    const { contradictions } = (await agent.get(`/api/contexts/${id.unit}/claims`)).body;
    expect(contradictions.find(c => c.claimIds.includes(claim.led))).toMatchObject({ rule: 'leftButMember', status: 'open' });
    expect((await agent.get(`/api/contexts/${id.unit}/previous-members`)).body.data).toEqual([]);
    // Undoing what was not decided is refused.
    expect((await agent.post(`/api/contexts/claims/${claim.led}/undo`)).status).toBe(409);
  });
});
