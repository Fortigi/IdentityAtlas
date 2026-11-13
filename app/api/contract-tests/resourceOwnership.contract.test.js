// Contract test — the owner on a resource's page and the resources on the
// owner's page, against a real PostgreSQL schema.
//
// The unit tests mock the DB, so they prove which statement is asked and what
// happens to its rows, not that the statements select the right ones. Here the
// ownership chain is traversed for real, in both directions, and the two are
// held against each other: a resource names a principal as its owner exactly
// when that principal's list contains the resource.
//
// The database is shared with the other contract files, so everything this file
// seeds hangs off its own system.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

const SYSTEM_NAME = 'contract-resource-ownership';

let agent;
let pool;
let systemId;

const id = {
  linkOwner: randomUUID(),    // owns by the ownership link
  secondOwner: randomUUID(),  // a second linked owner of the same resource
  refOwner: randomUUID(),     // named by its externalId
  empOwner: randomUUID(),     // named by its employee number
  goneOwner: randomUUID(),    // a soft-deleted account with an ownership link
  nobody: randomUUID(),       // owns nothing
  linked: randomUUID(),       // two linked owners AND a reference to refOwner: the link wins
  ownership: randomUUID(),
  byExternal: randomUUID(),
  byEmployee: randomUUID(),
  asIs: randomUUID(),         // the source names somebody we hold no account for
  unowned: randomUUID(),
  deletedOwned: randomUUID(), // owned by reference, but soft-deleted itself
  goneLinked: randomUUID(),   // its only linked owner is soft-deleted; references refOwner
  goneOwnership: randomUUID(),
};

const principal = (pid, displayName, { employeeId = null, externalId = null, deleted = false } = {}) => pool.query(
  `INSERT INTO "Principals" ("id","systemId","displayName","email","principalType","employeeId","externalId","extendedAttributes","deletedAt")
   VALUES ($1,$2,$3,$4,'User',$5,$6,'{}'::jsonb,$7)`,
  [pid, systemId, displayName, `${displayName.replace(/\s/g, '.').toLowerCase()}@example.com`, employeeId, externalId,
    deleted ? new Date() : null]);

const resource = (rid, displayName, resourceType, attrs, { deleted = false } = {}) => pool.query(
  `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","extendedAttributes","deletedAt")
   VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
  [rid, systemId, displayName, resourceType, JSON.stringify(attrs), deleted ? new Date() : null]);

const relationship = (parent, child, type) => pool.query(
  `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","systemId")
   VALUES ($1,$2,$3,$4)`, [parent, child, type, systemId]);

const assignment = (resourceId, principalId) => pool.query(
  `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId")
   VALUES ($1,$2,'Direct',$3)`, [resourceId, principalId, systemId]);

async function seed() {
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`, [SYSTEM_NAME]);
  systemId = sys.rows[0].id;

  await principal(id.linkOwner, 'Link Owner');
  await principal(id.secondOwner, 'Second Owner');
  await principal(id.refOwner, 'Ref Owner', { externalId: 'own-ref-1', employeeId: 'OWN-EMP-1' });
  await principal(id.empOwner, 'Emp Owner', { employeeId: 'OWN-EMP-2' });
  await principal(id.goneOwner, 'Gone Owner', { deleted: true });
  await principal(id.nobody, 'Owns Nothing', { externalId: 'own-ref-none' });

  await resource(id.linked, 'OWN_LINKED', 'Entitlement', { ownerId: 'own-ref-1', ownerName: 'Stale Name' });
  await resource(id.ownership, 'OWN_LINKED', 'ResourceOwnership', { ownedResourceType: 'Entitlement' });
  await relationship(id.linked, id.ownership, 'HasOwnership');
  await assignment(id.ownership, id.linkOwner);
  await assignment(id.ownership, id.secondOwner);

  await resource(id.byExternal, 'OWN_BY_EXTERNAL', 'Entitlement', { ownerId: 'own-ref-1' });
  await resource(id.byEmployee, 'OWN_BY_EMPLOYEE', 'Group', { ownerId: 'OWN-EMP-2' });
  await resource(id.asIs, 'OWN_AS_IS', 'Entitlement', { ownerId: 'own-ref-gone', ownerName: 'Gone Person' });
  await resource(id.unowned, 'OWN_UNOWNED', 'Entitlement', { requestable: true });
  await resource(id.deletedOwned, 'OWN_DELETED', 'Entitlement', { ownerId: 'own-ref-1' }, { deleted: true });

  // The only linked owner left the source: the link no longer answers, so the
  // source's own reference does.
  await resource(id.goneLinked, 'OWN_GONE_LINK', 'Entitlement', { ownerId: 'own-ref-1' });
  await resource(id.goneOwnership, 'OWN_GONE_LINK', 'ResourceOwnership', {});
  await relationship(id.goneLinked, id.goneOwnership, 'HasOwnership');
  await assignment(id.goneOwnership, id.goneOwner);
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  await seed();
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

async function ownersOf(resourceId) {
  const res = await agent.get(`/api/resources/${resourceId}`);
  expect(res.status).toBe(200);
  return res.body.owners;
}

async function ownedBy(principalId) {
  const [detail, list] = await Promise.all([
    agent.get(`/api/user/${principalId}`),
    agent.get(`/api/user/${principalId}/owned-resources`),
  ]);
  expect(detail.status).toBe(200);
  expect(list.status).toBe(200);
  return { count: detail.body.ownedResourceCount, rows: list.body };
}

describe('GET /resources/:id — owners', () => {
  it('names every linked owner, by name, and ignores the reference the link overrules', async () => {
    expect(await ownersOf(id.linked)).toEqual([
      { principalId: id.linkOwner, displayName: 'Link Owner', email: 'link.owner@example.com', via: 'link' },
      { principalId: id.secondOwner, displayName: 'Second Owner', email: 'second.owner@example.com', via: 'link' },
    ]);
  });

  it('resolves the source\'s reference by external id, and by employee number', async () => {
    expect(await ownersOf(id.byExternal)).toEqual([
      { principalId: id.refOwner, displayName: 'Ref Owner', email: 'ref.owner@example.com', via: 'reference' },
    ]);
    expect(await ownersOf(id.byEmployee)).toEqual([
      { principalId: id.empOwner, displayName: 'Emp Owner', email: 'emp.owner@example.com', via: 'reference' },
    ]);
  });

  it('shows the source\'s own words when no account matches, and nothing when nobody is named', async () => {
    expect(await ownersOf(id.asIs)).toEqual([{ principalId: null, displayName: 'Gone Person', email: null, via: 'source' }]);
    expect(await ownersOf(id.unowned)).toEqual([]);
  });

  it('falls back to the reference when the only linked owner is deleted in the source', async () => {
    expect(await ownersOf(id.goneLinked)).toEqual([
      { principalId: id.refOwner, displayName: 'Ref Owner', email: 'ref.owner@example.com', via: 'reference' },
    ]);
  });

  it('an ownership resource has no owner of its own', async () => {
    expect(await ownersOf(id.ownership)).toEqual([]);
  });
});

describe('GET /user/:id/owned-resources — the same ownership from the owner\'s side', () => {
  it('lists what a linked owner owns, and each of several owners sees it', async () => {
    const expected = [{ resourceId: id.linked, displayName: 'OWN_LINKED', resourceType: 'Entitlement', via: 'link' }];
    expect(await ownedBy(id.linkOwner)).toEqual({ count: 1, rows: expected });
    expect(await ownedBy(id.secondOwner)).toEqual({ count: 1, rows: expected });
  });

  it('lists what the source names a person for — live resources no link answers for, by name', async () => {
    // Not OWN_LINKED (the link names two others), not OWN_DELETED (gone).
    expect(await ownedBy(id.refOwner)).toEqual({
      count: 2,
      rows: [
        { resourceId: id.byExternal, displayName: 'OWN_BY_EXTERNAL', resourceType: 'Entitlement', via: 'reference' },
        { resourceId: id.goneLinked, displayName: 'OWN_GONE_LINK', resourceType: 'Entitlement', via: 'reference' },
      ],
    });
  });

  it('finds a person named by employee number', async () => {
    expect(await ownedBy(id.empOwner)).toEqual({
      count: 1,
      rows: [{ resourceId: id.byEmployee, displayName: 'OWN_BY_EMPLOYEE', resourceType: 'Group', via: 'reference' }],
    });
  });

  it('is empty for someone who owns nothing, for a deleted owner and for an unknown id', async () => {
    expect(await ownedBy(id.nobody)).toEqual({ count: 0, rows: [] });
    expect(await ownedBy(id.goneOwner)).toEqual({ count: 0, rows: [] });
    const unknown = await agent.get(`/api/user/${randomUUID()}/owned-resources`);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual([]);
  });

  it('agrees with the resource side: a principal lists a resource exactly when it is named as its owner', async () => {
    const principals = [id.linkOwner, id.secondOwner, id.refOwner, id.empOwner, id.goneOwner, id.nobody];
    const resources = [id.linked, id.byExternal, id.byEmployee, id.asIs, id.unowned, id.goneLinked];
    const fromResources = new Set();
    for (const r of resources) {
      for (const o of await ownersOf(r)) if (o.principalId) fromResources.add(`${o.principalId}|${r}`);
    }
    const fromOwners = new Set();
    for (const p of principals) {
      for (const row of (await ownedBy(p)).rows) fromOwners.add(`${p}|${row.resourceId}`);
    }
    expect([...fromOwners].sort()).toEqual([...fromResources].sort());
    expect(fromOwners.size).toBe(5);
  });
});

describe('migration 111 — the reverse lookup has its index', () => {
  it('exists, partial, on the owner reference', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'Resources' AND indexname = 'ix_Resources_ownerIdReference'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/->> 'ownerId'/);
    expect(rows[0].indexdef).toMatch(/WHERE .*IS NOT NULL/);
  });
});
