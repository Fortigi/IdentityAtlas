// Unit tests for the column-discovery endpoints on routes/matrix.js:
//   GET /api/matrix/columns        — schema + first page of distinct values
//   GET /api/matrix/column-values  — substring search across ALL values
//
// Both are the value-discovery surface behind the matrix wizard's "+ Attribute"
// picker. #928: the preloaded page is capped, so it must be flagged `truncated`
// and every value must stay reachable through the search endpoint.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const columnCache = {
  getPrincipalColumns: vi.fn(),
  getResourceColumns: vi.fn(),
  getPrincipalColumnValuesMeta: vi.fn(),
  getResourceColumnValuesMeta: vi.fn(),
  searchColumnValues: vi.fn(),
};
vi.mock('../db/columnCache.js', () => ({
  ...columnCache,
  getPrincipalColumns: (...a) => columnCache.getPrincipalColumns(...a),
  getResourceColumns: (...a) => columnCache.getResourceColumns(...a),
  getPrincipalColumnValuesMeta: (...a) => columnCache.getPrincipalColumnValuesMeta(...a),
  getResourceColumnValuesMeta: (...a) => columnCache.getResourceColumnValuesMeta(...a),
  searchColumnValues: (...a) => columnCache.searchColumnValues(...a),
  VALUE_SEARCH_LIMIT: 50,
}));

const identityCache = {
  getIdentityColumns: vi.fn(),
  getIdentityColumnValuesMeta: vi.fn(),
};
vi.mock('./matrix/shared.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getIdentityColumns: (...a) => identityCache.getIdentityColumns(...a),
  getIdentityColumnValuesMeta: (...a) => identityCache.getIdentityColumnValuesMeta(...a),
}));

const { default: router } = await import('./matrix.js');
const app = mountRouter(router);

beforeEach(() => {
  for (const fn of [...Object.values(columnCache), ...Object.values(identityCache)]) fn.mockReset();
  columnCache.getResourceColumns.mockResolvedValue([
    { name: 'description', rawName: 'description', type: 'text' },
    { name: 'notes',       rawName: 'notes',       type: 'text' },
  ]);
  columnCache.getResourceColumnValuesMeta.mockResolvedValue({
    values:    { description: ['a', 'b'], 'ext.costCenter': ['EU-1'] },
    truncated: { description: true },
  });
});

describe('GET /matrix/columns', () => {
  it('marks a capped column truncated and an uncapped one not (#928)', async () => {
    const res = await request(app).get('/api/matrix/columns?entity=Resource');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.map(c => [c.column, c]));
    expect(byName.description).toEqual({ column: 'description', type: 'text', values: ['a', 'b'], truncated: true });
    expect(byName.notes).toEqual({ column: 'notes', type: 'text', values: [], truncated: false });
    // ext.* keys are appended after the real columns, with the same flag.
    expect(byName['ext.costCenter']).toEqual({ column: 'ext.costCenter', type: 'text', values: ['EU-1'], truncated: false });
  });

  it('skips value discovery entirely on the schema-only fast path', async () => {
    const res = await request(app).get('/api/matrix/columns?entity=Resource&schema=true');
    expect(res.status).toBe(200);
    expect(res.body.map(c => c.column)).toEqual(['description', 'notes']);
    expect(columnCache.getResourceColumnValuesMeta).not.toHaveBeenCalled();
  });

  it('rejects an unknown entity', async () => {
    expect((await request(app).get('/api/matrix/columns?entity=Nope')).status).toBe(400);
  });
});

describe('GET /matrix/column-values (#928)', () => {
  it('searches the requested column and returns the matches', async () => {
    columnCache.searchColumnValues.mockResolvedValue(['Zzz — the missing description']);

    const res = await request(app)
      .get('/api/matrix/column-values?entity=Resource&column=description&q=Zzz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      column: 'description',
      values: ['Zzz — the missing description'],
      truncated: false,
    });
    const [table, column, q, allowed] = columnCache.searchColumnValues.mock.calls[0];
    expect(table).toBe('Resources');
    expect(column).toBe('description');
    expect(q).toBe('Zzz');
    expect(allowed.has('description')).toBe(true);
  });

  it('routes an Identity search at the Identities table', async () => {
    identityCache.getIdentityColumns.mockResolvedValue([{ name: 'department', rawName: 'department', type: 'text' }]);
    identityCache.getIdentityColumnValuesMeta.mockResolvedValue({ values: { department: ['Sales'] }, truncated: {} });
    columnCache.searchColumnValues.mockResolvedValue(['Sales']);

    const res = await request(app)
      .get('/api/matrix/column-values?entity=Identity&column=department&q=sal');

    expect(res.status).toBe(200);
    expect(columnCache.searchColumnValues.mock.calls[0][0]).toBe('Identities');
  });

  it('flags a search that filled the result limit as truncated', async () => {
    columnCache.searchColumnValues.mockResolvedValue(Array.from({ length: 50 }, (_, i) => `v${i}`));
    const res = await request(app)
      .get('/api/matrix/column-values?entity=Resource&column=description&q=v');
    expect(res.body.truncated).toBe(true);
  });

  it('returns the preloaded page when no search term is given', async () => {
    const res = await request(app)
      .get('/api/matrix/column-values?entity=Resource&column=description');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ column: 'description', values: ['a', 'b'], truncated: true });
    expect(columnCache.searchColumnValues).not.toHaveBeenCalled();
  });

  it('returns an empty list for a real column that has no values at all', async () => {
    const res = await request(app)
      .get('/api/matrix/column-values?entity=Resource&column=notes&q=x');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ column: 'notes', values: [], truncated: false });
    expect(columnCache.searchColumnValues).not.toHaveBeenCalled();
  });

  it('rejects a column that is not a discovered column — no SQL is emitted', async () => {
    const res = await request(app)
      .get('/api/matrix/column-values?entity=Resource&column=secret%22%3B%20DROP&q=x');
    expect(res.status).toBe(400);
    expect(columnCache.searchColumnValues).not.toHaveBeenCalled();
  });

  it('rejects an unknown entity and a missing column', async () => {
    expect((await request(app).get('/api/matrix/column-values?entity=Nope&column=description')).status).toBe(400);
    expect((await request(app).get('/api/matrix/column-values?entity=Resource')).status).toBe(400);
  });

  it('returns 500 when discovery blows up', async () => {
    columnCache.getResourceColumnValuesMeta.mockRejectedValue(new Error('boom'));
    const res = await request(app)
      .get('/api/matrix/column-values?entity=Resource&column=description&q=x');
    expect(res.status).toBe(500);
  });
});
