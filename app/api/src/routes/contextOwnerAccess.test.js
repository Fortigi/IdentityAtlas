// The relative-permission grid's admin route: shape, validation, and that what
// is saved is the normalized grid. The policy model itself is real
// (auth/relativePermissions.js); only its storage is stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({ policy: null, fail: false }));
vi.mock('../auth/contextOwnerSetting.js', () => ({
  getRelativePolicy: vi.fn(async () => state.policy),
  setRelativePolicy: vi.fn(async (p) => { if (state.fail) throw new Error('db down'); state.policy = p; return p; }),
}));

const { setRelativePolicy } = await import('../auth/contextOwnerSetting.js');
const { legacyPolicy, relativeSubjects } = await import('../auth/relativePermissions.js');
const { default: router } = await import('./contextOwnerAccess.js');

const app = express();
app.use(express.json());
app.use('/api', router);

const URL = '/api/admin/context-owner-access';
const put = (body) => request(app).put(URL).send(body);

beforeEach(() => {
  Object.assign(state, { policy: legacyPolicy(), fail: false });
  vi.clearAllMocks();
});

describe('GET /api/admin/context-owner-access', () => {
  it('returns the grid rows and the policy in force', async () => {
    state.policy = legacyPolicy({ access: true });
    const { body } = await request(app).get(URL).expect(200);
    expect(body.subjects).toEqual(relativeSubjects());
    expect(body.subjects.map(s => s.subject)).toContain('BusinessRole');
    expect(body.policy.OrganizationalUnit.Responsible).toEqual({ view: true, subUnits: true, mcp: false });
  });
});

describe('PUT /api/admin/context-owner-access', () => {
  it('saves the grid normalized: what is left out is off, mcp without view is dropped', async () => {
    const res = await put({ policy: {
      OrganizationalUnit: { Accountable: { view: true, subUnits: true, mcp: true } },
      LogicalApplication: { Responsible: { mcp: true } },
      BusinessRole: { Responsible: { review: true } },
    } }).expect(200);
    const saved = setRelativePolicy.mock.calls[0][0];
    expect(saved.OrganizationalUnit).toEqual({
      Accountable: { view: true, subUnits: true, mcp: true },
      Responsible: { view: false, subUnits: false, mcp: false },
    });
    expect(saved.LogicalApplication.Responsible).toEqual({ view: false, subUnits: false, mcp: false });
    // review stands on its own — it does not need view
    expect(saved.BusinessRole.Responsible).toEqual({ view: false, review: true });
    expect(res.body.policy).toEqual(saved);
  });

  it.each([
    [{}, 'policy must be an object'],
    [{ policy: [] }, 'policy must be an object'],
    [{ policy: { Tag: {} } }, 'unknown subject Tag'],
    [{ policy: { OrganizationalUnit: { Owner: {} } } }, 'unknown role Owner for OrganizationalUnit'],
    [{ policy: { OrganizationalUnit: { Accountable: { review: true } } } }, 'unknown capability review for OrganizationalUnit'],
    [{ policy: { BusinessRole: { Accountable: { mcp: true } } } }, 'unknown capability mcp for BusinessRole'],
    [{ policy: { OrganizationalUnit: { Accountable: { view: 'true' } } } }, 'OrganizationalUnit.Accountable.view must be a boolean'],
    [{ policy: { OrganizationalUnit: { Accountable: null } } }, 'OrganizationalUnit.Accountable must be an object'],
    [{ policy: { OrganizationalUnit: true } }, 'OrganizationalUnit must be an object'],
  ])('refuses %j with 400 and saves nothing', async (body, error) => {
    const res = await put(body).expect(400);
    expect(res.body.error).toBe(error);
    expect(setRelativePolicy).not.toHaveBeenCalled();
  });

  it('answers 500 when saving fails', async () => {
    state.fail = true;
    const res = await put({ policy: {} }).expect(500);
    expect(res.body.error).toBe('Failed to save the setting');
  });
});
