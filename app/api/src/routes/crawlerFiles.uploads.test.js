/**
 * Real upload/list/delete cycle for the generic crawler file-upload routes —
 * needs a writable folder, unlike crawlerFiles.test.js's routing/gating tests.
 *
 * UPLOAD_ROOT is captured by crawlerFiles.js at module-load time, so it must
 * be set *before* the module is imported. Same technique already proven in
 * bootstrap.builtinKey.test.js for WORKER_KEY_FILE: real temp dir via
 * mkdtempSync, set the env var, then dynamic `await import(...)`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const UPLOAD_ROOT_DIR = mkdtempSync(join(tmpdir(), 'iatest-uploads-'));
process.env.UPLOAD_ROOT = UPLOAD_ROOT_DIR;

const { mockPool, mockDbQuery } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  // The handler calls pool.query(text, params) and reads .rows; normalize the
  // staged { recordset } (or { rows }) result so .rows is always present.
  const mockPool = { query: async (...a) => { const r = await mockDbQuery(...a); return r ? { ...r, rows: r.rows ?? r.recordset ?? [] } : r; } };
  return { mockPool, mockDbQuery };
});

vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool }));
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const { default: crawlerFilesRouter, deleteConfigFolder } = await import('./crawlerFiles.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', crawlerFilesRouter);
  return app;
}

beforeEach(() => {
  mockDbQuery.mockClear();
});

afterAll(() => {
  rmSync(UPLOAD_ROOT_DIR, { recursive: true, force: true });
});

describe('crawler-configs/:configId/files — real upload/list/delete cycle', () => {
  it('uploads a .csv file to a real csv config, landing at {UPLOAD_ROOT}/csv-{id}/', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/501/files')
      .attach('files', Buffer.from('ExternalId;DisplayName\n1;Test'), 'Resources.csv');

    expect(res.status).toBe(200);
    expect(res.body.uploaded).toEqual([{ name: 'Resources.csv', sizeBytes: expect.any(Number) }]);

    const expectedPath = join(UPLOAD_ROOT_DIR, 'csv-501', 'Resources.csv');
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, 'utf8')).toBe('ExternalId;DisplayName\n1;Test');
  });

  it('lists the uploaded file back', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    const res = await request(makeApp()).get('/api/admin/crawler-configs/501/files');
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([
      { name: 'Resources.csv', sizeBytes: expect.any(Number), modifiedAt: expect.any(String) },
    ]);
  });

  it('rejects a .txt file via the manifest-driven extension filter', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/501/files')
      .attach('files', Buffer.from('not allowed'), 'notes.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/File type not allowed/);
    expect(existsSync(join(UPLOAD_ROOT_DIR, 'csv-501', 'notes.txt'))).toBe(false);
  });

  it('rejects a dotfile-style filename', async () => {
    // A literal '..' segment never reaches the handler at all — Express's own
    // URL normalization collapses it (one directory up) before routing, so it
    // 404s rather than reaching sanitizeFilename. Use a dotfile name instead,
    // which Express does NOT treat as special, to actually exercise the
    // startsWith('.') branch of sanitizeFilename.
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    const res = await request(makeApp())
      .delete('/api/admin/crawler-configs/501/files/' + encodeURIComponent('.env'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid filename/);
  });

  it('strips directory components from a path-traversal filename instead of escaping the config folder', async () => {
    // basename() reduces '../../etc/passwd' to just 'passwd' — confirm the
    // delete can only ever touch a file inside this config's own folder, by
    // planting a decoy 'passwd' file there and confirming only THAT gets
    // removed. Together these assertions prove containment: had the traversal
    // escaped, `deleted` would not be the bare 'passwd' and the in-folder decoy
    // would survive. (We deliberately don't assert on a real OS file like
    // /etc/passwd — that sentinel is Linux-only and the checks below already
    // prove the path was sanitised, portably.)
    const configDir = join(UPLOAD_ROOT_DIR, 'csv-501');
    const decoy = join(configDir, 'passwd');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(decoy, 'decoy');

    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    const res = await request(makeApp())
      .delete('/api/admin/crawler-configs/501/files/' + encodeURIComponent('../../etc/passwd'));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('passwd'); // basename stripped '../../etc/'
    expect(existsSync(decoy)).toBe(false);   // the contained file was the delete target
  });

  it('deletes the uploaded file; subsequent list is empty', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    const delRes = await request(makeApp()).delete('/api/admin/crawler-configs/501/files/Resources.csv');
    expect(delRes.status).toBe(200);
    expect(existsSync(join(UPLOAD_ROOT_DIR, 'csv-501', 'Resources.csv'))).toBe(false);

    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    const listRes = await request(makeApp()).get('/api/admin/crawler-configs/501/files');
    expect(listRes.body.files).toEqual([]);
  });

  it('deleteConfigFolder removes the whole per-config folder', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    await request(makeApp())
      .post('/api/admin/crawler-configs/777/files')
      .attach('files', Buffer.from('a;b'), 'Systems.csv');
    const dir = join(UPLOAD_ROOT_DIR, 'csv-777');
    expect(existsSync(dir)).toBe(true);

    await deleteConfigFolder('csv', 777);
    expect(existsSync(dir)).toBe(false);
  });
});
