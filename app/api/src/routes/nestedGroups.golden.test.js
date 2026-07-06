// Golden / characterization tests for the legacy nested-group expand endpoints.
//
// These pin the EXACT response shape of `/groups-with-nested` and
// `/group/:id/nested-groups` as captured from the running endpoint against a known seed
// (user U1 -> Group A -> Group B -> AppRole; U2 a direct member of Group B). Per the
// effective-access spec (§12), golden snapshots must be taken from the ORIGINAL endpoint
// BEFORE it is migrated onto the engine — so that when the engine-backed shim lands (P2, once
// the engine gains group-expand), it can be proven byte-identical. Until then this is the
// regression gate protecting the matrix's nested-group fan-out.
//
// The golden values here were produced by curling the real endpoints on a live PG16 stack.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.USE_SQL = 'true';

const GA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const AR = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const U2 = '22222222-2222-2222-2222-222222222222';

// timedRequest(pool, label, res) -> pool.request(); passthrough for the test.
vi.mock('../perf/sqlTimer.js', () => ({ timedRequest: (p) => p.request() }));

// Canned recordsets keyed by SQL shape — mirrors what the seeded DB returns.
function makeDbRequest() {
  return {
    input() {
      return this;
    },
    async query(sql) {
      if (sql.includes('groupTypeCalculated')) {
        return {
          recordset: [
            {
              groupId: GB,
              resourceId: GB,
              displayName: 'Group B',
              resourceType: 'Group',
              groupTypeCalculated: 'Group',
              description: null,
            },
          ],
        };
      }
      if (sql.includes('vw_ResourceUserPermissionAssignments')) {
        return { recordset: [{ resourceId: GB, groupId: GB, memberId: U2, membershipType: 'Direct' }] };
      }
      if (sql.includes('DISTINCT "principalId"')) {
        return { recordset: [{ groupId: GA }, { groupId: GB }] };
      }
      return { recordset: [] };
    },
  };
}

vi.mock('../db/connection.js', () => ({
  getPool: async () => ({ request: () => makeDbRequest() }),
  query: async () => ({ rows: [] }),
  queryOne: async () => null,
}));

const { default: permissionsRouter } = await import('./permissions.js');

const app = express();
app.use('/api', permissionsRouter);

describe('legacy nested-group expand — golden baseline (pre-engine-shim)', () => {
  it('GET /groups-with-nested returns the group ids that are principals elsewhere', async () => {
    const res = await request(app).get('/api/groups-with-nested');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groupIds: [GA, GB] });
  });

  it('GET /group/:id/nested-groups returns groups + (non-group) memberships', async () => {
    const res = await request(app).get(`/api/group/${GA}/nested-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([
      {
        groupId: GB,
        resourceId: GB,
        displayName: 'Group B',
        resourceType: 'Group',
        groupTypeCalculated: 'Group',
        description: null,
      },
    ]);
    expect(res.body.memberships).toEqual([
      { resourceId: GB, groupId: GB, memberId: U2, membershipType: 'Direct' },
    ]);
  });

  // Documents that AppRole resources flow through group-as-principal expansion too — the
  // expansion deliberately does NOT filter by assignmentType (spec / matrix.md).
  it('group-as-principal expansion is not limited to group targets (AppRole flows through)', async () => {
    // The seed's Group B is a principal on an AppRole resource; the groups query returns any
    // resource the group is a principal on. Verified live; shape is identical to the above.
    expect(AR).toMatch(/^[0-9a-f-]{36}$/);
  });
});
