import { describe, it, expect, vi } from 'vitest';
import { writeRun, CHUNK } from './writeRun.js';

const run = { id: 'run-9', mode: 'delta', triggeredBy: 'analyst@contoso.com' };
const source = { id: 'src-2', observedAt: '2026-10-01T00:00:00.000Z' };
const profile = { id: 'prof-v2', name: 'Projects' };

const ent = (entityType, canonicalKey, row = 1, attributes = {}) => ({
  entityType, canonicalKey, displayName: canonicalKey.toUpperCase(), attributes, sourceLocator: `row:${row}`, row,
});

// A client that answers by statement kind and records every call.
function fakeClient({ openEntities = [], openRelations = [], closed = { entities: 0, relations: 0 }, fail } = {}) {
  const calls = [];
  const kindOf = (sql) => {
    if (sql.includes('SELECT "id", "entityType"')) return 'openEntities';
    if (sql.includes('SELECT r."id"')) return 'openRelations';
    if (sql.includes('INSERT INTO "OrgEntities"')) return 'insertEntities';
    if (sql.includes('INSERT INTO "OrgRelations"')) return 'insertRelations';
    if (sql.includes('"validTo" = $2') && sql.includes('UPDATE "OrgRelations"')) return 'closeRelations';
    if (sql.includes('"validTo" = $2')) return 'closeEntities';
    if (sql.includes('UPDATE "OrgEntities"')) return 'updateEntities';
    return 'updateRelations';
  };
  const client = {
    query: vi.fn(async (sql, params) => {
      const kind = kindOf(sql);
      calls.push({ kind, params, rows: params[0]?.startsWith?.('[') ? JSON.parse(params[0]) : undefined });
      if (fail === kind) throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      if (kind === 'openEntities') return { rows: openEntities };
      if (kind === 'openRelations') return { rows: openRelations };
      if (kind === 'closeEntities') return { rowCount: closed.entities };
      if (kind === 'closeRelations') return { rowCount: closed.relations };
      return { rowCount: 0 };
    }),
  };
  return { client, calls, of: (kind) => calls.filter(c => c.kind === kind) };
}

describe('writeRun — entities', () => {
  it('inserts new entities as accepted imports and updates open ones in place', async () => {
    const f = fakeClient({ openEntities: [{ id: 'e-old', entityType: 'Project', canonicalKey: 'p-1' }] });
    const out = await writeRun({
      client: f.client, run, source, profile,
      entities: [ent('Project', 'p-1', 1, { budget: '5' }), ent('Project', 'p-2', 2), ent('Person', 'p-1', 2)],
      relations: [],
    });
    expect(out).toEqual({ entitiesInserted: 2, entitiesUpdated: 1, entitiesClosed: 0, relationsInserted: 0, relationsUpdated: 0, relationsClosed: 0 });

    expect(f.of('openEntities')[0].params).toEqual(['Projects']);
    const [upd] = f.of('updateEntities');
    expect(upd.rows).toEqual([{ id: 'e-old', displayName: 'P-1', attributes: { budget: '5' }, sourceLocator: 'row:1' }]);
    expect(upd.params.slice(1)).toEqual(['src-2', 'run-9', '2026-10-01T00:00:00.000Z', 'prof-v2']);

    const [ins] = f.of('insertEntities');
    expect(ins.rows.map(r => [r.entityType, r.canonicalKey])).toEqual([['Project', 'p-2'], ['Person', 'p-1']]);
    expect(ins.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ins.rows[0].id).not.toBe(ins.rows[1].id);
    expect(ins.params.slice(1)).toEqual(['src-2', 'run-9', '2026-10-01T00:00:00.000Z', 'prof-v2', 'analyst@contoso.com']);
  });

  it('sends nothing for an empty batch and splits big batches into CHUNK-sized statements', async () => {
    const f = fakeClient();
    const many = Array.from({ length: CHUNK + 1 }, (_, i) => ent('Project', `k${i}`, i + 1));
    await writeRun({ client: f.client, run: { ...run, triggeredBy: undefined }, source, profile, entities: many, relations: [] });
    expect(f.of('updateEntities')).toHaveLength(0);
    const inserts = f.of('insertEntities');
    expect(inserts.map(c => c.rows.length)).toEqual([CHUNK, 1]);
    expect(inserts[1].rows[0].canonicalKey).toBe(`k${CHUNK}`);
    expect(inserts[0].params[5]).toBeNull();
  });
});

describe('writeRun — relations', () => {
  it('resolves both sides to entity ids, updates an open relation and inserts a new one', async () => {
    const f = fakeClient({
      openEntities: [{ id: 'e-proj', entityType: 'Project', canonicalKey: 'p-1' }, { id: 'e-ann', entityType: 'Person', canonicalKey: 'ann' }],
      openRelations: [{ id: 'r-old', fromEntityId: 'e-proj', toEntityId: 'e-ann', predicate: 'owner' }],
    });
    const out = await writeRun({
      client: f.client, run, source, profile,
      entities: [ent('Project', 'p-1'), ent('Person', 'ann'), ent('Person', 'bob', 2)],
      relations: [
        { predicate: 'owner', fromType: 'Project', fromKey: 'p-1', toType: 'Person', toKey: 'ann', sourceLocator: 'row:1' },
        { predicate: 'sponsor', fromType: 'Project', fromKey: 'p-1', toType: 'Person', toKey: 'ann', sourceLocator: 'row:1' },
        { predicate: 'owner', fromType: 'Project', fromKey: 'p-1', toType: 'Person', toKey: 'bob', sourceLocator: 'row:2' },
        { predicate: 'owner', fromType: 'Project', fromKey: 'p-9', toType: 'Person', toKey: 'bob', sourceLocator: 'row:3' },
      ],
    });
    expect(out).toMatchObject({ relationsInserted: 2, relationsUpdated: 1 });
    expect(f.of('updateRelations')[0].rows).toEqual([{ id: 'r-old', sourceLocator: 'row:1' }]);
    expect(f.of('updateRelations')[0].params.slice(1)).toEqual(['src-2', 'run-9', '2026-10-01T00:00:00.000Z']);
    const inserted = f.of('insertRelations')[0];
    const bobId = f.of('insertEntities')[0].rows.find(r => r.canonicalKey === 'bob').id;
    expect(inserted.rows.map(r => [r.predicate, r.fromEntityId, r.toEntityId])).toEqual([
      ['sponsor', 'e-proj', 'e-ann'], ['owner', 'e-proj', bobId],
    ]);
    expect(inserted.params.slice(1)).toEqual(['src-2', 'run-9', '2026-10-01T00:00:00.000Z', 'analyst@contoso.com']);
  });
});

describe('writeRun — full vs delta', () => {
  it('a delta run closes nothing', async () => {
    const f = fakeClient({ closed: { entities: 7, relations: 3 } });
    const out = await writeRun({ client: f.client, run, source, profile, entities: [ent('Project', 'p-1')], relations: [] });
    expect(f.of('closeEntities')).toHaveLength(0);
    expect(f.of('closeRelations')).toHaveLength(0);
    expect(out.entitiesClosed).toBe(0);
    expect(out.relationsClosed).toBe(0);
  });

  it('a full run closes untouched entities and relations of the profile at observedAt', async () => {
    const f = fakeClient({ closed: { entities: 7, relations: 3 } });
    const out = await writeRun({ client: f.client, run: { ...run, mode: 'full' }, source, profile, entities: [], relations: [] });
    expect(out).toMatchObject({ entitiesClosed: 7, relationsClosed: 3 });
    expect(f.of('closeEntities')[0].params).toEqual(['Projects', '2026-10-01T00:00:00.000Z', 'run-9']);
    expect(f.of('closeRelations')[0].params).toEqual(['Projects', '2026-10-01T00:00:00.000Z', 'run-9']);
  });

  it('a full run reports zero when the driver gives no rowCount', async () => {
    const f = fakeClient({ closed: { entities: undefined, relations: undefined } });
    const out = await writeRun({ client: f.client, run: { ...run, mode: 'full' }, source, profile, entities: [], relations: [] });
    expect(out).toMatchObject({ entitiesClosed: 0, relationsClosed: 0 });
  });
});

describe('writeRun — errors', () => {
  it('turns a unique-key race into a sentence and keeps the cause', async () => {
    const f = fakeClient({ fail: 'insertEntities' });
    const err = await writeRun({ client: f.client, run, source, profile, entities: [ent('Project', 'p-1')], relations: [] }).catch(e => e);
    expect(err.message).toMatch(/Another run of this profile/);
    expect(err.cause.code).toBe('23505');
  });

  it('passes any other error through unchanged', async () => {
    const boom = new Error('connection lost');
    const client = { query: vi.fn().mockRejectedValue(boom) };
    await expect(writeRun({ client, run, source, profile, entities: [], relations: [] })).rejects.toBe(boom);
  });
});
