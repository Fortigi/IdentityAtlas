import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { loadEntities, loadRelations, loadLinks, loadProjectionInput } from './projectionSql.js';

beforeEach(() => { query.mockReset(); });

// The mock is SQL-blind, so these tests pin the parts of the SQL text that carry
// the projection's rules; the contract tests check the SQL itself.
describe('projection queries', () => {
  it('loads only accepted, open entities', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'e1' }] });
    expect(await loadEntities()).toEqual([{ id: 'e1' }]);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/FROM "OrgEntities"/);
    expect(sql).toMatch(/e\.status = 'accepted' AND e\."validTo" IS NULL/);
  });

  it('loads only accepted, open relations', async () => {
    query.mockResolvedValueOnce({ rows: [{ fromEntityId: 'a', toEntityId: 'b' }] });
    expect(await loadRelations()).toEqual([{ fromEntityId: 'a', toEntityId: 'b' }]);
    expect(query.mock.calls[0][0]).toMatch(/r\.status = 'accepted' AND r\."validTo" IS NULL/);
  });

  it('loads accepted, not analyst-rejected links of live entities, identities expanded', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await loadLinks()).toEqual([]);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/l\.status = 'accepted'/);
    expect(sql).toMatch(/l\."analystOverride" IS DISTINCT FROM 'rejected'/);
    expect(sql).toMatch(/e\.status = 'accepted' AND e\."validTo" IS NULL/);
    expect(sql).toMatch(/LEFT JOIN "IdentityMembers" im/);
    expect(sql).toMatch(/im\."analystOverride" IS DISTINCT FROM 'rejected'/);
  });

  it('loadProjectionInput runs the three queries in order', async () => {
    query
      .mockResolvedValueOnce({ rows: ['E'] })
      .mockResolvedValueOnce({ rows: ['R'] })
      .mockResolvedValueOnce({ rows: ['L'] });
    expect(await loadProjectionInput()).toEqual({ entities: ['E'], relations: ['R'], links: ['L'] });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
