// Interviews API — the interview record, ownership, mentions, resolutions and deletion.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter, mountRouterAs } from '../../test-utils/routeTestKit.js';
import { scriptedDb } from '../../test-utils/scriptedDb.js';

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: () => auth.enabled,
  getJwksClient: () => null, getTenantId: () => '', getClientId: () => '', getRequiredRoles: () => null, getRolePermissions: () => ({}),
}));
vi.mock('../db/connection.js');

import { query } from '../db/connection.js';
import router from './interviews.js';

const IV = '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab';
const MENTION = '44444444-4444-4444-8444-444444444444';
const PETER = 'a1b2c3d4-0000-4000-8000-000000000002';
const alice = { oid: 'alice', preferred_username: 'alice@example.org', permissions: new Set(['*']) };
const bob = { oid: 'bob', permissions: new Set(['*']) };
const as = (user) => request(mountRouterAs(router, () => user));
const interviewRow = (over = {}) => ({ id: IV, ownerKey: 'oid:alice', storagePolicy: 'local-only', expired: false, interviewType: 'role-mining', ...over });
const loadRule = (row) => [/AS "expired" FROM "Interviews" WHERE "id" = \$1/, row ? [row] : []];
const CANONICAL = /"(Resources|ResourceAssignments|ResourceRelationships|Principals|Identities|IdentityMembers|Contexts|ContextMembers)"/;

beforeEach(() => {
  query.mockReset();
  auth.enabled = false;
  process.env.FEATURE_INTERVIEWS = 'true';
});

describe('POST /v1/interviews', () => {
  const body = { interviewType: 'role-mining', noticeConfirmed: true, noticeVersion: 'nl-2026-10', retentionDays: 30 };

  it('creates the interview for the caller and audits it with no spoken content', async () => {
    const db = scriptedDb(query, [
      [/INSERT INTO "Interviews"/, (_s, p) => [{ id: p[0], ownerKey: p[3], storagePolicy: p[7] }]],
      [/INSERT INTO "InterviewEvents"/, []],
    ]);
    const res = await as(alice).post('/api/v1/interviews').send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ownerKey: 'oid:alice', storagePolicy: 'local-only' });
    const insert = db.calls.find(c => c.sql.includes('INSERT INTO "Interviews"'));
    expect(insert.params.slice(1)).toEqual(['role-mining', null, 'oid:alice', 'alice@example.org', null, null, 'local-only', 'nl-2026-10', 30]);
    const event = db.calls.find(c => c.sql.includes('"InterviewEvents"'));
    expect(event.params.slice(1)).toEqual(['created', 'oid:alice', { interviewType: 'role-mining', storagePolicy: 'local-only', retentionDays: 30, noticeVersion: 'nl-2026-10' }]);
  });

  it('refuses to create one before the notice is confirmed, and writes nothing', async () => {
    const res = await as(alice).post('/api/v1/interviews').send({ ...body, noticeConfirmed: false });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a signed-in caller without an object id instead of filing it under a shared owner', async () => {
    const res = await as({ permissions: new Set(['*']) }).post('/api/v1/interviews').send(body);
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('files an interview made while auth is off under the shared anonymous owner', async () => {
    const db = scriptedDb(query, [[/INSERT INTO "Interviews"/, (_s, p) => [{ id: p[0], ownerKey: p[3] }]], [/InterviewEvents/, []]]);
    await request(mountRouter(router)).post('/api/v1/interviews').send(body);
    expect(db.calls[0].params[3]).toBe('anonymous');
  });
});

describe('ownership and retention', () => {
  it('lists only the caller\'s own, unexpired interviews', async () => {
    const db = scriptedDb(query, [[/FROM "Interviews" WHERE "ownerKey" = \$1/, []]]);
    await as(bob).get('/api/v1/interviews');
    expect(db.calls[0].params).toEqual(['oid:bob']);
    expect(db.calls[0].sql).toContain('"retainUntil" > now()');
  });

  it('answers 404 — not 403 — for someone else\'s interview, and reads nothing of it', async () => {
    const db = scriptedDb(query, [loadRule(interviewRow())]);
    const res = await as(bob).get(`/api/v1/interviews/${IV}`);
    expect(res.status).toBe(404);
    expect(db.calls).toHaveLength(1);
  });

  it('answers a generic 500 when the interview cannot be loaded', async () => {
    query.mockRejectedValue(new Error('connection refused'));
    const res = await as(alice).get(`/api/v1/interviews/${IV}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Request failed' });
  });

  it('answers 404 for an id that is not a UUID without querying', async () => {
    expect((await as(alice).get('/api/v1/interviews/not-an-id')).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('treats an interview past its retention date as gone for reads and writes', async () => {
    scriptedDb(query, [loadRule(interviewRow({ expired: true }))]);
    expect((await as(alice).get(`/api/v1/interviews/${IV}`)).status).toBe(404);
    expect((await as(alice).post(`/api/v1/interviews/${IV}/mentions`).send({ mentions: [] })).status).toBe(404);
  });

  it('shows the owner everything recorded, with each proposal\'s review state and no owner key', async () => {
    scriptedDb(query, [
      loadRule(interviewRow()),
      [/FROM "InterviewMentions" m/, [{ id: MENTION, literalText: 'Peter', state: 'unresolved' }]],
      [/FROM "InterviewStatements" s WHERE/, []],
      [/FROM "InterviewProposals" p WHERE/, [{ id: 'p1', latestAction: 'approve' }, { id: 'p2', latestAction: null }]],
    ]);
    const res = await as(alice).get(`/api/v1/interviews/${IV}`);
    expect(res.status).toBe(200);
    expect(res.body.interview).not.toHaveProperty('ownerKey');
    expect(res.body.proposals).toEqual([{ id: 'p1', reviewState: 'approved' }, { id: 'p2', reviewState: 'proposed' }]);
  });
});

describe('DELETE /v1/interviews/:id', () => {
  it('deletes the interview, keeps a content-free tombstone, and touches no canonical table', async () => {
    const db = scriptedDb(query, [
      loadRule(interviewRow({ expired: true })),
      [/SELECT \(SELECT count/, [{ mentions: '3', statements: '2', proposals: '1' }]],
      [/DELETE FROM "Interviews"/, []],
      [/INSERT INTO "InterviewEvents"/, []],
    ]);
    const res = await as(alice).delete(`/api/v1/interviews/${IV}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, removed: { mentions: 3, statements: 2, proposals: 1 } });
    expect(db.writes()).toEqual(['DELETE FROM "Interviews"', 'INSERT INTO "InterviewEvents"']);
    expect(db.calls.at(-1).params).toEqual([IV, 'deleted', 'oid:alice', { mentions: 3, statements: 2, proposals: 1 }]);
    expect(db.calls.some(c => CANONICAL.test(c.sql))).toBe(false);
  });

  it('will not let another caller delete it', async () => {
    const db = scriptedDb(query, [loadRule(interviewRow())]);
    expect((await as(bob).delete(`/api/v1/interviews/${IV}`)).status).toBe(404);
    expect(db.writes()).toEqual([]);
  });
});

describe('mentions and their resolution', () => {
  const mention = { segmentId: 's1', literalText: 'Peter', startMs: 1000, endMs: 1400, spanStart: 30, spanEnd: 35, detector: 'lexicon@1' };

  it('records a batch of mentions with no resolution yet', async () => {
    const db = scriptedDb(query, [
      loadRule(interviewRow()),
      [/INSERT INTO "InterviewMentions"/, (_s, p) => [{ id: p[0], literalText: p[7] }]],
      [/INSERT INTO "InterviewEvents"/, []],
    ]);
    const res = await as(alice).post(`/api/v1/interviews/${IV}/mentions`).send({ mentions: [mention, { ...mention, literalText: 'William' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.map(m => [m.literalText, m.resolution])).toEqual([['Peter', null], ['William', null]]);
    expect(db.writes()).toEqual(['INSERT INTO "InterviewMentions"', 'INSERT INTO "InterviewMentions"', 'INSERT INTO "InterviewEvents"']);
  });

  const resolve = (body, state = 'unresolved', rules = []) => {
    const db = scriptedDb(query, [
      loadRule(interviewRow()),
      [/FROM "InterviewMentions" m WHERE m."id" = \$1 AND m."interviewId" = \$2/, state === 'missing' ? [] : [{ id: MENTION, state }]],
      ...rules,
      [/INSERT INTO "InterviewResolutions"/, (_s, p) => [{ id: 1, state: p[1], origin: p[2], entityId: p[4] }]],
      [/INSERT INTO "InterviewEvents"/, []],
    ]);
    return { db, res: as(alice).post(`/api/v1/interviews/${IV}/mentions/${MENTION}/resolutions`).send(body) };
  };

  it('lets the analyst confirm one of two Peters once the entity is checked to exist', async () => {
    const { db, res } = resolve({ state: 'confirmed', entityKind: 'identity', entityId: PETER, matchScore: 0.64, candidateCount: 2 }, 'unresolved',
      [[/SELECT 1 FROM "Identities" n0/, [{ '?column?': 1 }]]]);
    expect((await res).status).toBe(201);
    const insert = db.calls.find(c => c.sql.includes('INSERT INTO "InterviewResolutions"'));
    expect(insert.params).toEqual([MENTION, 'confirmed', 'analyst', 'identity', PETER, 0.64, 2, null, 'oid:alice']);
  });

  it('refuses a detector that tries to confirm, with 409 and no write', async () => {
    const { db, res } = resolve({ state: 'confirmed', origin: 'detector', entityKind: 'identity', entityId: PETER }, 'suggested');
    expect((await res).status).toBe(409);
    expect(db.writes()).toEqual([]);
  });

  it('refuses a link to an entity that does not exist', async () => {
    const { db, res } = resolve({ state: 'confirmed', entityKind: 'resource', entityId: PETER }, 'not_found', [[/SELECT 1 FROM "Resources" n0/, []]]);
    const r = await res;
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('No resource with that id exists');
    expect(db.writes()).toEqual([]);
  });

  it('records not_found without an entity lookup', async () => {
    const { db, res } = resolve({ state: 'not_found', origin: 'detector', candidateCount: 0 });
    expect((await res).status).toBe(201);
    expect(db.calls.some(c => /SELECT 1 FROM/.test(c.sql))).toBe(false);
  });

  it('answers 404 for a mention of another interview', async () => {
    const { res } = resolve({ state: 'deferred' }, 'missing');
    expect((await res).status).toBe(404);
  });

  it('refuses malformed bodies with 400', async () => {
    for (const body of [{ state: 'accepted' }, { state: 'confirmed', entityId: PETER }, { state: 'deferred', origin: 'llm' },
      { state: 'confirmed', entityKind: 'person', entityId: PETER }, { state: 'deferred', matchScore: 2 }, { state: 'deferred', candidateCount: -1 },
      { state: 'deferred', rationale: 'x'.repeat(1001) }]) {
      const { res } = resolve(body);
      expect((await res).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });
});
