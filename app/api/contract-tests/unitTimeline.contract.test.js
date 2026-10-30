// Contract test — a unit's timeline in words, and its Sources, over the real app
// and PostgreSQL.
//
// Timeline: migration 109 records each membership added or taken away, keyed by
// the context; the timeline then says who joined and left (and by which list),
// how the Accountable changed, what changed about the people (a job title — of
// someone who has since left, too), and that the unit was renamed.
//
// Sources: an interview added on the PARENT unit that makes claims about this
// unit's people is one of its sources, marked as added there.
//
// Invented people only. Everything hangs off its own system and is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

const LIST = 'unit-timeline-contract.xlsx';
let agent;
let pool;
let systemId;
const id = { parent: randomUUID(), unit: randomUUID(), lisa: randomUUID(), tom: randomUUID(), max: randomUUID(), iv: randomUUID(), claim: randomUUID() };
const q = (sql, params) => pool.query(sql, params);
const member = (memberId, memberType, addedBy) => q(
  `INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, $3, $4)`, [id.unit, memberId, memberType, addedBy]);

beforeAll(async () => {
  process.env.FEATURE_ORG_KNOWLEDGE = 'true';
  ({ agent, pool } = await bootContractApp());
  systemId = (await q(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('Upload', $1) RETURNING id`, [LIST])).rows[0].id;
  await q(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", "scopeSystemId")
           VALUES ($1, 'synced', 'Identity', 'Department', 'OrganizationalUnit', 'TL Claims Handling', $2),
                  ($3, 'synced', 'Identity', 'Team', 'OrganizationalUnit', 'TL Claims', $2)`, [id.parent, systemId, id.unit]);
  await q(`UPDATE "Contexts" SET "parentContextId" = $1 WHERE id = $2`, [id.parent, id.unit]);
  await q(`INSERT INTO "Identities" (id, "displayName") VALUES ($1, 'Lisa Vos (tl)'), ($2, 'Tom Bakker (tl)')`, [id.lisa, id.tom]);
  await q(`INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType", "jobTitle")
           VALUES ($1, $2, 'tl-max', 'Max Jacobs (tl)', 'User', 'Loss adjuster')`, [id.max, systemId]);
});

afterAll(async () => {
  await q(`DELETE FROM "Contexts" WHERE id = ANY($1::uuid[])`, [[id.unit, id.parent]]);
  await q(`DELETE FROM "Identities" WHERE id = ANY($1::uuid[])`, [[id.lisa, id.tom]]);
  await q(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL;
  delete process.env.FEATURE_ORG_KNOWLEDGE;
});

const timeline = async () => (await agent.get(`/api/contexts/${id.unit}/timeline?sinceDays=30`)).body;

describe('migration 109 — membership history', () => {
  it('records a join and a leave in _history, keyed by the context; an update records nothing', async () => {
    await member(id.lisa, 'Identity', 'sync');
    await member(id.max, 'Principal', 'sync');
    await q(`UPDATE "ContextMembers" SET "addedBy" = 'analyst' WHERE "contextId" = $1 AND "memberId" = $2`, [id.unit, id.lisa]);
    await q(`DELETE FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`, [id.unit, id.max]);
    const rows = (await q(`SELECT operation, "rowData"->>'memberId' AS "memberId" FROM "_history"
                            WHERE "tableName" = 'ContextMembers' AND "rowId" = $1 ORDER BY id`, [id.unit])).rows;
    expect(rows).toEqual([
      { operation: 'I', memberId: id.lisa },
      { operation: 'I', memberId: id.max },
      { operation: 'D', memberId: id.max },
    ]);
  });
});

describe('GET /contexts/:id/timeline — what happened, in words', () => {
  it('says who joined and left by name and by which list, the Accountable change, a leaver\'s new job title and the rename', async () => {
    await q(`INSERT INTO "ContextRoles" ("contextId", "identityId", role, "addedBy") VALUES ($1, $2, 'Accountable', 'analyst')`, [id.unit, id.tom]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM "ContextRoles" WHERE "contextId" = $1 AND role = 'Accountable'`, [id.unit]);
      await client.query(`INSERT INTO "ContextRoles" ("contextId", "identityId", role, "addedBy") VALUES ($1, $2, 'Accountable', 'analyst')`, [id.unit, id.lisa]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await q(`UPDATE "Principals" SET "jobTitle" = 'Senior loss adjuster' WHERE id = $1`, [id.max]);
    await q(`UPDATE "Contexts" SET "displayName" = 'TL Property Claims', "lastCalculatedAt" = now() WHERE id = $1`, [id.unit]);

    const body = await timeline();
    const said = body.events.map(e => `${e.category}: ${e.summary}`);
    expect(said).toEqual(expect.arrayContaining([
      `people: Lisa Vos (tl) joined (list upload: ${LIST})`,
      `people: Max Jacobs (tl) joined (list upload: ${LIST})`,
      `people: Max Jacobs (tl) left (list upload: ${LIST})`,
      'roles: Accountable set: Tom Bakker (tl) (analyst)',
      'roles: Accountable changed: Tom Bakker (tl) → Lisa Vos (tl) (analyst)',
      'people: Max Jacobs (tl)\'s job title changed: Loss adjuster → Senior loss adjuster',
      'structure: Renamed: TL Claims → TL Property Claims',
    ]));
    expect(said.some(s => /last calculated/i.test(s))).toBe(false);
    expect(body.events.find(e => e.summary.startsWith('Lisa Vos (tl) joined')).burst).toMatchObject({ many: 'people joined', actor: `list upload: ${LIST}` });
  });

  it('names an account removed outright by the last name its history recorded', async () => {
    const gone = randomUUID();
    await q(`INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType") VALUES ($1, $2, 'tl-gone', 'Gone Person (tl)', 'User')`, [gone, systemId]);
    await q(`INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Responsible', 'analyst')`, [id.unit, gone]);
    await q(`DELETE FROM "Principals" WHERE id = $1`, [gone]); // cascades the role away

    const said = (await timeline()).events.map(e => e.summary);
    expect(said).toContain('Responsible added: Gone Person (tl) (analyst)');
    expect(said).toContain('Responsible removed: Gone Person (tl) (analyst)');
  });
});

describe('GET /contexts/:id/interviews — Sources', () => {
  it('lists an interview added on the parent that makes claims about this unit\'s people, marked as added there', async () => {
    await q(`INSERT INTO "ContextInterviews" (id, "contextId", "intervieweeName", "interviewedAt", "fileName", transcript, "extractionStatus")
             VALUES ($1, $2, 'Anna Voorbeeld', '2026-10-01', 'gesprek.txt', 'Lisa handles the property claims.', 'done')`, [id.iv, id.parent]);
    await q(`INSERT INTO "ContextClaims" (id, "interviewId", "contextId", "claimKind", "subjectKind", "identityId", "subjectName", value, "proposedBy")
             VALUES ($1, $2, $3, 'role', 'Person', $4, 'Lisa', 'handles the property claims', 'model')`, [id.claim, id.iv, id.parent, id.lisa]);

    const unit = (await agent.get(`/api/contexts/${id.unit}/interviews`)).body.data;
    expect(unit).toEqual([expect.objectContaining({ id: id.iv, filedUnderId: id.parent, filedUnderName: 'TL Claims Handling', proposed: 1, confirmed: 0 })]);

    // On the unit it was added to it is its own source, not "added on" anything.
    const parent = (await agent.get(`/api/contexts/${id.parent}/interviews`)).body.data;
    expect(parent).toEqual([expect.objectContaining({ id: id.iv, filedUnderId: null, filedUnderName: null, proposed: 1 })]);
  });

  it('leaves out a parent interview that names nobody in this unit', async () => {
    await q(`UPDATE "ContextClaims" SET "identityId" = $1 WHERE id = $2`, [id.tom, id.claim]);
    expect((await agent.get(`/api/contexts/${id.unit}/interviews`)).body.data).toEqual([]);
  });
});
