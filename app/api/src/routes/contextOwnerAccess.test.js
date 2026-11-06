// The context-owner switches' admin route: shape, validation, and that each
// field writes only its own switch.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({ enabled: false, mcp: false, fail: false }));
vi.mock('../auth/contextOwnerSetting.js', () => ({
  isContextOwnerAccessEnabled: vi.fn(async () => state.enabled),
  getContextOwnerMcpSwitch: vi.fn(async () => state.mcp),
  setContextOwnerAccess: vi.fn(async (v) => { if (state.fail) throw new Error('db down'); state.enabled = v; return v; }),
  setContextOwnerMcp: vi.fn(async (v) => { if (state.fail) throw new Error('db down'); state.mcp = v; return v; }),
}));

const { setContextOwnerAccess, setContextOwnerMcp } = await import('../auth/contextOwnerSetting.js');
const { default: router } = await import('./contextOwnerAccess.js');

const app = express();
app.use(express.json());
app.use('/api', router);

beforeEach(() => {
  Object.assign(state, { enabled: false, mcp: false, fail: false });
  vi.clearAllMocks();
});

describe('GET /api/admin/context-owner-access', () => {
  it('returns both switches', async () => {
    state.mcp = true;
    expect((await request(app).get('/api/admin/context-owner-access').expect(200)).body).toEqual({ enabled: false, mcp: true });
  });
});

describe('PUT /api/admin/context-owner-access', () => {
  it('turns owner access on without touching the MCP switch', async () => {
    const res = await request(app).put('/api/admin/context-owner-access').send({ enabled: true }).expect(200);
    expect(res.body).toEqual({ enabled: true, mcp: false });
    expect(setContextOwnerMcp).not.toHaveBeenCalled();
  });

  it('turns the MCP switch on without touching owner access', async () => {
    const res = await request(app).put('/api/admin/context-owner-access').send({ mcp: true }).expect(200);
    expect(res.body).toEqual({ enabled: false, mcp: true });
    expect(setContextOwnerAccess).not.toHaveBeenCalled();
  });

  it('saves both when both are sent', async () => {
    const res = await request(app).put('/api/admin/context-owner-access').send({ enabled: true, mcp: true }).expect(200);
    expect(res.body).toEqual({ enabled: true, mcp: true });
  });

  it.each([[{}], [{ enabled: 'true' }], [{ mcp: 1 }], [{ enabled: true, mcp: null }]])('refuses %j with 400 and writes nothing', async (body) => {
    await request(app).put('/api/admin/context-owner-access').send(body).expect(400);
    expect(setContextOwnerAccess).not.toHaveBeenCalled();
    expect(setContextOwnerMcp).not.toHaveBeenCalled();
  });

  it('answers 500 when saving fails', async () => {
    state.fail = true;
    const res = await request(app).put('/api/admin/context-owner-access').send({ mcp: true }).expect(500);
    expect(res.body.error).toBe('Failed to save the setting');
  });
});
