import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../effectiveAccess/engine.js', () => ({ effectiveAccess: vi.fn() }));
import { effectiveAccess } from '../effectiveAccess/engine.js';

const { default: router } = await import('./effectiveAccess.js');

const app = express();
app.use('/api', router);

beforeEach(() => vi.clearAllMocks());

describe('GET /api/effective-access/resolve', () => {
  it('400 when resourceId is missing', async () => {
    const res = await request(app).get('/api/effective-access/resolve?principalId=p1');
    expect(res.status).toBe(400);
    expect(effectiveAccess).not.toHaveBeenCalled();
  });

  it('400 when principalId is missing', async () => {
    const res = await request(app).get('/api/effective-access/resolve?resourceId=r1');
    expect(res.status).toBe(400);
  });

  it('returns the engine result with the echoed ids', async () => {
    effectiveAccess.mockResolvedValue({ effective: 'allow', badge: 'Indirect', decisiveAce: {}, truncated: null });
    const res = await request(app).get('/api/effective-access/resolve?resourceId=r1&principalId=p1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resourceId: 'r1', principalId: 'p1', effective: 'allow', badge: 'Indirect' });
    expect(effectiveAccess).toHaveBeenCalledWith('r1', 'p1', {});
  });

  it('passes the policy option through', async () => {
    effectiveAccess.mockResolvedValue({ effective: 'none', badge: null, decisiveAce: null, truncated: null });
    await request(app).get('/api/effective-access/resolve?resourceId=r1&principalId=p1&policy=AdditiveAllow');
    expect(effectiveAccess).toHaveBeenCalledWith('r1', 'p1', { policy: 'AdditiveAllow' });
  });

  it('400 on an unknown policy (engine throws)', async () => {
    effectiveAccess.mockRejectedValue(new Error("Unknown resolution policy 'Nope'. Known: AdditiveAllow"));
    const res = await request(app).get('/api/effective-access/resolve?resourceId=r1&principalId=p1&policy=Nope');
    expect(res.status).toBe(400);
  });

  it('500 on an unexpected engine error', async () => {
    effectiveAccess.mockRejectedValue(new Error('connection reset'));
    const res = await request(app).get('/api/effective-access/resolve?resourceId=r1&principalId=p1');
    expect(res.status).toBe(500);
  });
});
