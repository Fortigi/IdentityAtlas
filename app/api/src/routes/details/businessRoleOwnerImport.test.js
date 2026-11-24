import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
const gate = vi.hoisted(() => ({ allow: true }));
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: () => (_req, res, next) => (gate.allow ? next() : res.status(403).json({ error: 'Forbidden' })),
}));
const lib = vi.hoisted(() => ({ planOwnerImport: vi.fn(), applyOwnerPlan: vi.fn() }));
vi.mock('../../lib/businessRoleOwnerImport.js', () => lib);

const { default: router } = await import('./businessRoleOwnerImport.js');
const app = mountRouter(router);

const CSV = Buffer.from('Business role;Accountable\nFinance;ann@example.test\n');
const post = (path, file = CSV, name = 'owners.csv') => request(app)
  .post(`/api/business-roles/owners/import/${path}`).attach('file', file, name);
const PLAN = { rows: [], summary: { roles: 1, toWrite: 1, unchanged: 0, kept: 0, problems: 0 }, nearMatches: [] };

beforeEach(() => {
  gate.allow = true;
  lib.planOwnerImport.mockReset().mockResolvedValue(PLAN);
  lib.applyOwnerPlan.mockReset().mockResolvedValue({ written: 1, kept: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each(['preview', 'apply'])('POST import/%s', (path) => {
  it('403 without the write permission', async () => {
    gate.allow = false;
    expect((await post(path)).status).toBe(403);
    expect(lib.planOwnerImport).not.toHaveBeenCalled();
  });

  it('400 without a file', async () => {
    const res = await request(app).post(`/api/business-roles/owners/import/${path}`);
    expect(res.status).toBe(400);
  });

  it('400 on a file type it cannot read', async () => {
    expect((await post(path, Buffer.from('x'), 'owners.pdf')).status).toBe(400);
  });

  it('reads the file into columns and rows', async () => {
    expect((await post(path)).status).toBe(200);
    expect(lib.planOwnerImport.mock.calls[0][1]).toMatchObject({
      columns: ['Business role', 'Accountable'],
      rows: [{ 'Business role': 'Finance', Accountable: 'ann@example.test' }],
    });
  });

  it('500 with a generic message when the plan fails', async () => {
    lib.planOwnerImport.mockRejectedValue(new Error('secret detail'));
    const res = await post(path);
    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/secret/);
  });
});

describe('the difference between preview and apply', () => {
  it('preview writes nothing', async () => {
    const res = await post('preview');
    expect(res.body).toEqual(PLAN);
    expect(lib.applyOwnerPlan).not.toHaveBeenCalled();
  });

  it('apply writes the plan and reports the result', async () => {
    const res = await post('apply');
    expect(lib.applyOwnerPlan).toHaveBeenCalledWith(PLAN);
    expect(res.body).toEqual({ written: 1, kept: 0, summary: PLAN.summary });
  });
});
