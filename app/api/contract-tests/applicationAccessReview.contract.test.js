// Contract test — the access-review template against a real PostgreSQL schema.
//
// The unit tests mock the DB, so they prove the layout and the notice
// arithmetic but say nothing about whether five joins across Contexts,
// ContextMembers, Resources, ResourceRelationships, ResourceAssignments and
// Principals are valid SQL selecting the right rows. That is this file's job,
// and it is the only place the ownership chain (entitlement -> HasOwnership ->
// ownership resource -> Direct assignment -> Principal) is actually traversed.
//
// The database is shared with the other contract files, so everything this file
// seeds hangs off its own system and its own contexts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import JSZip from 'jszip';
import { bootContractApp } from '../test-utils/contractApp.js';
import { asBinary, headerLabels, sheetNamed } from '../test-utils/xlsxDownload.js';

const SYSTEM_NAME = 'contract-app-access-review';
const APP_NAME = 'Contract Ledger Application';
// A second context of another type, so "several contexts" is a real run and
// "any context of resources" is not just a logical application.
const SECOND_NAME = 'Contract Archive Tag';

// What the customer's catalogue looks like: the fields are picked, not built in.
const FIELDS = [
  'context.name', 'context.owner', 'context.ext.cmdbReference',
  'entitlement.type', 'entitlement.ext.certfrequency', 'entitlement.owner', 'entitlement.ownerEmail',
].join(',');

let agent;
let pool;
let systemId;

const id = {
  app: randomUUID(),
  app2: randomUUID(),
  plain2: randomUUID(),
  plain: randomUUID(),        // two direct holders, one via a role, an owner
  quiet: randomUUID(),        // no holders, a Group rather than an Entitlement
  roled: randomUUID(),        // in two roles
  role1: randomUUID(),
  role2: randomUUID(),
  ownership: randomUUID(),
  owner: randomUUID(),
  holderA: randomUUID(),
  holderB: randomUUID(),
};

async function context(contextId, contextType, displayName, attrs) {
  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","description",
                             "scopeSystemId","ownerUserId","extendedAttributes")
     VALUES ($1,'synced','Resource',$2,$3,'Ledger of record',$4,'EMP-1',$5::jsonb)`,
    [contextId, contextType, displayName, systemId, JSON.stringify(attrs)]);
}

const member = (contextId, memberId) => pool.query(
  `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy")
   VALUES ($1,'Resource',$2,'sync')`, [contextId, memberId]);

async function seed() {
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`, [SYSTEM_NAME]);
  systemId = sys.rows[0].id;

  await context(id.app, 'LogicalApplication', APP_NAME, { cmdbReference: 'CI-1', connectionType: 'SaaS' });

  // The context owner is found through Principals."employeeId", the other
  // spelling a catalogue uses for a person.
  await principal(id.owner, 'Owner Person', 'owner@example.com', 'EMP-1');
  await principal(id.holderA, 'Holder A', 'a@example.com');
  await principal(id.holderB, 'Holder B', 'b@example.com');

  await resource(id.plain, 'ENT_PLAIN', 'Entitlement', { certfrequency: 'Quarterly', costcentercode: 4410 });
  await resource(id.quiet, 'ENT_QUIET', 'Group', {});
  await resource(id.roled, 'ENT_ROLED', 'Entitlement', { certfrequency: 'Annually' });
  await resource(id.role1, 'Ledger Clerk', 'BusinessRole', {});
  await resource(id.role2, 'Ledger Supervisor', 'BusinessRole', {});
  await resource(id.ownership, 'ENT_PLAIN', 'ResourceOwnership',
    { ownedResourceId: 'ENT_PLAIN', ownedResourceType: 'Entitlement' });

  for (const m of [id.plain, id.quiet, id.roled]) await member(id.app, m);

  await context(id.app2, 'Tag', SECOND_NAME, { cmdbReference: 'CI-2' });
  await resource(id.plain2, 'ENT_ARCHIVE', 'Entitlement', { certfrequency: 'Monthly' });
  await member(id.app2, id.plain2);

  // A business role is NOT a member of the context — it grants into it. Two
  // roles on one entitlement, so the report has to aggregate them.
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

async function rows(contexts = APP_NAME, extra = { fields: FIELDS }) {
  const res = await agent.get('/api/reports/application-access-review/rows').query({ contexts, ...extra });
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
  it('returns one row per resource of the context, whatever its type, by name', async () => {
    const body = await rows();
    expect(body.rows.map(r => r.entitlement)).toEqual(['ENT_PLAIN', 'ENT_QUIET', 'ENT_ROLED']);
    expect(rowFor(body, 'ENT_QUIET')['entitlement.type']).toBe('Group');
    expect(body.total).toBe(3);
    expect(body.truncated).toBe(false);
  });

  it('serves the columns that were picked, in the order picked', async () => {
    const body = await rows();
    expect(body.columns.map(c => c.key)).toEqual([
      'entitlement', ...FIELDS.split(','), 'businessRoles', 'directAssignments', 'viaRoleAssignments',
    ]);
  });

  it('counts distinct holders per column and ignores a soft-deleted assignment', async () => {
    const body = await rows();
    // Holder A (direct + indirect) and Holder B (direct) — the deleted row for
    // the owner must not raise directAssignments to 3.
    expect(rowFor(body, 'ENT_PLAIN')).toMatchObject({ directAssignments: 2, viaRoleAssignments: 1 });
    expect(rowFor(body, 'ENT_ROLED')).toMatchObject({
      directAssignments: 0, viaRoleAssignments: 1, businessRoles: 'Ledger Clerk, Ledger Supervisor',
    });
    expect(rowFor(body, 'ENT_QUIET')).toMatchObject({ directAssignments: 0, viaRoleAssignments: 0, businessRoles: null });
  });

  it('resolves the entitlement owner through the ownership resource to a person', async () => {
    const body = await rows();
    expect(rowFor(body, 'ENT_PLAIN')).toMatchObject({
      'entitlement.owner': 'Owner Person', 'entitlement.ownerEmail': 'owner@example.com',
    });
    // The ownership resource itself is not a member, so it is not a row.
    expect(body.rows.filter(r => r.entitlement === 'ENT_PLAIN')).toHaveLength(1);
    expect(rowFor(body, 'ENT_QUIET')['entitlement.owner']).toBeNull();
  });

  it('reads the picked attributes of the context and of the resource as stored', async () => {
    const body = await rows();
    expect(rowFor(body, 'ENT_PLAIN')).toMatchObject({
      'context.name': APP_NAME,
      'context.owner': 'Owner Person',
      'context.ext.cmdbReference': 'CI-1',
      'entitlement.ext.certfrequency': 'Quarterly',
    });
    expect(rowFor(body, 'ENT_QUIET')['entitlement.ext.certfrequency']).toBeNull();
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

  it('matches a context by id as well as by name, and takes a context of any type', async () => {
    expect((await rows(id.app)).total).toBe(3);
    expect((await rows(SECOND_NAME)).rows.map(r => r.entitlement)).toEqual(['ENT_ARCHIVE']);
  });

  it('still answers to the parameter\'s old name', async () => {
    const res = await agent.get('/api/reports/application-access-review/rows').query({ applications: APP_NAME });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  it('says so when a name matches no context, rather than returning an empty table', async () => {
    const body = await rows('No Such Application');
    expect(body.rows).toEqual([]);
    expect(noticeText(body)).toMatch(/No context of resources matches "No Such Application"/);
  });
});

describe('GET /reports/application-access-review/export', () => {
  it('serves the rows as CSV with the picked columns and no notices', async () => {
    const res = await agent.get('/api/reports/application-access-review/export')
      .query({ contexts: APP_NAME, fields: 'entitlement.ext.costcentercode', format: 'csv' });

    expect(res.status).toBe(200);
    const [header, ...lines] = res.text.split('\r\n');
    expect(header).toBe(
      '"Entitlement","costcentercode","Context","Entitlement owner",'
      + '"Granted by role(s)","Users assigned directly","Users assigned via a role"');
    expect(lines).toHaveLength(3);
    expect(res.text).toContain('"Ledger Clerk, Ledger Supervisor"');
    expect(res.text).toContain('"4410"');
  });

  /** One tab of the workbook a run over `contexts` produces. */
  async function workbookFor(contexts, tab = 'Data', extra = {}) {
    const res = await asBinary(agent.get('/api/reports/application-access-review/export')
      .query({ contexts, fields: FIELDS, format: 'xlsx', ...extra }));
    expect(res.status).toBe(200);
    return sheetNamed(res.body, tab);
  }

  it('opens the workbook with the context, and keeps in the table only what the pivots need', async () => {
    const block = {};
    (await workbookFor(APP_NAME, 'Summary')).eachRow(row => {
      const label = row.getCell(1).value;
      if (typeof label === 'string' && !(label in block)) block[label] = row.getCell(2).value;
    });
    expect(block.Context).toBe(APP_NAME);
    expect(block['Context owner']).toBe('Owner Person');
    expect(block['Context · cmdbReference']).toBe('CI-1');

    // The default pivot rows are the context and the entitlement owner, so the
    // context name stays in the table as well; the CMDB reference does not.
    expect(headerLabels(await workbookFor(APP_NAME), 'Entitlement')).toEqual([
      'Entitlement', 'Context', 'Resource type', 'certfrequency', 'Entitlement owner',
      'Entitlement owner email', 'Granted by role(s)', 'Users assigned directly', 'Users assigned via a role',
    ]);
  });

  it('builds the pivots on the fields picked for them', async () => {
    const res = await asBinary(agent.get('/api/reports/application-access-review/export').query({
      contexts: APP_NAME, fields: 'entitlement.type', format: 'xlsx',
      pivotRows: 'entitlement.ext.certfrequency', pivotFilters: 'entitlement.type',
    }));
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(res.body);
    const read = path => zip.file(path).async('string');
    // Field names in cache order, then the indexes each axis of pivot 1 uses.
    const names = [...(await read('xl/pivotCache/pivotCacheDefinition1.xml')).matchAll(/<cacheField name="([^"]*)"/g)]
      .map(m => m[1]);
    const table = await read('xl/pivotTables/pivotTable1.xml');
    const rowBlock = /<rowFields[^>]*>(.*?)<\/rowFields>/.exec(table)?.[1] ?? '';
    const pageBlock = /<pageFields[^>]*>(.*?)<\/pageFields>/.exec(table)?.[1] ?? '';
    const named = (block, pattern) => [...block.matchAll(pattern)].map(m => names[Number(m[1])]);
    expect(named(rowBlock, /<field x="(\d+)"/g)).toEqual(['certfrequency', 'Entitlement']);
    expect(named(pageBlock, /fld="(\d+)"/g)).toEqual(['Resource type', 'Users assigned via a role']);
  });

  it('keeps the context on every row when the run covers more than one', async () => {
    const labels = headerLabels(await workbookFor(`${APP_NAME},${SECOND_NAME}`), 'Entitlement');
    expect(labels).toContain('Context');
    expect(labels).toContain('Context · cmdbReference');
  });
});
