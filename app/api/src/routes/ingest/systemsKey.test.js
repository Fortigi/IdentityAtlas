// A system without a tenant is identified by (systemType, displayName)
// (migration 074). Before that, its registration conflicted on
// (systemType, tenantId), which never fires for a NULL tenant, so every re-run of
// a CSV crawler inserted each of its systems again and re-homed all their rows.
// Unit layer: which key each record is upserted and looked up by. The real
// constraint behaviour is in contract-tests/crawlerRerun.contract.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('../../ingest/engine.js', () => ({
  ingest: vi.fn(async (_p, _t, _k, records) => ({ inserted: records.length, updated: 1, deleted: 0 })),
  SOFT_DELETE_TABLES: new Set(),
}));

import * as db from '../../db/connection.js';
import { ingest } from '../../ingest/engine.js';
import { ingestBatch, lookupSystemIds, TENANTLESS_SYSTEM_KEY, TENANTLESS_SYSTEM_FILTER } from './helpers.js';

const SYSTEMS_KEY = ['systemType', 'tenantId'];
const entra = { systemType: 'EntraID', displayName: 'Contoso', tenantId: 't-1' };
const hr = { systemType: 'CSV', displayName: 'HR', tenantId: null };
const fin = { systemType: 'CSV', displayName: 'Finance' };

beforeEach(() => {
  ingest.mockClear();
  db.queryOne.mockReset();
});

describe('ingestBatch — systems', () => {
  it('upserts tenant systems on (systemType, tenantId) and tenant-less ones on (systemType, displayName)', async () => {
    const res = await ingestBatch('systems', 'Systems', SYSTEMS_KEY, [entra, hr, fin], { syncMode: 'delta', conflictFilter: null });
    expect(ingest).toHaveBeenCalledTimes(2);
    const [withTenant, tenantless] = ingest.mock.calls;
    expect(withTenant[2]).toEqual(SYSTEMS_KEY);
    expect(withTenant[3]).toEqual([entra]);
    expect(withTenant[4].conflictFilter).toBeNull();
    expect(tenantless[2]).toEqual(['systemType', 'displayName']);
    expect(tenantless[3]).toEqual([hr, fin]);
    expect(tenantless[4].conflictFilter).toBe('"tenantId" IS NULL');
    expect(tenantless[4].syncMode).toBe('delta');
    // Totals are the sum of both groups.
    expect(res).toEqual({ inserted: 3, updated: 2, deleted: 0 });
  });

  it('makes one call when every system has a tenant', async () => {
    await ingestBatch('systems', 'Systems', SYSTEMS_KEY, [entra], {});
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][2]).toEqual(SYSTEMS_KEY);
  });

  it('writes nothing for an empty systems batch', async () => {
    expect(await ingestBatch('systems', 'Systems', SYSTEMS_KEY, [], {})).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('passes any other entity straight through', async () => {
    const recs = [{ id: 'a' }];
    const opts = { syncMode: 'full', conflictFilter: 'x' };
    await ingestBatch('principals', 'Principals', ['id'], recs, opts);
    expect(ingest).toHaveBeenCalledWith(null, 'Principals', ['id'], recs, opts);
  });

  it('exports the key and predicate migration 074 indexes', () => {
    expect(TENANTLESS_SYSTEM_KEY).toEqual(['systemType', 'displayName']);
    expect(TENANTLESS_SYSTEM_FILTER).toBe('"tenantId" IS NULL');
  });
});

describe('lookupSystemIds — by the key the upsert used', () => {
  it('finds a tenant-less system by type and name, among tenant-less systems only', async () => {
    db.queryOne.mockResolvedValue({ id: 5 });
    expect(await lookupSystemIds('systems', [fin])).toEqual([5]);
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toContain('"systemType" = $1 AND "displayName" = $2 AND "tenantId" IS NULL');
    expect(params).toEqual(['CSV', 'Finance']);
  });

  it('finds a tenant system by tenant and type', async () => {
    db.queryOne.mockResolvedValue({ id: 9 });
    await lookupSystemIds('systems', [entra]);
    expect(db.queryOne.mock.calls[0][1]).toEqual(['t-1', 'EntraID']);
  });

  it('falls back to the display name alone only when the record has no type', async () => {
    db.queryOne.mockResolvedValue({ id: 3 });
    await lookupSystemIds('systems', [{ displayName: 'Legacy' }]);
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toContain('WHERE "displayName" = $1 ORDER BY id DESC');
    expect(params).toEqual(['Legacy']);
  });

  it('skips a record with neither key', async () => {
    expect(await lookupSystemIds('systems', [{ systemType: 'CSV' }])).toBeUndefined();
    expect(db.queryOne).not.toHaveBeenCalled();
  });
});
