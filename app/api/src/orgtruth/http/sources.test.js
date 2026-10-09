import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mountRouter, mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
// A permission gate the test can close per request: header x-deny names the permission to refuse.
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));

import { query, queryOne } from '../../db/connection.js';
import router, { readUploadFields, MAX_UPLOAD_BYTES } from './sources.js';

const app = mountRouter(router);
const ID = '6f1c1c2e-8d3b-4a8e-9c1d-2b3c4d5e6f70';
const CSV = 'Code;Project;Owner\nP-1;Atlas;ann@contoso.com\nP-2;Beacon;bob@contoso.com\n';

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue(undefined);
});

describe('gates', () => {
  it.each([
    ['post', '/api/org-truth/sources', 'data.write.contexts'],
    ['get', '/api/org-truth/sources', 'data.read'],
    ['get', `/api/org-truth/sources/${ID}`, 'data.read'],
    ['get', `/api/org-truth/sources/${ID}/download`, 'data.read'],
    ['get', `/api/org-truth/sources/${ID}/columns`, 'data.read'],
  ])('%s %s needs %s', async (method, path, perm) => {
    const r = await request(app)[method](path).set('x-deny', perm);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ denied: perm });
  });

  it('answers 404 while the feature is off', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get('/api/org-truth/sources')).status).toBe(404);
  });
});

describe('POST /org-truth/sources', () => {
  it('stores the upload and answers with the row, the row count and the column profile', async () => {
    queryOne.mockImplementation(async (sql) => (sql.includes('INSERT INTO "OrgSources"') ? { id: ID, displayName: 'Projects Q3' } : undefined));
    const signedIn = mountRouterAs(router, () => ({ preferred_username: 'ann@contoso.com' }));
    const r = await request(signedIn).post('/api/org-truth/sources')
      .field('displayName', ' Projects Q3 ').field('observedAt', '2026-09-30')
      .attach('file', Buffer.from(CSV), { filename: 'projects.csv', contentType: 'text/csv' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: ID, displayName: 'Projects Q3', rowCount: 2, headerRow: 1 });
    expect(r.body.columns.map(c => [c.name, c.shape])).toEqual([['Code', 'text'], ['Project', 'text'], ['Owner', 'email']]);
    const params = queryOne.mock.calls.find(([sql]) => sql.includes('INSERT INTO "OrgSources"'))[1];
    expect(params.slice(1, 6)).toEqual(['list', 'Projects Q3', 'projects.csv', 'text/csv', Buffer.byteLength(CSV)]);
    expect(params[7]).toEqual(Buffer.from(CSV));
    expect(params[8]).toBe('2026-09-30T00:00:00.000Z');
    expect(params[9]).toBe('ann@contoso.com');
  });

  it('records an anonymous uploader when auth is off and names the source after the file', async () => {
    queryOne.mockImplementation(async (sql) => (sql.includes('INSERT') ? { id: ID } : undefined));
    const r = await request(app).post('/api/org-truth/sources').attach('file', Buffer.from(CSV), 'teams.csv');
    expect(r.status).toBe(201);
    const params = queryOne.mock.calls.find(([sql]) => sql.includes('INSERT'))[1];
    expect(params[2]).toBe('teams.csv');
    expect(params[9]).toBe('anonymous');
  });

  it('refuses without storing: no file, an unsupported kind, a bad date, a file that does not parse', async () => {
    const noFile = await request(app).post('/api/org-truth/sources').field('kind', 'list');
    expect(noFile.status).toBe(400);
    expect(noFile.body.error).toMatch(/No file was uploaded/);

    const kind = await request(app).post('/api/org-truth/sources').field('kind', 'transcript').attach('file', Buffer.from(CSV), 'a.csv');
    expect(kind.status).toBe(400);
    expect(kind.body.error).toMatch(/"transcript" cannot be imported yet/);

    const date = await request(app).post('/api/org-truth/sources').field('observedAt', 'yesterday').attach('file', Buffer.from(CSV), 'a.csv');
    expect(date.status).toBe(400);
    expect(date.body.error).toMatch(/"yesterday" is not a date/);

    const xls = await request(app).post('/api/org-truth/sources').attach('file', Buffer.from('a,b'), 'old.xls');
    expect(xls.status).toBe(400);
    expect(xls.body).toEqual({ error: 'This is an old-style .xls workbook; save it as .xlsx or .csv and upload it again.' });

    expect(queryOne.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('refuses a second file in one upload with a sentence', async () => {
    const r = await request(app).post('/api/org-truth/sources')
      .attach('file', Buffer.from(CSV), 'a.csv').attach('file', Buffer.from(CSV), 'b.csv');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^The upload could not be read \(.+\); send one file in the field "file"\.$/);
  });

  it('refuses a file over the 50 MB limit with 413', async () => {
    const r = await request(app).post('/api/org-truth/sources').attach('file', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41), 'big.csv');
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/larger than 50 MB/);
  });

  it('answers a JSON 500 when storing fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    queryOne.mockImplementation(async (sql) => { if (sql.includes('INSERT')) throw new Error('disk full'); });
    const r = await request(app).post('/api/org-truth/sources').attach('file', Buffer.from(CSV), 'a.csv');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to store the source.' });
  });
});

describe('readUploadFields', () => {
  const file = { originalname: 'list.csv' };
  it('defaults kind to list, observedAt to now and the name to the file name', () => {
    const before = Date.now();
    const out = readUploadFields({}, file);
    expect(out.kind).toBe('list');
    expect(out.displayName).toBe('list.csv');
    expect(Date.parse(out.observedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(readUploadFields(undefined, file).displayName).toBe('list.csv');
    expect(readUploadFields({ displayName: '   ' }, file).displayName).toBe('list.csv');
  });
});

describe('GET /org-truth/sources', () => {
  it('lists the sources the store returns', async () => {
    query.mockResolvedValue({ rows: [{ id: ID, runCount: 1, lastRunAt: '2026-10-01' }] });
    const r = await request(app).get('/api/org-truth/sources');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: ID, runCount: 1, lastRunAt: '2026-10-01' }]);
  });
});

describe('GET /org-truth/sources/:id', () => {
  it('returns the row, or 404 for an unknown or malformed id', async () => {
    queryOne.mockImplementation(async (sql, params) => (sql.includes('"OrgSources"') && params[0] === ID ? { id: ID } : undefined));
    expect((await request(app).get(`/api/org-truth/sources/${ID}`)).body).toEqual({ id: ID });
    const unknown = await request(app).get('/api/org-truth/sources/00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'Source not found.' });
    expect((await request(app).get('/api/org-truth/sources/not-an-id')).status).toBe(404);
  });
});

describe('GET /org-truth/sources/:id/download', () => {
  it('sends the original bytes as an attachment with the stored type', async () => {
    queryOne.mockImplementation(async (sql) => (sql.includes('"content"') ? { id: ID, fileName: 'projects.csv', mimeType: 'text/csv', content: Buffer.from(CSV) } : undefined));
    const r = await request(app).get(`/api/org-truth/sources/${ID}/download`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="projects.csv"');
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.body.toString()).toBe(CSV);
  });

  it('falls back to the display name and a binary type', async () => {
    queryOne.mockImplementation(async (sql) => (sql.includes('"content"') ? { id: ID, displayName: 'Projects', content: Buffer.from('x') } : undefined));
    const r = await request(app).get(`/api/org-truth/sources/${ID}/download`);
    expect(r.headers['content-disposition']).toBe('attachment; filename="Projects"');
    expect(r.headers['content-type']).toBe('application/octet-stream');
  });

  it('answers 404 for an unknown source or one without bytes', async () => {
    expect((await request(app).get(`/api/org-truth/sources/${ID}/download`)).status).toBe(404);
    queryOne.mockImplementation(async (sql) => (sql.includes('"content"') ? { id: ID, content: null } : undefined));
    expect((await request(app).get(`/api/org-truth/sources/${ID}/download`)).status).toBe(404);
  });
});

describe('GET /org-truth/sources/:id/columns', () => {
  it('re-profiles the stored bytes', async () => {
    queryOne.mockImplementation(async (sql) => (sql.includes('"content"') ? { id: ID, fileName: 'p.csv', content: Buffer.from(CSV) } : undefined));
    const r = await request(app).get(`/api/org-truth/sources/${ID}/columns`);
    expect(r.status).toBe(200);
    expect(r.body.rowCount).toBe(2);
    expect(r.body.headerRow).toBe(1);
    expect(r.body.columns[2]).toMatchObject({ name: 'Owner', nonEmpty: 2, distinct: 2, shape: 'email' });
  });

  it('answers 404 for an unknown source and 400 for bytes that no longer parse', async () => {
    expect((await request(app).get(`/api/org-truth/sources/${ID}/columns`)).status).toBe(404);
    queryOne.mockImplementation(async (sql) => (sql.includes('"content"') ? { id: ID, content: Buffer.alloc(0) } : undefined));
    const r = await request(app).get(`/api/org-truth/sources/${ID}/columns`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'The file is empty.' });
  });
});
