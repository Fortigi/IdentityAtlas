/**
 * The per-file upload cap, end to end through multer — separate from
 * crawlerFiles.uploads.test.js because the cap is resolved when crawlerFiles.js
 * loads, so UPLOAD_MAX_FILE_BYTES (like UPLOAD_ROOT) must be set before the
 * dynamic import. A 2 KiB cap lets a real over-limit file be sent in a test.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const UPLOAD_ROOT_DIR = mkdtempSync(join(tmpdir(), 'iatest-uploadlimit-'));
process.env.UPLOAD_ROOT = UPLOAD_ROOT_DIR;
process.env.UPLOAD_MAX_FILE_BYTES = '2048';

// The shared manual mock (src/db/__mocks__/connection.js): getPool().query routes
// to the exported `query` spy.
vi.mock('../db/connection.js');
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_req, _res, next) => next() }));

const { query: mockDbQuery } = await import('../db/connection.js');
const { default: crawlerFilesRouter } = await import('./crawlerFiles.js');
const csvConfig = { rows: [{ crawlerType: 'csv' }] };

function makeApp() {
  const app = express();
  app.use('/api', crawlerFilesRouter);
  return app;
}

afterAll(() => {
  rmSync(UPLOAD_ROOT_DIR, { recursive: true, force: true });
  delete process.env.UPLOAD_MAX_FILE_BYTES;
});

describe('per-file upload cap (UPLOAD_MAX_FILE_BYTES)', () => {
  it('reports the configured cap, not the default', async () => {
    const res = await request(makeApp()).get('/api/admin/crawler-uploads/limits');
    expect(res.body).toEqual({ maxFileBytes: 2048 });
  });

  it('refuses a file over the cap with 413 and a message naming the real limit', async () => {
    mockDbQuery.mockResolvedValueOnce(csvConfig);
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/7/files')
      .attach('files', Buffer.alloc(4096, 'a'), 'Assignments.csv');
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('A file is larger than the 2.0 KiB per-file upload limit. An administrator can raise it with UPLOAD_MAX_FILE_BYTES.');
    expect(res.body.maxFileBytes).toBe(2048);
    // The partial file must not be left behind for the next job to read.
    expect(existsSync(join(UPLOAD_ROOT_DIR, 'csv-7', 'Assignments.csv'))).toBe(false);
  });

  it('accepts a file exactly at the cap', async () => {
    mockDbQuery.mockResolvedValueOnce(csvConfig);
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/8/files')
      .attach('files', Buffer.alloc(2048, 'a'), 'Users.csv');
    expect(res.status).toBe(200);
    expect(res.body.uploaded).toEqual([{ name: 'Users.csv', sizeBytes: 2048 }]);
  });
});
