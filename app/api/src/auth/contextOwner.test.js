// Who is a context owner, and of what (auth/contextOwner.js).
//
// The database is mocked, so these pin the decisions around the SQL — which
// parameters reach it, how rows collapse, what counts as "no owner". Whether
// the statements return the right rows is contract-tests/contextOwner.contract.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
const resolveMeMock = vi.fn();
vi.mock('./resolveMe.js', () => ({ resolveMe: (...a) => resolveMeMock(...a) }));

const { query } = await import('../db/connection.js');
const {
  collapseHeld, findHeldContexts, findSameUnitVariants, resolveReportContexts, resolveContextOwner,
} = await import('./contextOwner.js');

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const V = 'aaaaaaaa-0000-4000-8000-000000000009';

const row = (id, role, name = id) => ({ id, displayName: name, role, contextCategory: 'OrganizationalUnit', targetType: 'Identity' });

beforeEach(() => {
  query.mockReset();
  resolveMeMock.mockReset();
});

describe('collapseHeld', () => {
  it('keeps Accountable when it comes AFTER Responsible for the same context', () => {
    expect(collapseHeld([row(B, 'Responsible'), row(B, 'Accountable')]).map(c => c.role)).toEqual(['Accountable']);
  });

  it('keeps Accountable when Responsible comes after it', () => {
    expect(collapseHeld([row(B, 'Accountable'), row(B, 'Responsible')]).map(c => c.role)).toEqual(['Accountable']);
  });

  it('keeps one entry per context, in row order, with lower-cased ids', () => {
    const out = collapseHeld([row(A, 'Responsible', 'Alpha'), row(B, 'Responsible', 'Beta')]);
    expect(out).toEqual([
      { id: A.toLowerCase(), displayName: 'Alpha', role: 'Responsible', contextCategory: 'OrganizationalUnit', targetType: 'Identity' },
      { id: B, displayName: 'Beta', role: 'Responsible', contextCategory: 'OrganizationalUnit', targetType: 'Identity' },
    ]);
  });

  it('fills a missing category / target type with null', () => {
    expect(collapseHeld([{ id: B, displayName: 'x', role: 'Responsible' }])[0]).toMatchObject({ contextCategory: null, targetType: null });
  });
});

describe('the reads', () => {
  it('findHeldContexts passes the account and the person', async () => {
    query.mockResolvedValue({ rows: [row(B, 'Responsible')] });
    const pool = { query };
    await findHeldContexts(pool, 'p-1', 'i-1');
    expect(query.mock.calls[0][1]).toEqual(['p-1', 'i-1']);
  });

  it('findSameUnitVariants does not query for an empty list', async () => {
    expect(await findSameUnitVariants({ query }, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('findSameUnitVariants returns the other ends, lower-cased', async () => {
    query.mockResolvedValue({ rows: [{ id: V.toUpperCase() }] });
    expect(await findSameUnitVariants({ query }, [B])).toEqual([V]);
    expect(query.mock.calls[0][1]).toEqual([[B]]);
  });

  it('resolveReportContexts lower-cases what it asks for and what it returns', async () => {
    query.mockResolvedValue({ rows: [{ id: A }] });
    expect(await resolveReportContexts({ query }, ['Finance', A])).toEqual([A.toLowerCase()]);
    expect(query.mock.calls[0][1]).toEqual([['finance', A.toLowerCase()]]);
  });
});

describe('resolveContextOwner', () => {
  it('is null when the caller is not matched to an account (no query made)', async () => {
    resolveMeMock.mockResolvedValue(null);
    expect(await resolveContextOwner({ oid: 'x' })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('is null when the account holds no role', async () => {
    resolveMeMock.mockResolvedValue({ principal: { id: 'p-1' }, identity: null });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveContextOwner({ oid: 'p-1' })).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['p-1', null]);
  });

  it('scopes the held contexts plus their variants, and lists only the held ones', async () => {
    resolveMeMock.mockResolvedValue({ principal: { id: 'p-1' }, identity: { id: 'i-1' } });
    query
      .mockResolvedValueOnce({ rows: [row(B, 'Accountable', 'Beta')] })
      .mockResolvedValueOnce({ rows: [{ id: V }] });
    const owner = await resolveContextOwner({ oid: 'p-1' });
    expect(owner.contexts.map(c => c.id)).toEqual([B]);
    expect([...owner.contextIds].sort()).toEqual([B, V]);
    expect(query.mock.calls[0][1]).toEqual(['p-1', 'i-1']);
    expect(query.mock.calls[1][1]).toEqual([[B]]);
  });

  it('treats a schema without the roles table as "no owner"', async () => {
    resolveMeMock.mockResolvedValue({ principal: { id: 'p-1' }, identity: null });
    query.mockRejectedValueOnce(Object.assign(new Error('relation "ContextRoles" does not exist'), { code: '42P01' }));
    expect(await resolveContextOwner({ oid: 'p-1' })).toBeNull();
  });

  it('lets any other database failure through (the middleware then fails closed)', async () => {
    resolveMeMock.mockResolvedValue({ principal: { id: 'p-1' }, identity: null });
    query.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));
    await expect(resolveContextOwner({ oid: 'p-1' })).rejects.toThrow('connection reset');
  });
});
