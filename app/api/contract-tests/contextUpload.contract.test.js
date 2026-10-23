// Contract test — a context upload end to end against real PostgreSQL: analyze →
// apply → re-import (keep) → re-import (remove), through the real ingest path
// (runIngest) and the real link writers. What only PostgreSQL can tell:
//   - the list's system lands on the tenantless (systemType, displayName) key;
//   - a full contexts sync scoped to the list keeps exactly the batch, and the
//     contexts the file no longer has survive when they are sent back;
//   - the synced-owner reconcile resolves an e-mail owner (by_email) to the
//     Accountable, and moves it when the owner changes;
//   - members, SameUnitAs links and ContextUploads rows are where the upload
//     says they are, with the same context ids on every run.
//
// Isolation on the shared contract DB: one directory system and one list with a
// random suffix; everything is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const db = await import('../src/db/connection.js');
const { analyzeUpload, applyUpload } = await import('../src/contexts/upload/service.js');
const { uploadProvenance } = await import('../src/contexts/upload/lists.js');
const { contextIdFor } = await import('../src/contexts/upload/records.js');
const { runIngest } = await import('../src/routes/ingest/handlers.js');
const { insertRoleRows, insertRelationshipRows } = await import('../src/routes/ingest/contextLinks.js');
const { refreshMemberCounts } = await import('../src/contexts/memberCounts.js');

const deps = { db, runIngest, insertRoleRows, insertRelationshipRows, refreshMemberCounts };
const SUFFIX = randomUUID().slice(0, 8);
const LIST = `Contract klanten ${SUFFIX}`;
const P = {};
let pool;
let dirSystem;
let uploadRoot;

const csv = (lines) => Buffer.from(lines.join('\n'));
const FIRST = csv([
  'Klantnummer;Naam;Sector;Eigenaar;Gebruikers;Applicaties',
  `K1;Acme;Zorg;OWNER-${SUFFIX}@X.NL;"ann-${SUFFIX}@x.nl; bob-${SUFFIX}@x.nl";G1-${SUFFIX}`,
  `K2;Beta;Bouw;;ghost-${SUFFIX}@x.nl;G1-${SUFFIX}`,
]);
const SECOND = csv([
  'Klantnummer;Naam;Sector;Eigenaar;Gebruikers;Applicaties',
  `K1;Acme BV;;bob-${SUFFIX}@x.nl;bob-${SUFFIX}@x.nl;G1-${SUFFIX}`,
]);

async function analyzed(buffer, fileName, listId = null) {
  return analyzeUpload({ buffer, fileName, uploadedBy: 'contract@x.nl', listId }, { db });
}

async function listSystem() {
  return (await pool.query(`SELECT id, "systemType", "tenantId" FROM "Systems" WHERE "displayName" = $1`, [`${LIST} (upload)`])).rows;
}

async function contexts(systemId) {
  const r = await pool.query(`
    SELECT id, "externalId", "displayName", "targetType", "contextCategory", "ownerUserId", "extendedAttributes", "directMemberCount"
      FROM "Contexts" WHERE "scopeSystemId" = $1 AND variant = 'synced' ORDER BY "targetType", "externalId"`, [systemId]);
  return r.rows;
}

async function members(contextId) {
  return (await pool.query(`SELECT "memberId", "addedBy" FROM "ContextMembers" WHERE "contextId" = $1 ORDER BY "memberId"`, [contextId])).rows;
}

async function accountable(contextId) {
  return (await pool.query(`SELECT "principalId", "addedBy" FROM "ContextRoles" WHERE "contextId" = $1 AND role = 'Accountable'`, [contextId])).rows;
}

beforeAll(async () => {
  uploadRoot = await mkdtemp(join(tmpdir(), 'ctx-upload-contract-'));
  process.env.UPLOAD_ROOT = uploadRoot;
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  dirSystem = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName", "tenantId") VALUES ('EntraID', $1, $1) RETURNING id`, [`dir-${SUFFIX}`])).rows[0].id;
  for (const name of ['ann', 'bob', 'owner']) {
    P[name] = (await pool.query(
      `INSERT INTO "Principals" (id, "systemId", "displayName", email, "externalId") VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
      [dirSystem, `${name}-${SUFFIX}`, `${name}-${SUFFIX}@x.nl`, `ext-${name}-${SUFFIX}`])).rows[0].id;
  }
  P.g1 = (await pool.query(
    `INSERT INTO "Resources" (id, "systemId", "displayName", "externalId", "resourceType") VALUES (gen_random_uuid(), $1, $2, $2, 'Group') RETURNING id`,
    [dirSystem, `G1-${SUFFIX}`])).rows[0].id;
});

afterAll(async () => {
  const sys = (await listSystem()).map(r => r.id);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = ANY($1::int[])`, [sys]);
  await pool.query(`DELETE FROM "Systems" WHERE id = ANY($1::int[]) OR id = $2`, [sys, dirSystem]);
  await pool.end();
  await rm(uploadRoot, { recursive: true, force: true });
  delete process.env.UPLOAD_ROOT;
});

describe('context upload against PostgreSQL', () => {
  let listId;
  let firstIds;

  it('a first upload registers the list and writes two linked trees with members and an Accountable', async () => {
    const a = await analyzed(FIRST, 'klanten.csv');
    const result = await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: { ...a.guess, listName: LIST } }, 'contract@x.nl', deps);
    listId = result.listId;

    const sys = await listSystem();
    expect(sys).toEqual([{ id: listId, systemType: 'Upload', tenantId: null }]);
    expect(result.contexts).toEqual({ created: 6, updated: 0, unchanged: 0, removed: 0, notInFile: 0 });

    const rows = await contexts(listId);
    firstIds = rows.map(r => r.id).sort();
    expect(rows.map(r => `${r.targetType}:${r.externalId}:${r.displayName}`)).toEqual([
      'Principal:K1:Acme', 'Principal:K2:Beta', `Principal:__root__:${LIST}`,
      'Resource:K1:Acme', 'Resource:K2:Beta', `Resource:__root__:${LIST} · Resources`,
    ]);
    // The ingest derived the template from contextType OrgUnit.
    expect(new Set(rows.map(r => r.contextCategory))).toEqual(new Set(['OrganizationalUnit']));
    expect(rows.find(r => r.externalId === 'K1').extendedAttributes).toEqual({ Sector: 'Zorg' });

    const k1 = contextIdFor(listId, 'Principal', 'K1');
    expect(await members(k1)).toEqual([P.ann, P.bob].sort().map(id => ({ memberId: id, addedBy: 'sync' })));
    expect(await members(contextIdFor(listId, 'Resource', 'K2'))).toEqual([{ memberId: P.g1, addedBy: 'sync' }]);
    expect(rows.find(r => r.id === k1).directMemberCount).toBe(2);

    // The owner was written in capitals; by_email resolves it case-insensitively.
    expect(await accountable(k1)).toEqual([{ principalId: P.owner, addedBy: 'sync' }]);
    expect(await accountable(contextIdFor(listId, 'Principal', 'K2'))).toEqual([]);

    const links = await pool.query(
      `SELECT count(*)::int AS n FROM "ContextRelationships" WHERE "contextId" = ANY($1::uuid[]) AND "relationshipType" = 'SameUnitAs' AND "addedBy" = 'sync'`,
      [rows.map(r => r.id)]);
    expect(links.rows[0].n).toBe(3);

    const runs = await pool.query(`SELECT "fileName", template, "rowCount", created, "unmatchedMembers", "uploadedBy" FROM "ContextUploads" WHERE "systemId" = $1`, [listId]);
    expect(runs.rows).toEqual([{ fileName: 'klanten.csv', template: 'OrganizationalUnit', rowCount: 2, created: 6, unmatchedMembers: 1, uploadedBy: 'contract@x.nl' }]);
  });

  it('a re-import updates in place, keeps what the file no longer has, and moves the Accountable', async () => {
    const a = await analyzed(SECOND, 'klanten-v2.csv', listId);
    expect(a.existingList.id).toBe(listId);
    const result = await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess, listId }, 'contract@x.nl', deps);
    expect(result.contexts).toMatchObject({ created: 0, updated: 2, unchanged: 2, removed: 0, notInFile: 2 });

    const rows = await contexts(listId);
    expect(rows.map(r => r.id).sort()).toEqual(firstIds);
    const k1 = rows.find(r => r.externalId === 'K1' && r.targetType === 'Principal');
    expect(k1.displayName).toBe('Acme BV');
    // An emptied cell empties the attribute: the full sync replaces, it does not COALESCE.
    expect(k1.extendedAttributes).toBeNull();
    expect(await members(k1.id)).toEqual([{ memberId: P.bob, addedBy: 'sync' }]);
    expect(await accountable(k1.id)).toEqual([{ principalId: P.bob, addedBy: 'sync' }]);

    const k2 = contextIdFor(listId, 'Resource', 'K2');
    expect(rows.find(r => r.id === k2).displayName).toBe('Beta');
    expect(await members(k2)).toEqual([{ memberId: P.g1, addedBy: 'sync' }]);

    const prov = await uploadProvenance(db, listId);
    expect(prov).toMatchObject({ uploadedFrom: 'klanten.csv', lastUploadFile: 'klanten-v2.csv', uploadedBy: 'contract@x.nl' });
  });

  it('with "remove contexts no longer in the file" the list shrinks to the file', async () => {
    const a = await analyzed(SECOND, 'klanten-v3.csv', listId);
    const result = await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess, listId, removeMissing: true }, 'contract@x.nl', deps);
    expect(result.contexts).toMatchObject({ removed: 2, notInFile: 0, unchanged: 4 });
    expect((await contexts(listId)).map(r => r.externalId).sort()).toEqual(['K1', 'K1', '__root__', '__root__']);
    expect(await members(contextIdFor(listId, 'Resource', 'K2'))).toEqual([]);
  });

  it('a new list of the same name is refused, not merged', async () => {
    const a = await analyzed(FIRST, 'klanten.csv');
    await expect(applyUpload({ uploadDraftId: a.uploadDraftId, mapping: { ...a.guess, listName: LIST } }, 'x', deps))
      .rejects.toMatchObject({ status: 409 });
    expect(await listSystem()).toHaveLength(1);
  });
});
