/**
 * Upload-cap tests for the crawler file-upload route (M-4).
 *
 * The caps are read from env at module-load time, so we set deliberately tiny
 * values BEFORE importing the router (same technique as crawlerFiles.uploads.test.js
 * for UPLOAD_ROOT): aggregate 10 KB, per-file 50 B, max 3 files. That lets one
 * module-load exercise all three limits.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const UPLOAD_ROOT_DIR = mkdtempSync(join(tmpdir(), 'iatest-caps-'));
process.env.UPLOAD_ROOT = UPLOAD_ROOT_DIR;
process.env.UPLOAD_MAX_TOTAL_BYTES = '10000'; // 10 KB aggregate
process.env.UPLOAD_MAX_FILE_BYTES = '50';     // 50 B per file
process.env.UPLOAD_MAX_FILES = '3';

const { mockPool, mockDbQuery } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  const mockRequest = { input: vi.fn().mockReturnThis(), query: mockDbQuery };
  const mockPool = { request: vi.fn(() => mockRequest) };
  return { mockPool, mockDbQuery };
});

vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool }));
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

// Every request first does the config lookup in assertUploadableConfig.
beforeEach(() => {
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ recordset: [{ crawlerType: 'csv' }] });
});

afterAll(() => {
  rmSync(UPLOAD_ROOT_DIR, { recursive: true, force: true });
});

describe('crawler upload caps (M-4)', () => {
  it('accepts a small file within every cap', async () => {
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/601/files')
      .attach('files', Buffer.from('a;b\n1;2'), 'small.csv'); // 7 B < 50 B
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('rejects a file over the per-file byte cap (413)', async () => {
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/601/files')
      .attach('files', Buffer.alloc(200, 'a'), 'big.csv'); // 200 B > 50 B, but < 10 KB aggregate
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/per-file/i);
  });

  it('rejects a request over the aggregate cap before touching disk (413)', async () => {
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/601/files')
      .attach('files', Buffer.alloc(20000, 'a'), 'huge.csv'); // 20 KB > 10 KB aggregate
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('rejects more files than the count cap (413)', async () => {
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/601/files')
      .attach('files', Buffer.from('x'), 'a.csv')
      .attach('files', Buffer.from('x'), 'b.csv')
      .attach('files', Buffer.from('x'), 'c.csv')
      .attach('files', Buffer.from('x'), 'd.csv'); // 4 > 3
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too many/i);
  });
});
