// Contract test — the application-access-review template against a real
// PostgreSQL schema.
//
// The unit tests mock the DB, so they prove the section rule and the notice
// arithmetic but say nothing about whether five joins across Contexts,
// ContextMembers, Resources, ResourceRelationships, ResourceAssignments and
// Principals are valid SQL selecting the right rows. That is this file's job,
// and it is the only place the ownership chain (entitlement -> HasOwnership ->
// ownership resource -> Direct assignment -> Principal) is actually traversed.
//
// The database is shared with the other contract files, so everything this file
// seeds hangs off its own system and its own application context.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { asBinary, headerLabels, sheetNamed } from '../test-utils/xlsxDownload.js';

const SYSTEM_NAME = 'contract-app-access-review';
const APP_NAME = 'Contract Ledger Application';
// A second application, so the multi-application case is a real run rather than
// a simulated one: its details differ per row and must stay in the table.
const SECOND_APP_NAME = 'Contract Archive Application';

let agent;
let pool;
let systemId;

const id = {
  app: randomUUID(),
  app2: randomUUID(),
  plain2: randomUUID(),
  plain: randomUUID(),        // requestable, no role, two direct holders
  quiet: randomUUID(),        // not requestable, no role, no holders
  roled: randomUUID(),        // requestable AND in two roles -> section 3
  role1: randomUUID(),
  role2: randomUUID(),
  ownership: randomUUID(),
  owner: randomUUID(),
  holderA: randomUUID(),
  holderB: randomUUID(),
};

async function seed() {
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`, [SYSTEM_NAME]);
  systemId = sys.rows[0].id;

  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","description",
                             "scopeSystemId","ownerUserId","extendedAttributes")
     VALUES ($1,'synced','Resource','LogicalApplication',$2,'Ledger of record',$3,'EMP-1',
             '{"abbreviation":"CLA","cmdbReference":"CI-1","connectionType":"SaaS","onboardingArea":"Sector Q","applicationOwner":"EMP-1"}'::jsonb)`,
    [id.app, APP_NAME, systemId]);

  // The application owner is found through Principals."employeeId", the other
  // spelling a catalogue uses for a person.
  await principal(id.owner, 'Owner Person', 'owner@example.com', 'EMP-1');
  await principal(id.holderA, 'Holder A', 'a@example.com');
  await principal(id.holderB, 'Holder B', 'b@example.com');

  await resource(id.plain, 'ENT_PLAIN', 'Entitlement',
    { requestable: 1, certfrequency: 'Quarterly' });
  await resource(id.quiet, 'ENT_QUIET', 'Entitlement',
    { requestable: 0, certfrequency: null });
  await resource(id.roled, 'ENT_ROLED', 'Entitlement',
    { requestable: 1, certfrequency: 'Quaterly' });
  await resource(id.role1, 'Ledger Clerk', 'BusinessRole', {});
  await resource(id.role2, 'Ledger Supervisor', 'BusinessRole', {});
  await resource(id.ownership, 'ENT_PLAIN', 'ResourceOwnership',
    { ownedResourceId: 'ENT_PLAIN', ownedResourceType: 'Entitlement' });

  for (const member of [id.plain, id.quiet, id.roled]) {
    await pool.query(
      `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy")
       VALUES ($1,'Resource',$2,'sync')`, [id.app, member]);
  }

  // A second application with its own details, so "several applications" is a
  // real run rather than a simulated one.
  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","description",
                             "scopeSystemId","ownerUserId","extendedAttributes")
     VALUES ($1,'synced','Resource','LogicalApplication',$2,'Archive of record',$3,'EMP-1',
             '{"abbreviation":"CAA","cmdbReference":"CI-2","connectionType":"LDAP","onboardingArea":"Sector R"}'::jsonb)`,
    [id.app2, SECOND_APP_NAME, systemId]);
  await resource(id.plain2, 'ENT_ARCHIVE', 'Entitlement', { requestable: 1, certfrequency: 'Annually' });
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy")
     VALUES ($1,'Resource',$2,'sync')`, [id.app2, id.plain2]);

  // A business role is NOT a member of the application context — it grants into
  // it. Two roles on one entitlement, so the report has to aggregate them.
  await relationship(id.role1, id.roled, 'Contains');
  await relationship(id.role2, id.roled, 'Contains');
  await relationship(id.plain, id.ownership, 'HasOwnership');

  // Two direct holders and one via-role holder on ENT_PLAIN. Holder A holds it
  // BOTH ways, which is what separates "distinct people per column" from
  // "distinct people overall".
  await assignment(id.plain, id.holderA, 'Direct');
  await assignment(id.plain, id.holderB, 'Direct');
  await assignment(id.plain, id.holderA, 'Indirect');
  await assignment(id.roled, id.holderB, 'Indirect');
  // The owner link is an ordinary Direct assignment on the ownership resource.
  await assignment(id.ownership, id.owner, 'Direct');
  // A soft-deleted holder must not be counted.
  await assignment(id.plain, id.owner, 'Direct', { deleted: true });
}

const principal = (pid, displayName, email, employeeId = null) => pool.query(
  `INSERT INTO "Principals" ("id","systemId","displayName","email","principalType","employeeId","extendedAttributes")
   VALUES ($1,$2,$3,$4,'User',$5,'{}'::jsonb)`, [pid, systemId, displayName, email, employeeId]);

const resource = (rid, displayName, resourceType, attrs) => pool.query(
  `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","extendedAttributes")
   VALUES ($1,$2,$3,$4,$5::jsonb)`, [rid, systemId, displayName, resourceType, JSON.stringify(attrs)]);

const relationship = (parent, child, type) => pool.query(
  `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","systemId")
   VALUES ($1,$2,$3,$4)`, [parent, child, type, systemId]);

const assignment = (resourceId, principalId, type, { deleted = false } = {}) => pool.query(
  `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId","deletedAt")
   VALUES ($1,$2,$3,$4,$5)`,
  [resourceId, principalId, type, systemId, deleted ? new Date() : null]);

async function rows(applications = APP_NAME) {
  const res = await agent.get('/api/reports/application-access-review/rows')
    .query({ applications });
  expect(res.status).toBe(200);
  return res.body;
}

const rowFor = (body, name) => body.rows.find(r => r.entitlement === name);
const noticeText = (body) => body.notices.map(n => n.text).join('\n');

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  await seed();
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "ContextMembers" WHERE "contextId" = ANY($1::uuid[])`, [[id.app, id.app2]]);
  await pool.query(`DELETE FROM "Contexts" WHERE "id" = ANY($1::uuid[])`, [[id.app, id.app2]]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /reports/application-access-review/rows', () => {
  it('returns one row per entitlement of the named application, in section order', async () => {
    const body = await rows();
    // Action list, then information only, then what a role already manages.
    expect(body.rows.map(r => r.entitlement)).toEqual(['ENT_PLAIN', 'ENT_QUIET', 'ENT_ROLED']);
    expect(body.total).toBe(3);
    expect(body.truncated).toBe(false);
  });

  it('assigns each of the three sections from the data, role membership winning', async () => {
    const body = await rows();
    expect(rowFor(body, 'ENT_PLAIN').section).toBe('requestable, not in a role');
    expect(rowFor(body, 'ENT_QUIET').section).toBe('not requestable, not in a role');
    // ENT_ROLED is requestable too; the Contains relationships override that.
    expect(rowFor(body, 'ENT_ROLED')).toMatchObject({
      section: 'part of a role',
      requestable: 'Yes',
      businessRoles: 'Ledger Clerk, Ledger Supervisor',
    });
  });

  it('counts distinct holders per column and ignores a soft-deleted assignment', async () => {
    const body = await rows();
    // Holder A (direct + indirect) and Holder B (direct) — the deleted row for
    // the owner must not raise directAssignments to 3.
    expect(rowFor(body, 'ENT_PLAIN')).toMatchObject({ directAssignments: 2, viaRoleAssignments: 1 });
    expect(rowFor(body, 'ENT_ROLED')).toMatchObject({ directAssignments: 0, viaRoleAssignments: 1 });
    expect(rowFor(body, 'ENT_QUIET')).toMatchObject({ directAssignments: 0, viaRoleAssignments: 0 });
  });

  it('resolves the entitlement owner through the ownership resource to a person', async () => {
    const body = await rows();
    expect(rowFor(body, 'ENT_PLAIN')).toMatchObject({
      entitlementOwner: 'Owner Person', entitlementOwnerEmail: 'owner@example.com',
    });
    // The ownership resource itself is not an entitlement, so it is not a row.
    expect(body.rows.filter(r => r.entitlement === 'ENT_PLAIN')).toHaveLength(1);
    expect(rowFor(body, 'ENT_QUIET').entitlementOwner).toBeNull();
  });

  it('carries the application context, with the owner resolved by employee number', async () => {
    const body = await rows();
    expect(rowFor(body, 'ENT_PLAIN')).toMatchObject({
      application: APP_NAME,
      applicationDescription: 'Ledger of record',
      applicationOwner: 'Owner Person',
      abbreviation: 'CLA',
      cmdbReference: 'CI-1',
      connectionType: 'SaaS',
      onboardingSector: 'Sector Q',
    });
  });

  it('shows an unset frequency as a value and reports the misspelling next to it', async () => {
    const body = await rows();
    expect(rowFor(body, 'ENT_QUIET').certificationFrequency).toBe('Not set');
    expect(rowFor(body, 'ENT_ROLED').certificationFrequency).toBe('Quaterly');
    expect(noticeText(body)).toMatch(/near-duplicate spellings: "Quarterly" \/ "Quaterly"/);
  });

  it('summarises the scope with numbers taken from the real rows', async () => {
    const text = noticeText(await rows());
    // Holder A, Holder B — the owner's only live assignment is on the ownership
    // resource, which is not in scope, and their deleted one does not count.
    expect(text).toMatch(/2 unique user\(s\) hold at least one assignment/);
    expect(text).toMatch(/3 entitlement\(s\) in scope/);
    expect(text).toMatch(/1 distinct entitlement owner\(s\); 2 entitlement\(s\) have no owner/);
    expect(text).toMatch(/33\.3% of entitlements are part of a business role \(1 of 3\)/);
  });

  it('matches the application by id as well as by name', async () => {
    const body = await rows(id.app);
    expect(body.total).toBe(3);
  });

  it('says so when a name matches no application, rather than returning an empty table', async () => {
    const body = await rows('No Such Application');
    expect(body.rows).toEqual([]);
    expect(noticeText(body)).toMatch(/No logical application matches "No Such Application"/);
  });
});

describe('GET /reports/application-access-review/export', () => {
  it('serves the rows as CSV with the declared columns and no notices', async () => {
    const res = await agent.get('/api/reports/application-access-review/export')
      .query({ applications: APP_NAME, format: 'csv' });

    expect(res.status).toBe(200);
    const [header, ...lines] = res.text.split('\r\n');
    expect(header).toContain('"Users assigned directly","Users assigned via a role"');
    expect(lines).toHaveLength(3);
    expect(res.text).toContain('"Ledger Clerk, Ledger Supervisor"');
    expect(res.text).toContain('"Not set"');
  });

  /** One tab of the workbook a run over `applications` produces. */
  async function workbookFor(applications, tab = 'Data') {
    const res = await asBinary(
      agent.get('/api/reports/application-access-review/export').query({ applications, format: 'xlsx' }));
    expect(res.status).toBe(200);
    return sheetNamed(res.body, tab);
  }

  it('opens the workbook with the application, and keeps in the table only what the pivots need', async () => {
    // The Summary tab: what the application IS, before the entitlements.
    const block = {};
    (await workbookFor(APP_NAME, 'Summary')).eachRow(row => {
      const label = row.getCell(1).value;
      if (typeof label === 'string' && !(label in block)) block[label] = row.getCell(2).value;
    });
    expect(block.Application).toBe(APP_NAME);
    expect(block['Application owner']).toBe('Owner Person');
    expect(block['Application description']).toBe('Ledger of record');
    expect(block['CMDB reference']).toBe('CI-1');
    expect(block['Connection type']).toBe('SaaS');
    expect(block['Onboarding sector']).toBe('Sector Q');

    // …and the table carries what varies per entitlement, plus the two
    // one-value columns the owner pivot is built on — the description, CMDB
    // reference and the rest are stated once on the Summary tab and nowhere else.
    expect(headerLabels(await workbookFor(APP_NAME), 'Entitlement')).toEqual([
      'Entitlement', 'Section', 'Requestable', 'Certification frequency',
      'Entitlement owner', 'Entitlement owner email', 'Granted by role(s)',
      'Users assigned directly', 'Users assigned via a role', 'Application', 'Application owner',
    ]);
  });

  it('keeps the application on every row when the run covers more than one', async () => {
    const labels = headerLabels(await workbookFor(`${APP_NAME},${SECOND_APP_NAME}`), 'Entitlement');
    // They vary per row now, so they stay in the table and there is no block.
    expect(labels).toContain('Application');
    expect(labels).toContain('CMDB reference');
  });
});
