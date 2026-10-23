// Contract test — Risky Applications against a real PostgreSQL schema.
//
// The unit tests mock the database, so they cannot tell whether the eight fact
// queries are valid SQL or join the right rows. This file seeds one app with a
// fact of every kind — an app-only grant, an admin-consented scope, an app
// registration with public-client flows, a secret on the service principal, a
// guest owner who left — and checks each of them reaches the score. A finding
// that goes missing here means its query no longer finds its rows.
//
// The database is shared with the other contract files, so rows are narrowed to
// this file's apps by name.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

const PREFIX = 'contract-risky-apps';
const GRAPH = '00000003-0000-0000-c000-000000000000';
const TENANT = randomUUID();
const ids = {
  app: randomUUID(), quiet: randomUUID(), graph: randomUUID(), owner: randomUUID(),
  appPermission: randomUUID(), scope: randomUUID(), registration: randomUUID(), ownership: randomUUID(),
};
const APP_ID = randomUUID();

let agent;
let pool;
let systemId;

const json = v => JSON.stringify(v);

async function principal(id, displayName, principalType, ext, accountEnabled = true) {
  await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "principalType", "accountEnabled", "extendedAttributes")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [id, systemId, displayName, principalType, accountEnabled, json(ext)]);
}

async function resource(id, displayName, resourceType, ext = {}) {
  await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "extendedAttributes")
     VALUES ($1, $2, $3, $4, $5::jsonb)`, [id, systemId, displayName, resourceType, json(ext)]);
}

async function assignment(resourceId, principalId, principalType) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId")
     VALUES ($1, $2, 'Direct', $3, $4)`, [resourceId, principalId, principalType, systemId]);
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName", "tenantId") VALUES ('EntraID', $1, $2) RETURNING "id"`, [PREFIX, TENANT]);
  systemId = sys.rows[0].id;

  // The app under test, registered in this tenant, with a ~276-year secret on the SP itself.
  await principal(ids.app, `${PREFIX} Mailbox Archiver`, 'ServicePrincipal',
    { appId: APP_ID, appOwnerOrganizationId: TENANT, secretCount: 1, secretMaxValidityDays: 100746 });
  await principal(ids.quiet, `${PREFIX} Intranet`, 'ServicePrincipal', { appId: randomUUID(), appOwnerOrganizationId: TENANT });
  await principal(ids.graph, `${PREFIX} Microsoft Graph`, 'ServicePrincipal', { appId: GRAPH });
  await principal(ids.owner, `${PREFIX} Former Contractor`, 'User', { userType: 'Guest' }, false);

  // App-only Mail.ReadWrite on Graph (identified only through the API's own SP record).
  await resource(ids.appPermission, 'Mail.ReadWrite on Microsoft Graph', 'ApplicationPermission',
    { permission: 'Mail.ReadWrite', targetApiSpId: ids.graph });
  await assignment(ids.appPermission, ids.app, 'ServicePrincipal');

  // Admin-consented delegated Mail.Send.
  await resource(ids.scope, 'Mail.Send on Microsoft Graph', 'DelegatedPermission',
    { clientSpId: ids.app, targetApiSpId: ids.graph, scope: 'Mail.Send', adminConsented: true });

  // Its app registration allows public-client flows.
  await resource(ids.registration, `${PREFIX} Mailbox Archiver`, 'AppRegistration', { appId: APP_ID, isFallbackPublicClient: true });

  // Owned by a disabled guest, through the enterprise app's ownership resource.
  await resource(ids.app, `${PREFIX} Mailbox Archiver`, 'Application', { appId: APP_ID });
  await resource(ids.ownership, `${PREFIX} Mailbox Archiver`, 'ServicePrincipalOwnership');
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
     VALUES ($1, $2, 'HasAppOwnership', $3)`, [ids.app, ids.ownership, systemId]);
  await assignment(ids.ownership, ids.owner, 'User');

  // Signed in today, so it is not "unused".
  await pool.query(
    `INSERT INTO "PrincipalActivity" ("principalId", "resourceId", "activityType", "lastSignInDateTime")
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'ServicePrincipalSignIn', now())`, [ids.app]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "PrincipalActivity" WHERE "principalId" = $1`, [ids.app]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

async function ownRows(query = 'minimumLevel=Low&useThreatFeed=false') {
  const res = await agent.get(`/api/reports/risky-applications/rows?${query}`);
  expect(res.status).toBe(200);
  return res.body.rows.filter(r => String(r.application).startsWith(PREFIX));
}

describe('GET /reports/risky-applications/rows', () => {
  it('scores the seeded app from every kind of fact the queries read', async () => {
    const rows = await ownRows();
    const app = rows.find(r => r.application === `${PREFIX} Mailbox Archiver`);
    expect(app).toBeTruthy();
    expect(app).toMatchObject({
      score: 100, level: 'Critical', registeredIn: 'This tenant', appOnlyReach: 'Critical',
      applicationPermissions: 1, adminConsentedScopes: 1, publicClientFlows: true, owners: 1, secrets: 1,
      _entity: { kind: 'resource', id: ids.app },
    });
    // One finding per query: app-only grant, delegated scope, app registration,
    // secret on the SP, owner (disabled + guest).
    expect(app.findings).toMatch(/critical-risk application permissions with nobody signed in: Mail\.ReadWrite/);
    expect(app.findings).toMatch(/administrator consented on behalf of every user to Mail\.Send/);
    expect(app.findings).toMatch(/Public-client flows are allowed/);
    expect(app.findings).toMatch(/sit on the enterprise application itself/);
    expect(app.findings).toMatch(/owner\(s\) are disabled or deleted/);
    expect(app.findings).toMatch(/guest account\(s\) own it/);
    expect(app.findings).not.toMatch(/No sign-in|Never signed in/);
    expect(app.lastSignIn).toBeTruthy();
  });

  it('leaves an app with nothing against it out at the default level, and shows it at Low only if it scores', async () => {
    const atDefault = await ownRows('useThreatFeed=false');
    expect(atDefault.map(r => r.application)).toEqual([`${PREFIX} Mailbox Archiver`]);
    const atLow = await ownRows();
    expect(atLow.some(r => r.application === `${PREFIX} Intranet`)).toBe(false);
  });

  it('serves the report in the catalogue', async () => {
    const res = await agent.get('/api/reports');
    const report = res.body.data.find(r => r.name === 'risky-applications');
    expect(report).toMatchObject({ form: 'list', displayName: 'Risky Applications (Entra ID)' });
  });
});
