import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));

import { query, queryOne } from '../../db/connection.js';
import router from './layout.js';
import { parseLayout, LAYOUT_KEY, MAX_CARDS, MAX_ID_LENGTH, MAX_COORD } from '../model/layout.js';

const app = mountRouterAs(router, () => ({ preferred_username: 'analyst@contoso.example' }));
const URL = '/api/org-truth/canvas-layout';
const AT = '2026-10-09T10:00:00.000Z';

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue(undefined); // feature flag: no override
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const stored = (value) => ({ rows: [{ configValue: JSON.stringify(value), updatedAt: AT }] });

describe('gates', () => {
  it.each([
    ['get', 'data.read'],
    ['put', 'data.write.contexts'],
  ])('%s needs %s', async (method, perm) => {
    const r = await request(app)[method](URL).set('x-deny', perm).send({ positions: {} });
    expect(r.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('a reader may read but not save', async () => {
    query.mockResolvedValue({ rows: [] });
    expect((await request(app).get(URL).set('x-deny', 'data.write.contexts')).status).toBe(200);
    expect((await request(app).put(URL).set('x-deny', 'data.write.contexts').send({ positions: {} })).status).toBe(403);
  });

  it('answers 404 while the feature is off', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get(URL)).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /org-truth/canvas-layout', () => {
  it('reads the WorkerConfig key and returns the positions with who saved them', async () => {
    query.mockResolvedValue(stored({ positions: { 'e:Customer': { x: 40, y: 80 } }, updatedBy: 'someone@contoso.example' }));
    const r = await request(app).get(URL);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ positions: { 'e:Customer': { x: 40, y: 80 } }, updatedAt: AT, updatedBy: 'someone@contoso.example' });
    expect(query.mock.calls[0][1]).toEqual([LAYOUT_KEY]);
  });

  it('returns an empty layout when nothing is stored', async () => {
    query.mockResolvedValue({ rows: [] });
    expect((await request(app).get(URL)).body).toEqual({ positions: {}, updatedAt: null, updatedBy: null });
  });

  it.each([
    ['not JSON', '{oops'],
    ['JSON without positions', JSON.stringify({ updatedBy: 'x' })],
    ['a position that is not a number', JSON.stringify({ positions: { 'e:A': { x: 'left', y: 0 } } })],
  ])('reads a stored value that is %s as no layout', async (_what, configValue) => {
    query.mockResolvedValue({ rows: [{ configValue, updatedAt: AT }] });
    expect((await request(app).get(URL)).body).toEqual({ positions: {}, updatedAt: null, updatedBy: null });
  });

  it('answers 500 with a generic message on a database error', async () => {
    query.mockRejectedValue(new Error('connection refused'));
    const r = await request(app).get(URL);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to read the canvas layout.' });
  });
});

describe('PUT /org-truth/canvas-layout', () => {
  it('stores the rounded positions under the layout key with the caller and returns them', async () => {
    query.mockImplementation(async (_sql, params) => ({ rows: [{ configValue: params[1], updatedAt: AT }] }));
    const r = await request(app).put(URL).send({ positions: { 'e:Customer': { x: 40.4, y: -80.6 }, 's:Principal': { x: 0, y: 0 } } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      positions: { 'e:Customer': { x: 40, y: -81 }, 's:Principal': { x: 0, y: 0 } },
      updatedAt: AT, updatedBy: 'analyst@contoso.example',
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \("configKey"\) DO UPDATE/);
    expect(params[0]).toBe(LAYOUT_KEY);
    expect(JSON.parse(params[1])).toEqual({ positions: { 'e:Customer': { x: 40, y: -81 }, 's:Principal': { x: 0, y: 0 } }, updatedBy: 'analyst@contoso.example' });
  });

  it('resets with an empty positions object', async () => {
    query.mockImplementation(async (_sql, params) => ({ rows: [{ configValue: params[1], updatedAt: AT }] }));
    const r = await request(app).put(URL).send({ positions: {} });
    expect(r.status).toBe(200);
    expect(r.body.positions).toEqual({});
  });

  it('refuses a malformed body with 400 and every reason, without writing', async () => {
    const r = await request(app).put(URL).send({ positions: { 'e:A': { x: 1 }, 'e:B': { x: 1, y: 'z' } } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: 'The layout is not valid.',
      errors: [`Card "e:A" needs numeric x and y within ±${MAX_COORD}.`, `Card "e:B" needs numeric x and y within ±${MAX_COORD}.`],
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('parseLayout', () => {
  it.each([
    ['no body', undefined],
    ['positions as an array', { positions: [] }],
    ['positions null', { positions: null }],
  ])('needs a positions object (%s)', (_what, body) => {
    expect(parseLayout(body)).toEqual({ errors: ['The layout needs a "positions" object.'] });
  });

  it('accepts a coordinate exactly at the bound and refuses one just past it', () => {
    expect(parseLayout({ positions: { a: { x: MAX_COORD, y: -MAX_COORD } } })).toEqual({ value: { positions: { a: { x: MAX_COORD, y: -MAX_COORD } } } });
    expect(parseLayout({ positions: { a: { x: MAX_COORD + 1, y: 0 } } }).errors).toHaveLength(1);
    expect(parseLayout({ positions: { a: { x: 0, y: -MAX_COORD - 1 } } }).errors).toHaveLength(1);
  });

  it('refuses NaN and a position that is not an object', () => {
    expect(parseLayout({ positions: { a: { x: Number.NaN, y: 0 } } }).errors).toEqual([`Card "a" needs numeric x and y within ±${MAX_COORD}.`]);
    expect(parseLayout({ positions: { a: [1, 2] } }).errors).toHaveLength(1);
    expect(parseLayout({ positions: { a: null } }).errors).toHaveLength(1);
  });

  it('bounds the id length: the maximum passes, one more and the empty id fail', () => {
    const ok = 'e'.repeat(MAX_ID_LENGTH);
    expect(parseLayout({ positions: { [ok]: { x: 1, y: 2 } } }).value.positions[ok]).toEqual({ x: 1, y: 2 });
    expect(parseLayout({ positions: { [`${ok}e`]: { x: 1, y: 2 } } }).errors[0]).toMatch(/must be 1 to 300 characters/);
    expect(parseLayout({ positions: { '': { x: 1, y: 2 } } }).errors[0]).toMatch(/must be 1 to 300 characters/);
  });

  it('holds at most MAX_CARDS cards', () => {
    const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`e:T${i}`, { x: i, y: i }]));
    expect(Object.keys(parseLayout({ positions: many(MAX_CARDS) }).value.positions)).toHaveLength(MAX_CARDS);
    expect(parseLayout({ positions: many(MAX_CARDS + 1) })).toEqual({ errors: [`The layout holds at most ${MAX_CARDS} cards.`] });
  });
});
