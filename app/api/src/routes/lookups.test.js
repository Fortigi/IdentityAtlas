// Unit tests for the lookup routes.
//
// The seam test at the bottom is the point of the registry: a source the engine
// has never heard of is listed and served without a single edit to this route.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { registerLookup } from '../lookups/registry.js';
import lookupsRouter from './lookups.js';

const app = mountRouter(lookupsRouter);

const OPTION = { value: 'a1', label: 'Alpha', hint: '3 members' };

let unregister;
let search;
let resolve;

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  search = vi.fn().mockResolvedValue([OPTION]);
  resolve = vi.fn().mockResolvedValue([OPTION]);
  unregister = registerLookup({
    name: 'test-things', displayName: 'Test Things', search, resolve,
  });
});
afterEach(() => unregister());

describe('GET /api/lookups', () => {
  it('lists the registered sources by name and display name, and nothing executable', async () => {
    const res = await request(app).get('/api/lookups').expect(200);
    const entry = res.body.data.find(s => s.name === 'test-things');
    expect(entry).toEqual({ name: 'test-things', displayName: 'Test Things' });
    expect(res.body.total).toBe(res.body.data.length);
  });
});

describe('GET /api/lookups/:source', () => {
  it('returns the source\'s options and echoes the term it searched', async () => {
    const res = await request(app).get('/api/lookups/test-things?q=alp').expect(200);
    expect(res.body).toEqual({ source: 'test-things', q: 'alp', data: [OPTION], total: 1 });
    expect(search).toHaveBeenCalledWith({ q: 'alp', limit: 20 });
  });

  it('echoes the term so a late reply for an earlier keystroke can be discarded', async () => {
    // The echo is the client's only way to tell "these are the results for what
    // I am showing" from "these are the results for what I typed two keystrokes
    // ago". Without it the list flickers backwards under fast typing.
    const res = await request(app).get('/api/lookups/test-things?q=second').expect(200);
    expect(res.body.q).toBe('second');
  });

  it('searches with an empty term when none is given, rather than refusing', async () => {
    // Focusing an empty box should offer something.
    await request(app).get('/api/lookups/test-things').expect(200);
    expect(search).toHaveBeenCalledWith({ q: '', limit: 20 });
  });

  it('trims the term and caps its length', async () => {
    await request(app).get(`/api/lookups/test-things?q=${encodeURIComponent(`  ${'x'.repeat(500)}  `)}`).expect(200);
    expect(search.mock.calls[0][0].q).toHaveLength(200);
  });

  it.each([
    ['above the ceiling', '9999', 50],
    ['at zero', '0', 20],
    ['negative', '-5', 20],
    ['not a number', 'lots', 20],
    ['a real request', '7', 7],
  ])('clamps a limit that is %s', async (_label, given, expected) => {
    await request(app).get(`/api/lookups/test-things?limit=${given}`).expect(200);
    expect(search.mock.calls[0][0].limit).toBe(expected);
  });

  it('resolves ids instead of searching when ids are given', async () => {
    const res = await request(app).get('/api/lookups/test-things?ids=a1,b2').expect(200);
    expect(resolve).toHaveBeenCalledWith({ ids: ['a1', 'b2'] });
    expect(search).not.toHaveBeenCalled();
    expect(res.body.data).toEqual([OPTION]);
  });

  it('drops blank ids and caps how many one request may resolve', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    await request(app).get(`/api/lookups/test-things?ids=${['', ...many, ''].join(',')}`).expect(200);
    expect(resolve.mock.calls[0][0].ids).toHaveLength(200);
    expect(resolve.mock.calls[0][0].ids[0]).toBe('id-0');
  });

  it('answers empty for a source that cannot resolve ids, rather than failing', async () => {
    const only = registerLookup({ name: 'search-only', displayName: 'Search Only', search });
    try {
      const res = await request(app).get('/api/lookups/search-only?ids=a1').expect(200);
      expect(res.body.data).toEqual([]);
      expect(search).not.toHaveBeenCalled();
    } finally { only(); }
  });

  it('404s on a source it does not have', async () => {
    const res = await request(app).get('/api/lookups/not-a-source?q=x').expect(404);
    expect(res.body).toEqual({ error: 'Lookup source not found' });
  });

  it('404s rather than dispatching on an inherited Object.prototype key', async () => {
    // `:source` comes straight off the URL.
    await request(app).get('/api/lookups/constructor').expect(404);
    await request(app).get('/api/lookups/toString').expect(404);
  });

  it('returns a generic 500 when a source throws, logging only the registry name', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    search.mockRejectedValue(new Error('relation "Secrets" does not exist'));
    try {
      const res = await request(app).get('/api/lookups/test-things?q=boom').expect(500);
      expect(res.body).toEqual({ error: 'Failed to run lookup' });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('/lookups/test-things'), 'relation "Secrets" does not exist');
      // The detail stays server-side.
      expect(JSON.stringify(res.body)).not.toContain('Secrets');
    } finally { spy.mockRestore(); }
  });
});

describe('the seam — adding a lookup costs only a source', () => {
  it('lists and serves a source this route has never heard of', async () => {
    const off = registerLookup({
      name: 'dummy-seam-lookup',
      displayName: 'Dummy Seam Lookup',
      search: async ({ q }) => [{ value: 'v1', label: `match for ${q}` }],
    });
    try {
      const list = await request(app).get('/api/lookups').expect(200);
      expect(list.body.data.map(s => s.name)).toContain('dummy-seam-lookup');

      const res = await request(app).get('/api/lookups/dummy-seam-lookup?q=widget').expect(200);
      expect(res.body.data).toEqual([{ value: 'v1', label: 'match for widget' }]);
    } finally { off(); }
  });
});
