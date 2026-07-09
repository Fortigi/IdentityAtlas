// Data-path unit tests for the recentChanges split.
//
// recentChanges.routes.test.js only exercises id-validation + the empty-history
// path, so the event-building loops (and the toEvent / lookup* / counterparty
// helpers the split moved into recentChanges/shared.js) went uncovered. These
// stage real _history rows + label lookups so each recent-changes handler and a
// couple of timeline handlers build events end-to-end. DB mocked; no network.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/connection.js', () => ({
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
}));

const { default: router } = await import('./recentChanges.js');
const app = mountRouter(router);

const ID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const ev = (tableName, operation, rowData, prevData = {}) =>
  ({ tableName, operation, changedAt: '2026-01-01T00:00:00Z', rowData, prevData });

// query() serves the main _history pull and (for governance timelines) the
// CertificationDecisions review-instance pull; queryOne() serves the label
// lookups. Route both by the table they touch.
function stage(historyRows, reviewRows = []) {
  query.mockImplementation((sql) =>
    /_history/.test(sql) ? Promise.resolve({ rows: historyRows })
      : /CertificationDecisions/.test(sql) ? Promise.resolve({ rows: reviewRows })
        : Promise.resolve({ rows: [] }));
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockImplementation((sql) => {
    if (/"Principals"/.test(sql)) return Promise.resolve({ displayName: 'Alice' });
    if (/"Resources"/.test(sql)) return Promise.resolve({ displayName: 'ResX', resourceType: 'BusinessRole' });
    if (/"Identities"/.test(sql)) return Promise.resolve({ displayName: 'IdY' });
    return Promise.resolve(null);
  });
});

describe('GET /user/:id/recent-changes — builds events from history', () => {
  it('classifies assignment add/remove, identity link and manager change', async () => {
    stage([
      ev('ResourceAssignments', 'I', { resourceId: OTHER, assignmentType: 'Direct' }),
      ev('ResourceAssignments', 'D', { resourceId: OTHER, assignmentType: 'Direct' }),
      ev('IdentityMembers', 'I', { identityId: OTHER }),
      ev('Principals', 'U', { managerId: OTHER }, { managerId: null }),
    ]);
    const res = await request(app).get(`/api/user/${ID}/recent-changes`);
    expect(res.status).toBe(200);
    expect(res.body.addedCount).toBe(1);
    expect(res.body.removedCount).toBe(1);
    // added assignment + removed assignment + identity link + manager change
    expect(res.body.events).toHaveLength(4);
    expect(res.body.events.some(e => e.eventKind === 'manager')).toBe(true);
  });
});

describe('GET /resources/:id/recent-changes — assignment + containment', () => {
  it('handles both sides of a containment relationship', async () => {
    stage([
      ev('ResourceAssignments', 'I', { principalId: OTHER, assignmentType: 'Member' }),
      ev('ResourceRelationships', 'I', { childResourceId: ID, parentResourceId: OTHER, relationshipType: 'Contains' }),
      ev('ResourceRelationships', 'D', { childResourceId: OTHER, parentResourceId: ID }),
    ]);
    const res = await request(app).get(`/api/resources/${ID}/recent-changes`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.events.some(e => e.eventKind === 'relationship')).toBe(true);
  });
});

describe('GET /access-package/:id/recent-changes — governed events', () => {
  it('reports role grants and resource-role additions', async () => {
    stage([
      ev('ResourceAssignments', 'I', { principalId: OTHER }),
      ev('ResourceAssignments', 'D', { principalId: OTHER }),
      ev('ResourceRelationships', 'I', { childResourceId: OTHER, relationshipType: 'Contains' }),
    ]);
    const res = await request(app).get(`/api/access-package/${ID}/recent-changes`);
    expect(res.status).toBe(200);
    expect(res.body.addedCount).toBe(2);
    expect(res.body.removedCount).toBe(1);
  });
});

describe('GET /identities/:id/recent-changes — account link/unlink', () => {
  it('classifies linked and unlinked accounts', async () => {
    stage([
      ev('IdentityMembers', 'I', { principalId: OTHER }),
      ev('IdentityMembers', 'D', { principalId: OTHER, displayName: 'Bob' }),
    ]);
    const res = await request(app).get(`/api/identities/${ID}/recent-changes`);
    expect(res.status).toBe(200);
    expect(res.body.addedCount).toBe(1);
    expect(res.body.removedCount).toBe(1);
  });
});

describe('timeline endpoints — build via buildEntityTimeline + label resolution', () => {
  it('GET /user/:id/timeline returns events from history', async () => {
    stage([
      ev('ResourceAssignments', 'I', { principalId: ID, resourceId: OTHER, assignmentType: 'Direct' }),
      ev('IdentityMembers', 'I', { principalId: ID, identityId: OTHER }),
    ]);
    const res = await request(app).get(`/api/user/${ID}/timeline`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it('GET /access-package/:id/timeline folds in access-review instances', async () => {
    stage(
      [ev('ResourceAssignments', 'I', { resourceId: ID, principalId: OTHER })],
      [{ ii: 'r1', st: '2026-01-01T00:00:00Z', en: '2020-01-01T00:00:00Z', status: 'Completed' }],
    );
    const res = await request(app).get(`/api/access-package/${ID}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.events.some(e => e.eventKind === 'review')).toBe(true);
  });
});
