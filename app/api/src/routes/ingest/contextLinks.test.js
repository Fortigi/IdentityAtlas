// Unit tests for routes/ingest/contextLinks.js — context roles and SameUnitAs
// links sent by a crawler. DB and crawler auth mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query } from '../../db/connection.js';
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
const { mockHasPermission, mockHasSystemAccess } = vi.hoisted(() => ({
  mockHasPermission: vi.fn(),
  mockHasSystemAccess: vi.fn(),
}));
vi.mock('../../middleware/crawlerAuth.js', () => ({
  crawlerHasPermission: mockHasPermission,
  crawlerHasSystemAccess: mockHasSystemAccess,
}));

const {
  default: router, parseLinkEnvelope, parseRoleRecords, parseRelationshipRecords,
  roleInsertSql, RELATIONSHIP_INSERT_SQL, MAX_LINK_RECORDS,
} = await import('./contextLinks.js');
const app = mountRouter(router);

const CTX  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CTX2 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const P1   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const I1   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  query.mockReset();
  mockHasPermission.mockReset().mockReturnValue(true);
  mockHasSystemAccess.mockReset().mockReturnValue(true);
});

describe('parseLinkEnvelope', () => {
  it('returns the system as a number and the records', () => {
    expect(parseLinkEnvelope({ systemId: '7', records: [] })).toEqual({ systemId: 7, records: [] });
  });

  it.each([
    ['no body', undefined, /JSON object/],
    ['an array body', [], /JSON object/],
    ['no systemId', { records: [] }, /systemId/],
    ['a zero systemId', { systemId: 0, records: [] }, /systemId/],
    ['a fractional systemId', { systemId: 1.5, records: [] }, /systemId/],
    ['records that are not an array', { systemId: 3, records: {} }, /records must be an array/],
  ])('rejects %s', (_label, body, message) => {
    expect(parseLinkEnvelope(body)).toMatchObject({ status: 400, message });
  });

  it('caps the batch at MAX_LINK_RECORDS, and accepts exactly that many', () => {
    expect(parseLinkEnvelope({ systemId: 3, records: new Array(MAX_LINK_RECORDS).fill({}) }).records).toHaveLength(MAX_LINK_RECORDS);
    expect(parseLinkEnvelope({ systemId: 3, records: new Array(MAX_LINK_RECORDS + 1).fill({}) }))
      .toMatchObject({ status: 400, message: /At most 5000/ });
  });
});

describe('parseRoleRecords', () => {
  it('lower-cases the context and keeps the parsed role', () => {
    expect(parseRoleRecords([{ contextId: CTX.toUpperCase(), role: 'Responsible', identityId: I1 }]))
      .toEqual({ rows: [{ contextId: CTX, role: 'Responsible', holderCol: 'identityId', holderId: I1 }] });
  });

  it('names the index of the first bad record', () => {
    const ok = { contextId: CTX, role: 'Accountable', principalId: P1 };
    expect(parseRoleRecords([ok, { role: 'Accountable', principalId: P1 }]))
      .toMatchObject({ status: 400, message: 'records[1]: contextId (uuid) is required' });
    expect(parseRoleRecords([ok, ok, { contextId: CTX, role: 'Owner', principalId: P1 }]))
      .toMatchObject({ status: 400, message: /^records\[2\]: role must be one of/ });
    expect(parseRoleRecords([null])).toMatchObject({ status: 400, message: /^records\[0\]: contextId/ });
  });
});

describe('parseRelationshipRecords', () => {
  it('accepts a SameUnitAs link between two contexts', () => {
    expect(parseRelationshipRecords([{ contextId: CTX, relatedContextId: CTX2.toUpperCase(), relationshipType: 'SameUnitAs' }]))
      .toEqual({ rows: [{ contextId: CTX, relatedContextId: CTX2, relationshipType: 'SameUnitAs' }] });
  });

  it('refuses a self-link even when the case differs, and an unknown type', () => {
    expect(parseRelationshipRecords([{ contextId: CTX, relatedContextId: CTX.toUpperCase(), relationshipType: 'SameUnitAs' }]))
      .toMatchObject({ status: 400, message: 'records[0]: A context cannot relate to itself' });
    expect(parseRelationshipRecords([{ contextId: CTX, relatedContextId: CTX2, relationshipType: 'Contains' }]))
      .toMatchObject({ status: 400, message: /^records\[0\]: relationshipType must be one of/ });
  });
});

describe('the insert statements', () => {
  it('join the holder table that matches the holder column, and write sync rows only for owned role-bearing contexts', () => {
    const p = roleInsertSql('principalId');
    expect(p).toContain('"ContextRoles" ("contextId", "principalId", role, "addedBy")');
    expect(p).toContain('JOIN "Principals" h');
    expect(p).toMatch(/'sync'/);
    expect(p).toContain('c."scopeSystemId" = $4');
    expect(p).toContain('c."contextCategory" = ANY($5::text[])');
    expect(p).toContain('ON CONFLICT DO NOTHING');
    const i = roleInsertSql('identityId');
    expect(i).toContain('"identityId", role');
    expect(i).toContain('JOIN "Identities" h');
  });

  it('links only an owned context to one holding a different kind of member', () => {
    expect(RELATIONSHIP_INSERT_SQL).toContain('b."targetType" <> a."targetType"');
    expect(RELATIONSHIP_INSERT_SQL).toContain('a."scopeSystemId" = $4');
    expect(RELATIONSHIP_INSERT_SQL).toMatch(/'sync'/);
    expect(RELATIONSHIP_INSERT_SQL).toContain('ON CONFLICT DO NOTHING');
  });
});

describe('POST /ingest/context-roles', () => {
  const body = {
    systemId: 3,
    records: [
      { contextId: CTX, role: 'Accountable', principalId: P1 },
      { contextId: CTX, role: 'Responsible', identityId: I1 },
    ],
  };

  it('inserts each record with its own parameters and reports inserted vs skipped', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(app).post('/api/ingest/context-roles').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 1, skipped: 1 });
    expect(query).toHaveBeenCalledTimes(2);
    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain('JOIN "Principals" h');
    expect(params1).toEqual([CTX, P1, 'Accountable', 3, ['OrganizationalUnit', 'LogicalApplication']]);
    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain('JOIN "Identities" h');
    expect(params2).toEqual([CTX, I1, 'Responsible', 3, ['OrganizationalUnit', 'LogicalApplication']]);
  });

  it('checks the ingest permission and access to the envelope system', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await request(app).post('/api/ingest/context-roles').send(body);
    expect(mockHasPermission.mock.calls[0][1]).toBe('ingest');
    expect(mockHasSystemAccess.mock.calls[0][1]).toBe(3);
  });

  it('403 without the ingest permission, before reading the body', async () => {
    mockHasPermission.mockReturnValue(false);
    const res = await request(app).post('/api/ingest/context-roles').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(query).not.toHaveBeenCalled();
  });

  it('403 for a system the crawler may not write', async () => {
    mockHasSystemAccess.mockReturnValue(false);
    const res = await request(app).post('/api/ingest/context-roles').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Crawler does not have access to system 3');
    expect(query).not.toHaveBeenCalled();
  });

  it('400 on a bad envelope or a bad record, writing nothing', async () => {
    const noSystem = await request(app).post('/api/ingest/context-roles').send({ records: [] });
    expect(noSystem.status).toBe(400);
    const badRecord = await request(app).post('/api/ingest/context-roles')
      .send({ systemId: 3, records: [body.records[0], { contextId: CTX, role: 'Accountable' }] });
    expect(badRecord.status).toBe(400);
    expect(badRecord.body.error).toMatch(/^records\[1\]: Exactly one of principalId or identityId/);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers an empty batch with zero counts', async () => {
    const res = await request(app).post('/api/ingest/context-roles').send({ systemId: 3, records: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 0, skipped: 0 });
  });

  it('500 when the database fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/ingest/context-roles').send(body);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to ingest context-roles');
    spy.mockRestore();
  });
});

describe('POST /ingest/context-relationships', () => {
  it('inserts the link with the envelope system as the owner check', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app).post('/api/ingest/context-relationships')
      .send({ systemId: 2, records: [{ contextId: CTX, relatedContextId: CTX2, relationshipType: 'SameUnitAs' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 1, skipped: 0 });
    expect(query).toHaveBeenCalledWith(RELATIONSHIP_INSERT_SQL, [CTX, CTX2, 'SameUnitAs', 2]);
  });

  it('counts a link that did not land as skipped', async () => {
    query.mockResolvedValueOnce({});
    const res = await request(app).post('/api/ingest/context-relationships')
      .send({ systemId: 2, records: [{ contextId: CTX, relatedContextId: CTX2, relationshipType: 'SameUnitAs' }] });
    expect(res.body).toEqual({ inserted: 0, skipped: 1 });
  });

  it('400 on a self-link', async () => {
    const res = await request(app).post('/api/ingest/context-relationships')
      .send({ systemId: 2, records: [{ contextId: CTX, relatedContextId: CTX, relationshipType: 'SameUnitAs' }] });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
