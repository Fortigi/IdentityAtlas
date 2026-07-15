/**
 * Tests for the generic crawler file-upload + upload-schema routes that don't
 * need real disk I/O: type-gating (assertUploadableConfig), the schema-template
 * routes (which read real, checked-in files under tools/crawlers/<type>/schema/),
 * and getUploadFolderPath's pure path-naming logic.
 *
 * The actual upload/list/delete cycle (which needs a writable folder) is in
 * crawlerFiles.uploads.test.js.
 *
 * Uses real crawler manifests (not mocked) — csv really has supportsFileUploads,
 * entra-id really doesn't — same approach as jobs.discover.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import crawlerFilesRouter, { getUploadFolderPath, mimeTypeFor } from './crawlerFiles.js';

// ─── Shared mocks ─────────────────────────────────────────────────────────────

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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', crawlerFilesRouter);
  return app;
}

beforeEach(() => {
  mockDbQuery.mockClear();
});

// ─── Type-gating (assertUploadableConfig) ──────────────────────────────────────

describe('crawler-configs/:configId/files — type gating', () => {
  it('rejects GET for a config whose type does not support file uploads', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'entra-id' }] });
    const res = await request(makeApp()).get('/api/admin/crawler-configs/1/files');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not support file uploads/);
  });

  it('rejects POST (upload) for a config whose type does not support file uploads', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'entra-id' }] });
    const res = await request(makeApp())
      .post('/api/admin/crawler-configs/1/files')
      .attach('files', Buffer.from('a,b\n1,2'), 'data.csv');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not support file uploads/);
  });

  it('rejects DELETE for a config whose type does not support file uploads', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'entra-id' }] });
    const res = await request(makeApp()).delete('/api/admin/crawler-configs/1/files/data.csv');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not support file uploads/);
  });

  it('returns 404 when the config does not exist', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [] });
    const res = await request(makeApp()).get('/api/admin/crawler-configs/999/files');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Crawler config not found/);
  });

  it('rejects a non-numeric configId before touching the DB', async () => {
    const res = await request(makeApp()).get('/api/admin/crawler-configs/not-a-number/files');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid configId/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('lists an empty array for a real csv config with no upload folder yet (no I/O needed)', async () => {
    mockDbQuery.mockResolvedValueOnce({ recordset: [{ crawlerType: 'csv' }] });
    // A random high id is extremely unlikely to have a real folder under the
    // default UPLOAD_ROOT in this test environment.
    const res = await request(makeApp()).get('/api/admin/crawler-configs/9999999/files');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [] });
  });
});

// ─── getUploadFolderPath — pure function, no I/O ───────────────────────────────

describe('getUploadFolderPath', () => {
  it('builds a {crawlerType}-{configId} folder name', () => {
    expect(getUploadFolderPath('csv', 42)).toMatch(/csv-42$/);
  });

  it('is parameterized by crawler type, not hardcoded to csv', () => {
    expect(getUploadFolderPath('excel', 7)).toMatch(/excel-7$/);
    expect(getUploadFolderPath('excel', 7)).not.toMatch(/csv/);
  });
});

// ─── mimeTypeFor — pure function, no I/O ───────────────────────────────────────
// Not hardcoded to .csv — derives the type from whatever extension a future
// crawler's template files use, falling back to a generic binary type for
// anything unrecognized rather than mislabeling it as CSV.

describe('mimeTypeFor', () => {
  it('maps known extensions to their content type', () => {
    expect(mimeTypeFor('Users.csv')).toBe('text/csv');
    expect(mimeTypeFor('data.json')).toBe('application/json');
    expect(mimeTypeFor('export.xml')).toBe('application/xml');
    expect(mimeTypeFor('notes.txt')).toBe('text/plain');
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeTypeFor('USERS.CSV')).toBe('text/csv');
  });

  it('falls back to a generic binary type for an unrecognized extension', () => {
    expect(mimeTypeFor('Template.xlsx')).toBe('application/octet-stream');
  });
});

// ─── Upload schema templates ────────────────────────────────────────────────────

describe('GET /admin/crawlers/:type/upload-schema', () => {
  it('serves all 10 real csv templates with label/required annotations, including ContextMembers.csv', async () => {
    const res = await request(makeApp()).get('/api/admin/crawlers/csv/upload-schema');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/# ContextMembers\.csv — Context Members \(optional\)/);
    expect(res.text).toMatch(/ContextExternalId;MemberExternalId;MemberType/);
    expect(res.text).toMatch(/# Resources\.csv — Resources \(REQUIRED\)/);
    for (const file of [
      'Systems.csv', 'Contexts.csv', 'ContextMembers.csv', 'Resources.csv',
      'ResourceRelationships.csv', 'Users.csv', 'Assignments.csv', 'Identities.csv',
      'IdentityMembers.csv', 'Certifications.csv',
    ]) {
      expect(res.text).toContain(file);
    }
  });

  it('serves a single real template file by name with a content-type derived from its extension', async () => {
    const res = await request(makeApp()).get('/api/admin/crawlers/csv/upload-schema/ContextMembers.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.text.trim()).toBe('ContextExternalId;MemberExternalId;MemberType');
  });


  it('404s for an unknown template filename under a real type', async () => {
    const res = await request(makeApp()).get('/api/admin/crawlers/csv/upload-schema/NotARealFile.csv');
    expect(res.status).toBe(404);
  });

  it('404s for a real crawler type with no schema/ folder (entra-id)', async () => {
    const res = await request(makeApp()).get('/api/admin/crawlers/entra-id/upload-schema');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/has no upload schema/);
  });

  it('404s for an unknown crawler type', async () => {
    const res = await request(makeApp()).get('/api/admin/crawlers/nonexistent-type/upload-schema');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown crawler type/);
  });

  it('404s for a path-traversal-style type slug', async () => {
    const res = await request(makeApp()).get('/api/admin/crawlers/../shared/upload-schema');
    // Express normalises the URL so the param becomes a single segment that
    // isn't a registered crawler type — same defense as the discover.js route.
    expect(res.status).toBe(404);
  });
});
