// The two request-shaping halves of context-owner mode, driven directly:
// marking a response's references, and forcing the team matrix's filter. The
// end-to-end allow/deny is middleware/contextOwnerMode.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const types = vi.hoisted(() => ({ map: new Map() }));
vi.mock('../routes/matrix/shared.js', () => ({ resolveContextTypes: vi.fn(async () => types.map) }));
vi.mock('../db/connection.js');

const { shapeResponse, settleMatrix } = await import('./contextOwnerMode.js');
const { annotateReferences } = await import('../auth/ownerAccess/annotate.js');
const annotateResponse = (res, refs, acc) => shapeResponse(res, refs ? (body) => annotateReferences(body, refs, acc) : null);
const { resolveContextTypes } = await import('../routes/matrix/shared.js');

const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const OUT = 'aaaaaaaa-0000-4000-8000-000000000002';
const MINE = 'cccccccc-0000-4000-8000-000000000001';

function fakeRes() {
  const res = { statusCode: 200, sent: [] };
  res.json = vi.fn((body) => { res.sent.push(body); return res; });
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  return res;
}
const access = (open) => ({ accessibleIds: vi.fn(async (_k, ids) => new Set(ids.filter(id => open.includes(id)))) });
const flush = () => new Promise(r => setTimeout(r, 0));
const REFS = [{ at: '', kind: 'principal', key: 'principalId' }];

describe('shapeResponse (marking references)', () => {
  it('sends the body with every reference marked', async () => {
    const res = fakeRes();
    annotateResponse(res, REFS, access([TEAM]));
    expect(res.json([{ principalId: TEAM }, { principalId: OUT }])).toBe(res);
    await flush();
    expect(res.sent).toEqual([[{ principalId: TEAM, accessible: true }, { principalId: OUT, accessible: false }]]);
  });

  it('wraps once although the middleware runs at every router mount', async () => {
    const res = fakeRes();
    const a = access([TEAM]);
    annotateResponse(res, REFS, a);
    annotateResponse(res, REFS, a);
    res.json([{ principalId: TEAM }]);
    await flush();
    expect(a.accessibleIds).toHaveBeenCalledTimes(1);
    expect(res.sent).toHaveLength(1);
  });

  it('leaves res.json alone when the path names nothing', () => {
    const res = fakeRes();
    const original = res.json;
    annotateResponse(res, null, access([]));
    expect(res.json).toBe(original);
  });

  it('answers 500 — never the unmarked body — when marking fails', async () => {
    const res = fakeRes();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    annotateResponse(res, REFS, { accessibleIds: async () => { throw new Error('db down'); } });
    res.json([{ principalId: OUT }]);
    await flush();
    expect(res.statusCode).toBe(500);
    expect(res.sent).toEqual([{ error: 'Authentication service error' }]);
  });
});

describe('settleMatrix', () => {
  beforeEach(() => { types.map = new Map(); resolveContextTypes.mockClear(); });

  it('replaces the body with the forced filter — the aggregate modes and inherited access gone', async () => {
    types.map = new Map([[MINE, 'Identity']]);
    const req = { body: {
      includeInheritedAccess: true,
      filter: { subject: { include: [{ kind: 'context', contextId: MINE.toUpperCase() }] }, rollup: 'department', sortHierarchy: { contextId: MINE } },
    } };
    expect(await settleMatrix(req, new Set([MINE]))).toBe(true);
    expect(req.body).toEqual({ filter: {
      subject: { include: [{ kind: 'context', contextId: MINE, includeChildren: false }], exclude: [] },
      resource: { include: [], exclude: [] },
    } });
  });

  it('matches the context types the database returns in any case', async () => {
    types.map = new Map([[MINE.toUpperCase(), 'Principal']]);
    const req = { body: { filter: { subject: { include: [{ kind: 'context', contextId: MINE }] } } } };
    expect(await settleMatrix(req, new Set([MINE]))).toBe(true);
  });

  it('leaves a refused body as it was', async () => {
    const body = { filter: { subject: { include: [{ kind: 'context', contextId: OUT }] } } };
    const req = { body };
    expect(await settleMatrix(req, new Set([MINE]))).toBe(false);
    expect(req.body).toBe(body);
  });

  it('does not look anything up without a filter object', async () => {
    expect(await settleMatrix({ body: { filter: 'x' } }, new Set([MINE]))).toBe(false);
    expect(await settleMatrix({}, new Set([MINE]))).toBe(false);
    expect(resolveContextTypes).not.toHaveBeenCalled();
  });
});
