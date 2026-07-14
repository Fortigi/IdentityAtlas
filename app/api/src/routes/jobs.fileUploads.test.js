/**
 * Tests for the generalized file-upload dispatch block in jobs.js's
 * POST /admin/crawler-jobs handler — replaced a hardcoded `jobType === 'csv'`
 * check with a manifest-driven `_crawlerManifests[jobType]?.supportsFileUploads`
 * check (PR #356). Covers: the manifest gate itself, the "folder must contain
 * >=1 file" requirement, the csvFolder override + path-containment guard, and
 * that non-upload types skip the whole block entirely.
 *
 * jobs.js captures CSV_BASE_DIR (from UPLOAD_ROOT) at module-load time, same
 * as crawlerFiles.js — same real-temp-dir + dynamic-import technique as
 * bootstrap.builtinKey.test.js / crawlerFiles.uploads.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const UPLOAD_ROOT_DIR = mkdtempSync(join(tmpdir(), 'iatest-jobs-uploads-'));
process.env.UPLOAD_ROOT = UPLOAD_ROOT_DIR;
process.env.USE_SQL = 'true'; // jobs.js captures this at module-load time too

const { mockPool, mockDbQuery } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  // Normalise staged results so a handler reading pool.query → .rows gets the
  // rows whether the test staged .rows or (legacy) .recordset — one mockDbQuery
  // spy backs the whole native jobs surface (#663).
  const run = async (...a) => {
    const r = await mockDbQuery(...a);
    if (r == null) return r;
    const rows = r.rows ?? r.recordset ?? [];
    const rowCount = r.rowCount ?? r.rowsAffected?.[0] ?? rows.length;
    return { ...r, rows, recordset: rows, rowCount, rowsAffected: [rowCount] };
  };
  const mockPool = { query: (...a) => run(...a) };
  return { mockPool, mockDbQuery };
});

vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool }));
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const { default: jobsRouter } = await import('./jobs.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', jobsRouter);
  return app;
}

// Helper: pull the JSON-stringified config the INSERT was about to store. The
// job INSERT now binds it as the 2nd positional param — pool.query(sql,
// [jobType, configJson, createdBy]) — so read it off the mockDbQuery call args.
function storedConfig() {
  const call = mockDbQuery.mock.calls.find(c => /INSERT INTO "CrawlerJobs"/.test(c[0]));
  const configJson = call?.[1]?.[1];
  return configJson ? JSON.parse(configJson) : null;
}

beforeEach(() => {
  mockDbQuery.mockClear();
});

afterAll(() => {
  rmSync(UPLOAD_ROOT_DIR, { recursive: true, force: true });
});

describe('POST /admin/crawler-jobs — generalized file-upload dispatch', () => {
  it('queues a csv job when its upload folder has >=1 file, stamping csvFolder onto the stored config', async () => {
    const dir = join(UPLOAD_ROOT_DIR, 'csv-501');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Resources.csv'), 'a;b');

    mockDbQuery
      .mockResolvedValueOnce({ recordset: [{ config: {}, nextRunMode: 'delta' }] }) // config lookup
      .mockResolvedValueOnce({ recordset: [{ id: 1 }] }) // insert
      .mockResolvedValueOnce({ recordset: [] }); // lastRunAt update

    const res = await request(makeApp())
      .post('/api/admin/crawler-jobs')
      .send({ jobType: 'csv', configId: 501 });

    expect(res.status).toBe(201);
    expect(storedConfig().csvFolder).toBe(dir);
  });

  it('rejects a csv job whose upload folder is empty', async () => {
    mkdirSync(join(UPLOAD_ROOT_DIR, 'csv-502'), { recursive: true }); // exists but empty
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ config: {}, nextRunMode: 'delta' }] });

    const res = await request(makeApp())
      .post('/api/admin/crawler-jobs')
      .send({ jobType: 'csv', configId: 502 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No files found/);
  });

  it('rejects a csv job with no configId before even checking for files', async () => {
    const res = await request(makeApp())
      .post('/api/admin/crawler-jobs')
      .send({ jobType: 'csv' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/csv jobs require a configId/);
  });

  it('skips the file-upload gate entirely for a type that does not support uploads (demo)', async () => {
    // No upload folder exists anywhere for this — if the gate ran at all for
    // 'demo' it would 400 on a missing folder. It shouldn't even check.
    mockDbQuery
      .mockResolvedValueOnce({ recordset: [] }) // no duplicate demo job queued
      .mockResolvedValueOnce({ recordset: [{ id: 2 }] }); // insert (no configId -> no lastRunAt update)

    const res = await request(makeApp())
      .post('/api/admin/crawler-jobs')
      .send({ jobType: 'demo' });

    expect(res.status).toBe(201);
  });

  it('accepts a csvFolder override that stays within the upload base directory', async () => {
    const customDir = join(UPLOAD_ROOT_DIR, 'custom-csv-folder');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'Users.csv'), 'a;b');
    // The default csv-503 folder deliberately does NOT exist, to prove the
    // override (not the default path) is what satisfied the file check.

    mockDbQuery
      .mockResolvedValueOnce({ recordset: [{ config: { csvFolder: customDir }, nextRunMode: 'delta' }] })
      .mockResolvedValueOnce({ recordset: [{ id: 3 }] })
      .mockResolvedValueOnce({ recordset: [] });

    const res = await request(makeApp())
      .post('/api/admin/crawler-jobs')
      .send({ jobType: 'csv', configId: 503 });

    expect(res.status).toBe(201);
    expect(storedConfig().csvFolder).toBe(customDir);
  });

  it('rejects a csvFolder override that escapes the upload base directory, falling back to the default path', async () => {
    // The override points outside UPLOAD_ROOT entirely. The default csv-504
    // folder also doesn't exist, so the request should 400 on "no files" —
    // proving the malicious override was never followed, not just that it
    // didn't grant extra access.
    mockDbQuery.mockResolvedValueOnce({
      recordset: [{ config: { csvFolder: '/etc' }, nextRunMode: 'delta' }],
    });

    const res = await request(makeApp())
      .post('/api/admin/crawler-jobs')
      .send({ jobType: 'csv', configId: 504 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No files found/);
  });
});
