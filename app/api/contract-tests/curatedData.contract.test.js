// Contract test — routes/admin/curatedData.js against the real PostgreSQL 16
// schema. Curated export/import moves tags (Contexts/ContextMembers) and
// categories (GovernanceCategories/GovernanceCategoryAssignments) as JSON.
//
// Guards #679. The import resolves entities by GUID/displayName and upserts via
// ON CONFLICT; the export joins the GraphTags compat views back to Principals/
// Resources. This drives an import → export round-trip against the real schema —
// the kind of SQL-shape/constraint bug a mocked unit test can't see.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, resourceId, apId;

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-curated-data') RETURNING "id"`,
  )).rows[0].id;
  resourceId = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'Curated Res', 'Group') RETURNING "id"`,
    [systemId],
  )).rows[0].id;
  apId = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'Curated AP', 'BusinessRole') RETURNING "id"`,
    [systemId],
  )).rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE "contextType" = 'Tag' AND "targetType" = 'Resource' AND "displayName" = 'Imported Tag'`);
  await pool.query(`DELETE FROM "GovernanceCategories" WHERE "name" = 'Imported Cat'`); // cascades assignments
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);                // cascades Resources
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('POST /admin/import/curated', () => {
  it('imports tags + categories and resolves their assignments by GUID', async () => {
    const payload = {
      tags: [{
        name: 'Imported Tag', entityType: 'resource', color: '#ff0000',
        assignments: [{ entityId: resourceId, displayName: 'Curated Res', resourceType: 'Group' }],
      }],
      categories: [{
        name: 'Imported Cat', color: '#00ff00',
        assignments: [{ accessPackageId: apId, accessPackageDisplayName: 'Curated AP' }],
      }],
    };
    const res = await agent.post('/api/admin/import/curated').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stats.tagsInserted).toBe(1);
    expect(res.body.stats.assignmentsInserted).toBe(1);
    expect(res.body.stats.catsInserted).toBe(1);
    expect(res.body.stats.catAssignInserted).toBe(1);

    // The tag + membership landed in Contexts / ContextMembers.
    const tag = (await pool.query(
      `SELECT id FROM "Contexts" WHERE "contextType" = 'Tag' AND "displayName" = 'Imported Tag'`,
    )).rows[0];
    expect(tag).toBeDefined();
    const memberCount = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`,
      [tag.id, resourceId],
    )).rows[0].n;
    expect(memberCount).toBe(1);
  });

  it('400s when tags/categories are not arrays', async () => {
    const res = await agent.post('/api/admin/import/curated').send({ tags: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/export/curated', () => {
  it('exports the imported tag and category with their assignments', async () => {
    const res = await agent.get('/api/admin/export/curated');
    expect(res.status).toBe(200);
    const body = typeof res.body === 'object' && res.body.tags ? res.body : JSON.parse(res.text);
    expect(body.version).toBe('1.0');

    const tag = body.tags.find(t => t.name === 'Imported Tag');
    expect(tag).toBeDefined();
    expect(tag.entityType).toBe('resource');
    expect(tag.assignments.map(a => String(a.entityId).toLowerCase())).toContain(resourceId.toLowerCase());

    const cat = body.categories.find(c => c.name === 'Imported Cat');
    expect(cat).toBeDefined();
    expect(cat.assignments.map(a => String(a.accessPackageId).toLowerCase())).toContain(apId.toLowerCase());
  });
});
