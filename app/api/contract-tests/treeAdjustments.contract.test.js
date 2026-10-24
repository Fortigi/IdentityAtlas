// Contract test — Adjust tree (migration 102), end to end over the real app and
// PostgreSQL. An imported tree (a synced org-unit list) is adjusted through the
// API, the source then writes its own shape back (as a re-sync does), and the
// adjustments are applied again on top. A unit the source re-keys is proposed,
// not followed silently. Undo restores what the adjustment replaced. A generated
// tree (manager hierarchy) keeps its adjustments across a plugin re-run.
//
// Invented people only. Everything hangs off its own systems and is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent; let pool; let systemId; let hrSystemId;
const u = { root: randomUUID(), a: randomUUID(), b: randomUUID(), b2: randomUUID() };
const p = { ann: randomUUID(), ben: randomUUID(), cas: randomUUID(), dan: randomUUID(), eve: randomUUID() };
const q = (sql, params) => pool.query(sql, params);
let key;
const path = (suffix = '') => `/api/context-trees/${encodeURIComponent(key)}${suffix}`;

async function unit(id, name, parent) {
  await q(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", "parentContextId", "scopeSystemId")
           VALUES ($1, 'synced', 'Principal', 'OrgUnit', 'OrganizationalUnit', $2, $3, $4)`, [id, name, parent, systemId]);
}
async function member(contextId, memberId, addedBy = 'sync') {
  await q(`INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy") VALUES ($1, 'Principal', $2, $3)
           ON CONFLICT DO NOTHING`, [contextId, memberId, addedBy]);
}
async function person(id, sys, name, department, managerId = null) {
  await q(`INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType", department, "managerId")
           VALUES ($1, $2, $3, $4, 'User', $5, $6)`, [id, sys, `adj-${id}`, name, department, managerId]);
}
const parentOf = async (id) => (await q(`SELECT "parentContextId" FROM "Contexts" WHERE id = $1`, [id])).rows[0]?.parentContextId ?? null;
const nameOf = async (id) => (await q(`SELECT "displayName" FROM "Contexts" WHERE id = $1`, [id])).rows[0]?.displayName;
const unitsOf = async (memberId) => (await q(`SELECT "contextId" FROM "ContextMembers" WHERE "memberId" = $1 ORDER BY "contextId"`, [memberId])).rows.map(r => r.contextId);
const post = (body) => agent.post(path('/adjustments')).send(body);
// What a re-sync of the source does: parents, names and memberships as the source has them.
async function resync() {
  await q(`UPDATE "Contexts" SET "parentContextId" = $2 WHERE id = ANY($1::uuid[])`, [[u.a, u.b], u.root]);
  await q(`UPDATE "Contexts" SET "displayName" = 'Team B' WHERE id = $1`, [u.b]);
  await member(u.a, p.ann);
  const { reapplyForSystem } = await import('../src/contexts/adjustments/service.js');
  return reapplyForSystem(pool, systemId);
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  systemId = (await q(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'Adjust contract list') RETURNING id`)).rows[0].id;
  hrSystemId = (await q(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'Adjust contract HR') RETURNING id`)).rows[0].id;
  await person(p.ann, systemId, 'Ann Arends', 'Sales');
  await person(p.ben, systemId, 'Ben Bos', 'Sales');
  await person(p.cas, systemId, 'Cas Claes', 'Support');
  await person(p.dan, systemId, 'Dan Dekker', 'Support');
  await person(p.eve, systemId, 'Eve Evers', 'Support');
  await unit(u.root, 'Company', null);
  await unit(u.a, 'Team A', u.root);
  await unit(u.b, 'Team B', u.root);
  for (const m of [p.ann, p.ben, p.cas, p.dan]) await member(u.a, m);
  await member(u.b, p.eve);
  key = `sync~${systemId}~OrganizationalUnit`;
});

afterAll(async () => {
  await q(`DELETE FROM "ContextTreeAdjustments" WHERE "scopeSystemId" = ANY($1::int[])`, [[systemId, hrSystemId]]);
  await q(`DELETE FROM "Contexts" WHERE "scopeSystemId" = ANY($1::int[])`, [[systemId, hrSystemId]]);
  await q(`DELETE FROM "Principals" WHERE "systemId" = ANY($1::int[])`, [[systemId, hrSystemId]]);
  await q(`DELETE FROM "Systems" WHERE id = ANY($1::int[])`, [[systemId, hrSystemId]]);
  await pool.end();
  delete process.env.USE_SQL;
});

describe('adjusting an imported tree', () => {
  it('resolves a unit to its tree and lists the tree', async () => {
    const res = await agent.get('/api/context-trees/resolve').query({ contextId: u.a });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ treeKey: key, kind: 'synced', canAdjust: true, targetType: 'Principal' });
    const tree = await agent.get(path());
    expect(tree.status).toBe(200);
    expect(tree.body.units.map(x => [x.name, x.parentId]).sort()).toEqual([['Company', null], ['Team A', u.root], ['Team B', u.root]]);
  });

  it('adds a grouping level and moves a unit under it; both survive a re-sync', async () => {
    const add = await post({ op: 'addUnit', name: 'Customer facing', parentId: u.root, reason: 'Grouping' });
    expect(add.status).toBe(201);
    const groupId = add.body.adjustment.payload.contextId;
    expect(await parentOf(groupId)).toBe(u.root);
    const move = await post({ op: 'moveUnit', subjectId: u.a, toParentId: groupId });
    expect(move.status).toBe(201);
    expect(move.body.adjustment).toMatchObject({ status: 'active', description: 'Move Team A under Customer facing' });
    expect(await parentOf(u.a)).toBe(groupId);

    expect(await resync()).toBeGreaterThan(0);
    expect(await parentOf(u.a)).toBe(groupId);
    const variant = (await q(`SELECT variant FROM "Contexts" WHERE id = $1`, [groupId])).rows[0].variant;
    expect(variant).toBe('manual'); // a full sync of the list never deletes it
  });

  it('moves a member out of the unit the source keeps putting them in', async () => {
    const res = await post({ op: 'moveMember', memberId: p.ann, fromUnitId: u.a, toUnitId: u.b });
    expect(res.status).toBe(201);
    expect(await unitsOf(p.ann)).toEqual([u.b]);
    await resync(); // the source writes Ann back into Team A
    expect(await unitsOf(p.ann)).toEqual([u.b]);
  });

  it('keeps a rename over the source\'s name', async () => {
    expect((await post({ op: 'renameUnit', subjectId: u.b, name: 'Support desk' })).status).toBe(201);
    await resync();
    expect(await nameOf(u.b)).toBe('Support desk');
  });

  it('splits a unit by department and puts newcomers of that department in it', async () => {
    const res = await post({ op: 'splitUnit', subjectId: u.a, attribute: 'department', value: 'Support' });
    expect(res.status).toBe(201);
    const splitId = res.body.adjustment.payload.contextId;
    expect(await unitsOf(p.cas)).toEqual([splitId]);
    expect(await unitsOf(p.ben)).toEqual([u.a]);
    await q(`UPDATE "Principals" SET department = 'Support' WHERE id = $1`, [p.ben]);
    await resync();
    expect(await unitsOf(p.ben)).toEqual([splitId]);
  });

  it('proposes the new unit when the source re-keys one, and follows only when asked', async () => {
    // The source drops Team B and lists the same people under a new key.
    await unit(u.b2, 'Team B (new key)', u.root);
    await member(u.b2, p.eve);
    await member(u.b2, p.ann);
    await q(`DELETE FROM "Contexts" WHERE id = $1`, [u.b]);
    const { reapplyForSystem } = await import('../src/contexts/adjustments/service.js');
    await reapplyForSystem(pool, systemId);

    const log = (await agent.get(path('/adjustments'))).body.data;
    const rename = log.find(a => a.op === 'renameUnit');
    expect(rename).toMatchObject({ status: 'needsDecision', suggestion: { contextId: u.b2, name: 'Team B (new key)' } });
    expect(await nameOf(u.b2)).toBe('Team B (new key)'); // not renamed until the analyst decides
    const attention = (await agent.get(path('/attention'))).body.data;
    expect(attention.find(i => i.adjustmentId === rename.id)).toMatchObject({ kind: 'decision', action: { type: 'follow' } });

    const follow = await agent.post(path(`/adjustments/${rename.id}/follow`));
    expect(follow.status).toBe(200);
    expect(follow.body.adjustment.status).toBe('active');
    expect(await nameOf(u.b2)).toBe('Support desk');
  });

  it('undo puts back what the adjustment replaced, even mid-log', async () => {
    const log = (await agent.get(path('/adjustments'))).body.data;
    const move = log.find(a => a.op === 'moveUnit');
    const res = await agent.delete(path(`/adjustments/${move.id}`));
    expect(res.status).toBe(200);
    expect(res.body.adjustment.status).toBe('reverted');
    expect(await parentOf(u.a)).toBe(u.root);
    const redo = await agent.post(path(`/adjustments/${move.id}/redo`));
    expect(redo.body.adjustment.status).toBe('active');
    expect(await parentOf(u.a)).not.toBe(u.root);
    expect((await agent.delete(path(`/adjustments/${move.id}`))).status).toBe(200);
    expect((await agent.delete(path(`/adjustments/${move.id}`))).status).toBe(400);
  });

  it('ends an interim manager on its date and brings the previous one back', async () => {
    await q(`INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Accountable', 'sync')`, [u.a, p.ben]);
    const res = await post({ op: 'setManager', subjectId: u.a, principalId: p.dan, interim: true, validUntil: '2000-01-01' });
    expect(res.body.adjustment.status).toBe('expired');
    const holder = (await q(`SELECT "principalId" FROM "ContextRoles" WHERE "contextId" = $1 AND role = 'Accountable'`, [u.a])).rows;
    expect(holder).toEqual([{ principalId: p.ben }]);
    const current = await post({ op: 'setManager', subjectId: u.a, principalId: p.dan, interim: true, validUntil: '2999-01-01' });
    expect(current.body.adjustment.status).toBe('active');
    const tree = (await agent.get(path())).body;
    expect(tree.units.find(x => x.id === u.a)).toMatchObject({ accountable: { principalId: p.dan }, interim: { validUntil: '2999-01-01' }, adjusted: true });
  });

  it('refuses what cannot be applied', async () => {
    expect((await post({ op: 'moveUnit', subjectId: u.root, toParentId: u.a })).status).toBe(400);
    expect((await post({ op: 'renameUnit', subjectId: randomUUID(), name: 'x' })).status).toBe(404);
    expect((await agent.get('/api/context-trees/not-a-key')).status).toBe(400);
    expect((await agent.get(`/api/context-trees/ctx~${randomUUID()}`)).status).toBe(404);
  });
});

describe('adjusting a generated tree', () => {
  const h = { boss: randomUUID(), mgr: randomUUID(), x1: randomUUID(), x2: randomUUID(), x3: randomUUID(), f1: randomUUID(), f2: randomUUID() };

  async function runPlugin(params) {
    const res = await agent.post('/api/context-plugins/manager-hierarchy/run').send(params);
    expect(res.status).toBe(202);
    for (let i = 0; i < 100; i++) {
      const run = (await agent.get(`/api/context-plugins/runs/${res.body.runId}`)).body;
      if (run.status === 'succeeded') return run;
      if (run.status === 'failed') throw new Error(run.errorMessage);
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('run did not finish');
  }

  it('splits a manager\'s two teams, and keeps a move across a re-run', async () => {
    // The app registers its plugins at startup; the contract app does not start.
    const { seedContextAlgorithms } = await import('../src/contexts/seedAlgorithms.js');
    await seedContextAlgorithms();
    await person(h.boss, hrSystemId, 'Bo Boss', 'Board');
    await person(h.mgr, hrSystemId, 'Mo Manager', 'Board', h.boss);
    await person(h.x1, hrSystemId, 'Xi One', 'IT', h.mgr);
    await person(h.x2, hrSystemId, 'Xu Two', 'IT', h.mgr);
    await person(h.x3, hrSystemId, 'Xa Three', 'IT', h.mgr);
    await person(h.f1, hrSystemId, 'Fa One', 'Facilities', h.mgr);
    await person(h.f2, hrSystemId, 'Fe Two', 'Facilities', h.mgr);
    const params = { scopeSystemId: hrSystemId, splitBy: 'department', nameFrom: 'members', topMode: 'people', topPrincipalIds: [h.boss] };
    const run = await runPlugin(params);
    expect(run.treeKey).toMatch(/^gen~/);
    key = run.treeKey;
    const tree = (await agent.get(path())).body;
    const facilities = tree.units.find(x => x.name === 'Facilities (Mo Manager)');
    const itUnit = tree.units.find(x => x.name === 'IT (Mo Manager)');
    expect(facilities.parentId).toBe(itUnit.id);

    const boss = tree.units.find(x => x.name.endsWith('(Bo Boss)'));
    expect((await post({ op: 'moveUnit', subjectId: facilities.id, toParentId: boss.id })).status).toBe(201);
    const instanceKey = key.split('~').slice(2).join('~');
    await runPlugin({ ...params, instanceKey });
    expect(await parentOf(facilities.id)).toBe(boss.id);
  });
});
