// Unit tests for routes/dataExport.js — read-token CRUD + workbook download.
// readTokens, excelWorkbook, and exportBaseUrl helpers are mocked. Auth is
// disabled by default so requirePermission gates pass through.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const createToken = vi.fn();
const listTokens = vi.fn();
const revokeToken = vi.fn();
vi.mock('../auth/readTokens.js', () => ({
  createToken: (...a) => createToken(...a),
  listTokens: (...a) => listTokens(...a),
  revokeToken: (...a) => revokeToken(...a),
}));

const generateWorkbook = vi.fn();
vi.mock('../export/excelWorkbook.js', () => ({ generateWorkbook: (...a) => generateWorkbook(...a) }));
vi.mock('../export/exportBaseUrl.js', () => ({ resolveExportBaseUrl: () => 'https://host/api' }));

const { default: router } = await import('./dataExport.js');
const app = mountRouter(router);

beforeEach(() => {
  createToken.mockReset();
  listTokens.mockReset();
  revokeToken.mockReset();
  generateWorkbook.mockReset();
});

describe('GET /admin/read-tokens', () => {
  it('lists tokens', async () => {
    listTokens.mockResolvedValueOnce([{ id: 1, name: 'a' }]);
    const res = await request(app).get('/api/admin/read-tokens');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('500 when list rejects', async () => {
    listTokens.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).get('/api/admin/read-tokens');
    expect(res.status).toBe(500);
  });
});

describe('POST /admin/read-tokens', () => {
  it('400 when name missing', async () => {
    const res = await request(app).post('/api/admin/read-tokens').send({});
    expect(res.status).toBe(400);
  });

  it('400 when name too long', async () => {
    const res = await request(app).post('/api/admin/read-tokens').send({ name: 'x'.repeat(201) });
    expect(res.status).toBe(400);
  });

  it('400 when expiresAt invalid', async () => {
    const res = await request(app).post('/api/admin/read-tokens').send({ name: 'ok', expiresAt: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  it('201 + token on success', async () => {
    createToken.mockResolvedValueOnce({ token: 'fgr_abc', row: { id: 1, name: 'ok' } });
    const res = await request(app).post('/api/admin/read-tokens').send({ name: '  ok  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ token: 'fgr_abc' });
    expect(createToken).toHaveBeenCalledWith(expect.objectContaining({ name: 'ok' }));
  });

  it('500 when createToken rejects', async () => {
    createToken.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).post('/api/admin/read-tokens').send({ name: 'ok' });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /admin/read-tokens/:id', () => {
  it('400 on non-numeric id', async () => {
    const res = await request(app).delete('/api/admin/read-tokens/abc');
    expect(res.status).toBe(400);
  });

  it('404 when not found', async () => {
    revokeToken.mockResolvedValueOnce(false);
    const res = await request(app).delete('/api/admin/read-tokens/5');
    expect(res.status).toBe(404);
  });

  it('200 when revoked', async () => {
    revokeToken.mockResolvedValueOnce(true);
    const res = await request(app).delete('/api/admin/read-tokens/5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('500 when revoke rejects', async () => {
    revokeToken.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).delete('/api/admin/read-tokens/5');
    expect(res.status).toBe(500);
  });
});

describe('POST /admin/data-export/workbook', () => {
  it('returns an xlsx attachment', async () => {
    createToken.mockResolvedValueOnce({ token: 'fgr_t' });
    generateWorkbook.mockResolvedValueOnce(Buffer.from('PK-fake-xlsx'));
    const res = await request(app).post('/api/admin/data-export/workbook').send({ name: 'My Book' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(generateWorkbook).toHaveBeenCalledWith(expect.objectContaining({ token: 'fgr_t' }));
  });

  it('500 when workbook generation rejects', async () => {
    createToken.mockResolvedValueOnce({ token: 'fgr_t' });
    generateWorkbook.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/admin/data-export/workbook').send({});
    expect(res.status).toBe(500);
  });
});
