/**
 * GET /admin/crawler-configs/:configId/files/:filename/header — the first line
 * of an already-uploaded file.
 *
 * A wizard mapping a source's columns onto a schema needs that file's real
 * column names. It can slice a file still staged in the browser itself; a file
 * already uploaded, or copied straight into the folder on the server, it cannot
 * — so re-mapping on edit had nothing to offer.
 *
 * Generic, type-agnostic engine code (it serves any crawler type that declares
 * supportsFileUploads), so it is tested here rather than in the csv crawler's
 * folder — same split as its sibling list/upload/delete routes.
 *
 * UPLOAD_ROOT is captured by crawlerFiles.js at module-load time, so it must be
 * set *before* the module is imported (same technique as
 * crawlerFiles.uploads.test.js).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const UPLOAD_ROOT_DIR = mkdtempSync(join(tmpdir(), 'iatest-headers-'));
process.env.UPLOAD_ROOT = UPLOAD_ROOT_DIR;

// The shared manual mock (src/db/__mocks__/connection.js): getPool() resolves a
// pool whose query is the exported `query` spy, so staging `query` stages the
// config lookup.
vi.mock('../db/connection.js');
const { query: mockDbQuery } = await import('../db/connection.js');
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const { default: crawlerFilesRouter } = await import('./crawlerFiles.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', crawlerFilesRouter);
  return app;
}

// Write a file into the folder a csv config of this id reads from.
function seed(configId, name, content) {
  const dir = join(UPLOAD_ROOT_DIR, `csv-${configId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

const asCsvConfig = () => mockDbQuery.mockResolvedValueOnce({ rows: [{ crawlerType: 'csv' }] });
const get = (configId, name) => request(makeApp()).get(`/api/admin/crawler-configs/${configId}/files/${encodeURIComponent(name)}/header`);

beforeEach(() => { mockDbQuery.mockReset(); });
afterAll(() => { rmSync(UPLOAD_ROOT_DIR, { recursive: true, force: true }); });

describe('files/:filename/header', () => {
  it('returns the first line only, not the data rows', async () => {
    seed(601, 'ad_people.csv', 'samaccountname,cn,mail\nu1,Alice,alice@x.test\nu2,Bob,bob@x.test\n');
    asCsvConfig();
    const res = await get(601, 'ad_people.csv');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'ad_people.csv', header: 'samaccountname,cn,mail' });
  });

  it('handles CRLF line endings — a Windows export is the common case', async () => {
    seed(601, 'crlf.csv', 'a;b;c\r\n1;2;3\r\n');
    asCsvConfig();
    const res = await get(601, 'crlf.csv');
    expect(res.body.header).toBe('a;b;c');
  });

  it('returns a header-only file whole, with no trailing newline', async () => {
    seed(601, 'headeronly.csv', 'a;b');
    asCsvConfig();
    const res = await get(601, 'headeronly.csv');
    expect(res.body.header).toBe('a;b');
  });

  it('returns an empty header for an empty file rather than failing', async () => {
    seed(601, 'empty.csv', '');
    asCsvConfig();
    const res = await get(601, 'empty.csv');
    expect(res.status).toBe(200);
    expect(res.body.header).toBe('');
  });

  it('reads at most the first 64 KB, however large the file is', async () => {
    // A 1.8 GB entitlement extract is a real case: the response must never be
    // proportional to the file. 200 KB of data on ONE line, so a naive
    // read-the-whole-file-then-split would return all of it.
    seed(601, 'huge.csv', `${'x'.repeat(200000)}\nrow\n`);
    asCsvConfig();
    const res = await get(601, 'huge.csv');
    expect(res.status).toBe(200);
    expect(res.body.header).toHaveLength(65536);
  });

  it('404s for a file that is not in the folder', async () => {
    asCsvConfig();
    const res = await get(601, 'missing.csv');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('404s for a name that is a sub-folder, not a file', async () => {
    mkdirSync(join(UPLOAD_ROOT_DIR, 'csv-601', 'subdir.csv'), { recursive: true });
    asCsvConfig();
    const res = await get(601, 'subdir.csv');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('File not found');
  });

  it('strips a traversal prefix to a basename inside the config folder — never reads outside it', async () => {
    asCsvConfig();
    const res = await request(makeApp()).get('/api/admin/crawler-configs/601/files/..%2F..%2Fetc%2Fpasswd/header');
    // Resolved to <folder>/passwd, which does not exist. Not /etc/passwd.
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('refuses a dotfile name outright', async () => {
    asCsvConfig();
    const res = await request(makeApp()).get('/api/admin/crawler-configs/601/files/.env/header');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filename');
  });

  it('rejects a config whose crawler type does not support file uploads', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ crawlerType: 'entra-id' }] });
    const res = await get(601, 'ad_people.csv');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not support file uploads/);
  });

  it('404s for a config that does not exist', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await get(601, 'ad_people.csv');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Crawler config not found/);
  });

  it('rejects a non-numeric configId before touching the filesystem', async () => {
    const res = await request(makeApp()).get('/api/admin/crawler-configs/abc/files/x.csv/header');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid configId');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});
