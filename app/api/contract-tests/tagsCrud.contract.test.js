// Contract test — routes/tags/crud.js against the real PostgreSQL 16 schema.
//
// Guards #679. Tags are stored as manual Contexts (contextType='Tag') and read
// back through the GraphTags/GraphTagAssignments compat views; the write path
// targets Contexts + ContextMembers. This walks the full lifecycle (create →
// list-with-count → assign → unassign → assign-by-filter → patch → delete)
// against the real schema + views, which the SQL-blind unit mocks never do.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, resourceId, tagId;

const findTag = (body, id) => body.find(t => t.id === id);

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-tags-crud') RETURNING "id"`,
  )).rows[0].id;
  resourceId = (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType")
     VALUES (gen_random_uuid(), $1, 'Taggable Resource', 'Group') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  const created = await agent.post('/api/tags').send({ name: 'Contract Tag', entityType: 'resource', color: '#ff0000' });
  expect(created.status).toBe(201);
  tagId = created.body.id;
});

afterAll(async () => {
  if (tagId) await pool.query(`DELETE FROM "Contexts" WHERE "id" = $1`, [tagId]); // cascades ContextMembers
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);          // cascades Resources
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('tag CRUD lifecycle', () => {
  it('POST created a tag with the right shape', () => {
    // asserted in beforeAll; re-confirm the id round-tripped
    expect(tagId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('GET /tags lists the tag with a zero assignment count', async () => {
    const res = await agent.get('/api/tags?entityType=resource');
    expect(res.status).toBe(200);
    const tag = findTag(res.body, tagId);
    expect(tag).toBeDefined();
    expect(tag.name).toBe('Contract Tag');
    expect(tag.color).toBe('#ff0000');
    expect(tag.entityType).toBe('resource');
    expect(tag.assignmentCount).toBe(0);
  });

  it('assign → the list reflects a count of 1 → unassign → back to 0', async () => {
    const add = await agent.post(`/api/tags/${tagId}/assign`).send({ entityIds: [resourceId] });
    expect(add.status).toBe(200);
    expect(add.body.inserted).toBe(1);

    const listed = await agent.get('/api/tags?entityType=resource');
    expect(findTag(listed.body, tagId).assignmentCount).toBe(1);

    const del = await agent.post(`/api/tags/${tagId}/unassign`).send({ entityIds: [resourceId] });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(1);

    const relisted = await agent.get('/api/tags?entityType=resource');
    expect(findTag(relisted.body, tagId).assignmentCount).toBe(0);
  });

  it('assign-by-filter tags entities matching a search', async () => {
    const res = await agent.post(`/api/tags/${tagId}/assign-by-filter`).send({ entityType: 'resource', search: 'Taggable' });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    const listed = await agent.get('/api/tags?entityType=resource');
    expect(findTag(listed.body, tagId).assignmentCount).toBe(1);
  });

  it('rejects a duplicate name for the same entity type', async () => {
    const res = await agent.post('/api/tags').send({ name: 'Contract Tag', entityType: 'resource' });
    expect(res.status).toBe(409);
  });

  it('validates input (missing name, bad color)', async () => {
    expect((await agent.post('/api/tags').send({ entityType: 'resource' })).status).toBe(400);
    expect((await agent.patch(`/api/tags/${tagId}`).send({ color: 'red' })).status).toBe(400);
  });

  it('PATCH updates the color', async () => {
    const res = await agent.patch(`/api/tags/${tagId}`).send({ color: '#00ff00' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('#00ff00');
  });

  it('DELETE removes the tag from the list', async () => {
    const del = await agent.delete(`/api/tags/${tagId}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const listed = await agent.get('/api/tags?entityType=resource');
    expect(findTag(listed.body, tagId)).toBeUndefined();
    tagId = null; // already deleted — skip afterAll cleanup of the context
  });
});
