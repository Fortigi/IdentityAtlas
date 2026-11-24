import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
const gate = vi.hoisted(() => ({ allow: true, asked: [] }));
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (...perms) => {
    gate.asked.push(perms);
    return (_req, res, next) => (gate.allow ? next() : res.status(403).json({ error: 'Forbidden' }));
  },
}));

const { default: router } = await import('./businessRoleCompositionReview.js');
const caller = vi.hoisted(() => ({ user: { email: 'ann@example.test', name: 'Ann Analyst' } }));
const app = mountRouterAs(router, () => caller.user);

const ROLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const url = `/api/access-package/${ROLE}/composition-reviews`;
const FIN = { id: 'g1', displayName: 'SG-Finance' };

function roleExists() {
  queryOne.mockImplementation(async (sql) => (/"resourceType" = 'BusinessRole'/.test(sql) ? { id: ROLE } : null));
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  gate.allow = true;
  caller.user = { email: 'ann@example.test', name: 'Ann Analyst' };
});

it('gates writing on the certification-decision permission', () => {
  expect(gate.asked).toContainEqual(['data.write.certifications']);
});

describe('reading', () => {
  it('400 on a malformed id, 404 for something that is not a business role', async () => {
    expect((await request(app).get('/api/access-package/nope/composition-reviews')).status).toBe(400);
    queryOne.mockResolvedValue(null);
    expect((await request(app).get(url)).status).toBe(404);
  });

  it('gives the reviews and the latest sign-off with what changed since', async () => {
    roleExists();
    query.mockImplementation(async (sql) => ({
      rows: /FROM "BusinessRoleCompositionReviews"/.test(sql)
        ? [{ id: 'r1', signedOff: true, notes: '', reviewedBy: 'bob@example.test', composition: [] }]
        : [FIN],
    }));
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body.latestSignOff).toMatchObject({ id: 'r1', reviewedBy: 'bob@example.test', changesSince: { added: ['SG-Finance'], removed: [] } });
  });

  it('500 when the reviews cannot be read', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).get(url)).status).toBe(500);
  });
});

describe('saving', () => {
  it('stores the notes and sign-off under the signed-in user, not one from the body', async () => {
    roleExists();
    query.mockImplementation(async (sql) => (/INSERT INTO/.test(sql) ? { rows: [{ id: 'new', signedOff: true }] } : { rows: [FIN] }));
    const res = await request(app).post(url).send({ notes: 'All four groups belong here.', signedOff: true, reviewedBy: 'mallory' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'new', signedOff: true });
    const insert = query.mock.calls.find(([sql]) => /INSERT INTO/.test(sql))[1];
    expect(insert).toEqual([ROLE, 'All four groups belong here.', true, 'ann@example.test', 'Ann Analyst', JSON.stringify([FIN])]);
  });

  it('400 for a review that says nothing, before touching the database', async () => {
    roleExists();
    const res = await request(app).post(url).send({ notes: ' ', signedOff: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Write a note or sign off');
    expect(query).not.toHaveBeenCalled();
  });

  it('403 without the permission, before the role is looked up', async () => {
    gate.allow = false;
    expect((await request(app).post(url).send({ signedOff: true })).status).toBe(403);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('500 when the review cannot be saved', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).post(url).send({ signedOff: true })).status).toBe(500);
  });
});
