import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
const gate = vi.hoisted(() => ({ allow: true }));
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: () => (_req, res, next) => (gate.allow ? next() : res.status(403).json({ error: 'Forbidden' })),
}));

const { default: router } = await import('./businessRoleOwners.js');
const app = mountRouter(router);

const ROLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const url = `/api/access-package/${ROLE}/owners`;

// The role exists, and the holder lookup finds someone.
function roleExists() {
  queryOne.mockImplementation(async (sql) => {
    if (/"resourceType" = 'BusinessRole'/.test(sql)) return { id: ROLE };
    if (/FROM "Principals"/.test(sql)) return { id: P1, displayName: 'Ann' };
    return { total: 0 };
  });
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  gate.allow = true;
});

describe('reading', () => {
  it('400 on a malformed id', async () => {
    expect((await request(app).get('/api/access-package/nope/owners')).status).toBe(400);
  });

  it('404 when the id is not a business role', async () => {
    queryOne.mockResolvedValue(null);
    expect((await request(app).get(url)).status).toBe(404);
  });

  it('500 when the role lookup fails', async () => {
    queryOne.mockRejectedValue(new Error('down'));
    expect((await request(app).get(url)).status).toBe(500);
  });

  it('lists the owners', async () => {
    roleExists();
    query.mockResolvedValue({ rows: [{ id: OWNER, role: 'Accountable', displayName: 'Ann' }] });
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body[0].displayName).toBe('Ann');
  });

  it('500 when the owners cannot be read', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    expect((await request(app).get(url)).status).toBe(500);
  });

  it('returns a suggestion per open place', async () => {
    roleExists();
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get(`${url}/suggestions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ Accountable: null, Responsible: null });
  });

  it('500 when suggesting fails', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    expect((await request(app).get(`${url}/suggestions`)).status).toBe(500);
  });
});

describe('PUT owners', () => {
  it('403 without the write permission, before anything is read', async () => {
    gate.allow = false;
    expect((await request(app).put(url).send({ role: 'Accountable', principalId: P1 })).status).toBe(403);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('400 on an unknown role', async () => {
    roleExists();
    expect((await request(app).put(url).send({ role: 'Owner', principalId: P1 })).status).toBe(400);
  });

  it('404 when the holder does not exist', async () => {
    queryOne.mockImplementation(async (sql) => (/'BusinessRole'/.test(sql) ? { id: ROLE } : null));
    expect((await request(app).put(url).send({ role: 'Accountable', principalId: P1 })).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('writes the holder as an analyst choice and returns the name', async () => {
    roleExists();
    query.mockImplementation(async (sql, params) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [] };
      return { rows: [{ id: OWNER, role: params[2], principalId: params[1], addedBy: params[3] }] };
    });
    const res = await request(app).put(url).send({ role: 'Accountable', principalId: P1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: OWNER, role: 'Accountable', addedBy: 'analyst', displayName: 'Ann' });
  });

  it('500 when the write fails', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    expect((await request(app).put(url).send({ role: 'Responsible', principalId: P1 })).status).toBe(500);
  });
});

describe('DELETE owners', () => {
  it('403 without the write permission', async () => {
    gate.allow = false;
    expect((await request(app).delete(`${url}/${OWNER}`)).status).toBe(403);
  });

  it('400 on a malformed owner id', async () => {
    roleExists();
    expect((await request(app).delete(`${url}/nope`)).status).toBe(400);
  });

  it('404 when the owner is not on this role', async () => {
    roleExists();
    query.mockResolvedValue({ rowCount: 0 });
    expect((await request(app).delete(`${url}/${OWNER}`)).status).toBe(404);
  });

  it('204 when removed', async () => {
    roleExists();
    query.mockResolvedValue({ rowCount: 1 });
    expect((await request(app).delete(`${url}/${OWNER}`)).status).toBe(204);
    expect(query.mock.calls[0][1]).toEqual([OWNER, ROLE]);
  });

  it('500 when the delete fails', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    expect((await request(app).delete(`${url}/${OWNER}`)).status).toBe(500);
  });
});

describe('rejecting a suggestion', () => {
  const reject = (body) => request(app).post(`${url}/suggestions/reject`).send(body);

  it('403 without the write permission', async () => {
    gate.allow = false;
    expect((await reject({ role: 'Accountable', principalId: P1 })).status).toBe(403);
  });

  it('400 on a bad role or holder', async () => {
    roleExists();
    expect((await reject({ role: 'Owner', principalId: P1 })).status).toBe(400);
    expect((await reject({ role: 'Accountable', principalId: 'x' })).status).toBe(400);
  });

  it('only accepts an account, not a person', async () => {
    roleExists();
    expect((await reject({ role: 'Accountable', identityId: P1 })).status).toBe(400);
  });

  it('404 when the account does not exist', async () => {
    queryOne.mockImplementation(async (sql) => (/'BusinessRole'/.test(sql) ? { id: ROLE } : null));
    expect((await reject({ role: 'Responsible', principalId: P1 })).status).toBe(404);
  });

  it('remembers the rejection for this role', async () => {
    roleExists();
    query.mockResolvedValue({ rowCount: 1 });
    expect((await reject({ role: 'Responsible', principalId: P1 })).status).toBe(204);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO "BusinessRoleOwnerRejections"/);
    expect(params.slice(0, 3)).toEqual([ROLE, P1, 'Responsible']);
  });

  it('500 when it cannot be stored', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    expect((await reject({ role: 'Responsible', principalId: P1 })).status).toBe(500);
  });
});
