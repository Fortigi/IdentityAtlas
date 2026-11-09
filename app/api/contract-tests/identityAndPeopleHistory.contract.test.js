// Contract test — people- and identity-side endpoints must keep soft-deleted
// history apart from current access, against the real PostgreSQL 16 schema.
//
// A full sync tombstones what vanished from the source (`deletedAt`, migration
// 040) instead of deleting it. Lists keep that history but flag it
// (`deleted` + `deletedAt`, current rows first); counts include current only.
// The unit mocks are SQL-blind, so this is the only proof the rows come back
// right.
//
// Seeds:
//   • Boss — a user with a live + a deleted owner (PrincipalRelationships), a
//     live + a deleted direct report, and a live + a deleted sponsored guest.
//   • Orphaned Report — a live user whose manager (Gone Manager) is deleted.
//   • An identity with a live and a deleted linked account; the live account
//     holds a live group, a deleted assignment, and a group deleted in the source.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { deleteSystemScopedRows } from '../test-utils/systemScopedCleanup.js';

const S = randomUUID().slice(0, 8);
const M = `HIST-${S}`;                 // display-name marker for the /api/users filter
const DELETED_AT = '2026-09-08T14:32:00Z';
const EARLIER = '2026-08-01T09:00:00Z';

let agent, pool, systemId, identityId;
const ids = {};

const iso = (v) => (v == null ? v : new Date(v).toISOString());

async function addPrincipal(name, { managerId = null, deletedAt = null } = {}) {
  return (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "managerId", "deletedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, 'User', $4, $5) RETURNING "id"`,
    [systemId, `${M} ${name}`, `${name.replace(/\s/g, '.')}-${S}@example.test`, managerId, deletedAt],
  )).rows[0].id;
}
async function addRel(subjectId, relatedId, relationshipType) {
  await pool.query(
    `INSERT INTO "PrincipalRelationships" ("principalId", "relatedPrincipalId", "relationshipType", "systemId")
     VALUES ($1, $2, $3, $4)`,
    [subjectId, relatedId, relationshipType, systemId],
  );
}
async function addGroup(name, deletedAt = null) {
  return (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "deletedAt")
     VALUES (gen_random_uuid(), $1, $2, 'Group', $3) RETURNING "id"`,
    [systemId, `${M} ${name}`, deletedAt],
  )).rows[0].id;
}
async function assign(resourceId, principalId, deletedAt = null) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId", "deletedAt")
     VALUES ($1, $2, 'Direct', 'User', $3, $4)`,
    [resourceId, principalId, systemId, deletedAt],
  );
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`,
    [`contract-people-history-${S}`],
  )).rows[0].id;

  // Boss and the people around them.
  ids.boss = await addPrincipal('Boss');
  ids.liveOwner = await addPrincipal('Live Owner');
  ids.goneOwner = await addPrincipal('Gone Owner', { deletedAt: DELETED_AT });
  await addRel(ids.boss, ids.liveOwner, 'Owner');
  await addRel(ids.boss, ids.goneOwner, 'Owner');
  ids.liveGuest = await addPrincipal('Live Guest');
  ids.goneGuest = await addPrincipal('Gone Guest', { deletedAt: DELETED_AT });
  await addRel(ids.liveGuest, ids.boss, 'Sponsor');
  await addRel(ids.goneGuest, ids.boss, 'Sponsor');
  ids.liveReport = await addPrincipal('Live Report', { managerId: ids.boss });
  ids.goneReport = await addPrincipal('Gone Report', { managerId: ids.boss, deletedAt: DELETED_AT });

  // A live user whose manager left.
  ids.goneManager = await addPrincipal('Gone Manager', { deletedAt: DELETED_AT });
  ids.orphanedReport = await addPrincipal('Orphaned Report', { managerId: ids.goneManager });

  // An identity with a live and a deleted linked account.
  ids.liveAccount = await addPrincipal('Live Account');
  ids.goneAccount = await addPrincipal('Gone Account', { deletedAt: EARLIER });
  identityId = (await pool.query(
    `INSERT INTO "Identities" ("id", "displayName", "accountCount")
     VALUES (gen_random_uuid(), $1, 2) RETURNING "id"`,
    [`${M} Person`],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO "IdentityMembers" ("identityId", "principalId", "isPrimary", "accountType")
     VALUES ($1, $2, true, 'Cloud'), ($1, $3, false, 'Admin')`,
    [identityId, ids.liveAccount, ids.goneAccount],
  );
  ids.liveGroup = await addGroup('Live Group');
  ids.removedGroup = await addGroup('Removed Assignment Group');
  ids.deletedGroup = await addGroup('Deleted Group', DELETED_AT);
  ids.goneAccountGroup = await addGroup('Gone Account Group');
  await assign(ids.liveGroup, ids.liveAccount);
  await assign(ids.removedGroup, ids.liveAccount, DELETED_AT);  // assignment removed
  await assign(ids.deletedGroup, ids.liveAccount);              // group deleted in source
  await assign(ids.goneAccountGroup, ids.goneAccount);          // held by a deleted account

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
}, 60000);

afterAll(async () => {
  if (identityId) {
    await pool.query(`DELETE FROM "IdentityMembers" WHERE "identityId" = $1`, [identityId]);
    await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [identityId]);
  }
  if (systemId) await pool.query(`DELETE FROM "PrincipalRelationships" WHERE "systemId" = $1`, [systemId]);
  await deleteSystemScopedRows(pool, systemId);
  await pool.query(`DELETE FROM "_history" WHERE "rowId" = ANY($1::text[])`,
    [[identityId, ...Object.values(ids)].filter(Boolean).map(String)]);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /user/:id — counts are of live counterparties', () => {
  it('counts the live owner, guest and report only', async () => {
    const res = await agent.get(`/api/user/${ids.boss}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerCount).toBe(1);
    expect(res.body.sponsoredGuestCount).toBe(1);
    expect(res.body.directReportCount).toBe(1);
  });
});

describe('GET /user/:id/principal-relationships — deleted counterparties are flagged', () => {
  it('owners: the live owner first, the deleted one flagged with its deletion time', async () => {
    const res = await agent.get(`/api/user/${ids.boss}/principal-relationships?type=Owner`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.principalId)).toEqual([ids.liveOwner, ids.goneOwner]);
    expect(res.body[0]).toMatchObject({ deleted: false, deletedAt: null });
    expect(res.body[1].deleted).toBe(true);
    expect(iso(res.body[1].deletedAt)).toBe(iso(DELETED_AT));
  });

  it('sponsored guests (reverse): the deleted guest is flagged too', async () => {
    const res = await agent.get(`/api/user/${ids.boss}/principal-relationships?type=Sponsor&reverse=true`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => [r.principalId, r.deleted])).toEqual([[ids.liveGuest, false], [ids.goneGuest, true]]);
  });
});

describe('GET /org-chart/user/:id/reports + /manager', () => {
  it('lists the live report first and flags the deleted one', async () => {
    const res = await agent.get(`/api/org-chart/user/${ids.boss}/reports`);
    expect(res.status).toBe(200);
    expect(res.body.reports.map((r) => [r.id, r.deleted])).toEqual([[ids.liveReport, false], [ids.goneReport, true]]);
    expect(iso(res.body.reports[1].deletedAt)).toBe(iso(DELETED_AT));
  });

  it('returns a deleted manager flagged, so it cannot pass for the current one', async () => {
    const res = await agent.get(`/api/org-chart/user/${ids.orphanedReport}/manager`);
    expect(res.status).toBe(200);
    expect(res.body.manager.id).toBe(ids.goneManager);
    expect(res.body.manager.deleted).toBe(true);
    expect(iso(res.body.manager.deletedAt)).toBe(iso(DELETED_AT));
  });

  it('a live manager is unflagged', async () => {
    const res = await agent.get(`/api/org-chart/user/${ids.liveReport}/manager`);
    expect(res.body.manager).toMatchObject({ id: ids.boss, deleted: false, deletedAt: null });
  });
});

describe('Users list — rel.manager filter treats a deleted manager as none', () => {
  it('the user whose manager left reads as having no manager', async () => {
    const list = async (value) => {
      const res = await agent.get('/api/users')
        .query({ search: M, filters: JSON.stringify({ 'rel.manager': value }), limit: 1000 });
      expect(res.status).toBe(200);
      return new Set(res.body.data.map((r) => r.id));
    };
    const none = await list('None (0)');
    expect(none.has(ids.orphanedReport)).toBe(true);
    expect(none.has(ids.liveReport)).toBe(false);
    const any = await list('Any (1 or more)');
    expect(any.has(ids.liveReport)).toBe(true);
    expect(any.has(ids.orphanedReport)).toBe(false);
  });
});

describe('GET /identities/:id — current-only counts, flagged linked accounts', () => {
  it('counts only the live account\'s live group, and badges the deleted account', async () => {
    const res = await agent.get(`/api/identities/${identityId}`);
    expect(res.status).toBe(200);
    expect(res.body.aggregateAssignments.Direct).toBe(1);
    const byId = Object.fromEntries(res.body.members.map((m) => [m.principalId, m]));
    expect(byId[ids.liveAccount]).toMatchObject({ deleted: false, deletedAt: null, groupCount: 1 });
    expect(byId[ids.goneAccount].deleted).toBe(true);
    expect(iso(byId[ids.goneAccount].deletedAt)).toBe(iso(EARLIER));
    expect(byId[ids.goneAccount].groupCount).toBe(0);
  });
});

describe('GET /identities/:id/assignments — history flagged, current first', () => {
  it('flags removed assignments, deleted groups and grants held by a deleted account', async () => {
    const res = await agent.get(`/api/identities/${identityId}/assignments?type=Direct`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ resourceId: ids.liveGroup, deleted: false, deletedAt: null });
    const byRes = Object.fromEntries(res.body.map((r) => [r.resourceId, r]));
    expect(Object.keys(byRes).sort()).toEqual(
      [ids.liveGroup, ids.removedGroup, ids.deletedGroup, ids.goneAccountGroup].sort());
    expect(res.body.slice(1).every((r) => r.deleted)).toBe(true);
    expect(iso(byRes[ids.removedGroup].deletedAt)).toBe(iso(DELETED_AT));
    expect(iso(byRes[ids.deletedGroup].deletedAt)).toBe(iso(DELETED_AT));
    expect(iso(byRes[ids.goneAccountGroup].deletedAt)).toBe(iso(EARLIER));
  });
});

describe('Linked-account lists carry the account deletion', () => {
  it('account-matrix accounts', async () => {
    const res = await agent.get(`/api/identities/${identityId}/account-matrix`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.accounts.map((a) => [a.id, a]));
    expect(byId[ids.liveAccount].deleted).toBe(false);
    expect(byId[ids.goneAccount].deleted).toBe(true);
    expect(iso(byId[ids.goneAccount].deletedAt)).toBe(iso(EARLIER));
  });

  it('by-user other accounts', async () => {
    const res = await agent.get(`/api/identities/by-user/${ids.liveAccount}`);
    expect(res.status).toBe(200);
    expect(res.body.otherMembers).toHaveLength(1);
    expect(res.body.otherMembers[0]).toMatchObject({ userId: ids.goneAccount, deleted: true });
  });
});
