// Unit tests for the staged full load (ingest/stages.js). The DB is SQL-blind
// here by design; these pin the DECISIONS — which path finalize takes, when it
// falls back, what a keys-only stage does, which rows an update may touch. The SQL
// semantics are proven against PostgreSQL in contract-tests/stagedLoad.contract.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqls, handlers, clientQuery } = vi.hoisted(() => {
  const sqls = [];
  const handlers = [];   // [regex, fn(sql) → result]
  const clientQuery = async (sql) => {
    const s = String(sql);
    sqls.push(s);
    for (const [re, fn] of handlers) if (re.test(s)) return fn(s);
    return { rows: [], rowCount: 0 };
  };
  return { sqls, handlers, clientQuery };
});

vi.mock('../db/connection.js', () => ({
  query: (sql, p) => clientQuery(sql, p),
  tx: async (fn) => fn({ query: (sql, p) => clientQuery(sql, p) }),
}));

const cols = (...names) => names.map(name => ({ name, sqlTypeName: name.endsWith('Id') ? 'uuid' : 'text' }));
const engine = vi.hoisted(() => ({
  resolveActiveColumns: vi.fn(),
  discoverColumns: vi.fn(),
  scopedDelete: vi.fn(async () => 3),
}));
vi.mock('./engine.js', () => ({ ...engine, SOFT_DELETE_TABLES: new Set(['ResourceAssignments']) }));

const S = await import('./stages.js');

const RA_KEYS = ['resourceId', 'principalId', 'assignmentType', 'governed'];
const open = (over = {}) => S.openStage({
  tableName: 'ResourceAssignments', keyColumns: RA_KEYS, systemId: 7, ownerId: 1,
  conflictFilter: '"principalId" IS NOT NULL', scopeDeleteFilter: '"principalId" IS NOT NULL', ...over,
});
const rec = { resourceId: 'r', principalId: 'p', assignmentType: 'Direct', governed: false, systemId: 7 };

beforeEach(() => {
  sqls.length = 0;
  handlers.length = 0;
  S._stagesForTest().clear();
  engine.resolveActiveColumns.mockResolvedValue(cols('resourceId', 'principalId', 'assignmentType', 'governed', 'systemId', 'resourceType'));
  engine.discoverColumns.mockResolvedValue(cols('resourceId', 'principalId', 'assignmentType', 'governed', 'systemId', 'resourceType', 'deletedAt', 'updatedAt'));
  engine.scopedDelete.mockClear();
});

describe('stage lifecycle', () => {
  it('creates the unlogged stage table once, on the first batch, and counts rows', async () => {
    const st = open();
    await S.appendToStage(st, [rec, rec]);
    await S.appendToStage(st, [rec]);
    expect(sqls.filter(s => /CREATE UNLOGGED TABLE/.test(s))).toHaveLength(1);
    expect(sqls.find(s => /CREATE UNLOGGED TABLE/.test(s))).toContain(`"${st.stageTable}"`);
    expect(st.rows).toBe(3);
  });

  it('an empty batch writes nothing', async () => {
    const st = open();
    await expect(S.appendToStage(st, [])).resolves.toEqual({ rows: 0 });
    expect(sqls).toHaveLength(0);
  });

  it('refuses a later batch that adds a table column the stage does not have', async () => {
    const st = open();
    await S.appendToStage(st, [rec]);
    await expect(S.appendToStage(st, [{ ...rec, deletedAt: null }])).rejects.toMatchObject({ status: 400 });
    // a key the table does not know is left to the normalizer, not refused here
    await expect(S.appendToStage(st, [{ ...rec, somethingElse: 1 }])).resolves.toEqual({ rows: 2 });
  });

  it('only the crawler that opened a stage may use it', () => {
    const st = open();
    expect(S.getStage(st.id, 1)).toBe(st);
    expect(() => S.getStage(st.id, 2)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => S.getStage('nope', 1)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('expires stages older than six hours when a new one opens, dropping their tables', async () => {
    const old = open({ now: 0 });
    open({ now: 6 * 60 * 60 * 1000 + 1 });
    await new Promise(r => setTimeout(r, 0));
    expect(S._stagesForTest().has(old.id)).toBe(false);
    expect(sqls).toContain(`DROP TABLE IF EXISTS "${old.stageTable}"`);
  });

  it('abort drops the table and forgets the stage', async () => {
    const st = open();
    await S.abortStage(st);
    expect(S._stagesForTest().has(st.id)).toBe(false);
    expect(sqls).toContain(`DROP TABLE IF EXISTS "${st.stageTable}"`);
  });

  it('drops every leftover stage table at startup', async () => {
    handlers.push([/FROM pg_tables/, () => ({ rows: [{ tablename: '_stage_a' }, { tablename: '_stage_b' }] })]);
    await expect(S.dropAbandonedStages()).resolves.toBe(2);
    expect(sqls).toContain('DROP TABLE IF EXISTS "_stage_a"');
    expect(sqls).toContain('DROP TABLE IF EXISTS "_stage_b"');
  });
});

describe('finalize — the empty-table path', () => {
  it('drops the non-constraint indexes, inserts bare, rebuilds them — only after an exclusive lock proved the table empty', async () => {
    handlers.push([/SELECT NOT EXISTS \(SELECT 1 FROM "ResourceAssignments"\)/, () => ({ rows: [{ empty: true }] })]);
    handlers.push([/FROM pg_indexes/, () => ({ rows: [
      { indexname: 'ix_a', indexdef: 'CREATE INDEX ix_a ON public."ResourceAssignments" USING btree ("resourceId")' },
      { indexname: 'uq_b', indexdef: 'CREATE UNIQUE INDEX uq_b ON public."ResourceAssignments" USING btree ("resourceId", "principalId")' },
    ] })]);
    handlers.push([/^\s*INSERT INTO "ResourceAssignments"/, () => ({ rowCount: 2 })]);
    const st = open();
    await S.appendToStage(st, [rec]);
    const r = await S.finalizeStage(st, { deleteMissing: true });
    expect(r).toMatchObject({ path: 'empty-table', inserted: 2, updated: 0, deleted: 0 });
    const at = (re) => sqls.findIndex(s => re.test(s));
    expect(at(/LOCK TABLE "ResourceAssignments" IN ACCESS EXCLUSIVE MODE/)).toBeGreaterThan(-1);
    expect(at(/lock_timeout = '5s'/)).toBeLessThan(at(/LOCK TABLE/));
    expect(at(/LOCK TABLE/)).toBeLessThan(at(/SELECT NOT EXISTS/));
    expect(at(/DROP INDEX "ix_a"/)).toBeGreaterThan(at(/SELECT NOT EXISTS/));
    expect(at(/DROP INDEX "uq_b"/)).toBeLessThan(at(/^\s*INSERT INTO "ResourceAssignments"/));
    expect(at(/CREATE INDEX ix_a/)).toBeGreaterThan(at(/^\s*INSERT INTO "ResourceAssignments"/));
    expect(at(/CREATE UNIQUE INDEX uq_b/)).toBeGreaterThan(at(/^\s*INSERT INTO "ResourceAssignments"/));
    expect(engine.scopedDelete).not.toHaveBeenCalled();   // nothing to delete from an empty table
    expect(sqls.at(-1)).toBe(`DROP TABLE IF EXISTS "${st.stageTable}"`);
  });

  it('falls back to a merge when the table is not empty — releasing the lock first', async () => {
    handlers.push([/SELECT NOT EXISTS \(SELECT 1 FROM "ResourceAssignments"\)/, () => ({ rows: [{ empty: false }] })]);
    const st = open();
    await S.appendToStage(st, [rec]);
    const r = await S.finalizeStage(st);
    expect(r.path).toBe('merge');
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT empty_table_probe');
    expect(sqls.some(s => /DROP INDEX/.test(s))).toBe(false);
  });

  it('falls back to a merge — fail closed — when the lock is not granted in time', async () => {
    handlers.push([/LOCK TABLE/, () => { throw new Error('canceling statement due to lock timeout'); }]);
    const st = open();
    await S.appendToStage(st, [rec]);
    const r = await S.finalizeStage(st);
    expect(r.path).toBe('merge');
    expect(sqls.some(s => /SELECT NOT EXISTS/.test(s))).toBe(false);
    expect(sqls.some(s => /DROP INDEX/.test(s))).toBe(false);
  });
});

describe('finalize — the merge path', () => {
  beforeEach(() => {
    handlers.push([/SELECT NOT EXISTS \(SELECT 1 FROM "ResourceAssignments"\)/, () => ({ rows: [{ empty: false }] })]);
  });

  it('inserts only keys the table lacks, and updates only rows whose values differ', async () => {
    handlers.push([/^\s*INSERT INTO "ResourceAssignments"/, () => ({ rowCount: 5 })]);
    handlers.push([/^\s*UPDATE "ResourceAssignments" t SET/, () => ({ rowCount: 2 })]);
    const st = open();
    await S.appendToStage(st, [rec]);
    const r = await S.finalizeStage(st, { deleteMissing: true });
    expect(r).toMatchObject({ path: 'merge', inserted: 5, updated: 2, deleted: 3 });
    const ins = sqls.find(s => /^\s*INSERT INTO "ResourceAssignments"/.test(s));
    expect(ins).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM "ResourceAssignments" t WHERE t\."resourceId" = s\."resourceId"/);
    expect(ins).toContain('AND (t."principalId" IS NOT NULL)');
    expect(ins).toContain('ON CONFLICT ("resourceId", "principalId", "assignmentType", "governed") WHERE "principalId" IS NOT NULL DO NOTHING');
    const upd = sqls.find(s => /^\s*UPDATE "ResourceAssignments" t SET/.test(s));
    // only non-key columns are compared; a key column never appears in the change test
    expect(upd).toContain('t."resourceType" IS DISTINCT FROM s."resourceType"');
    expect(upd).toContain('t."systemId" IS DISTINCT FROM s."systemId"');
    expect(upd).not.toContain('t."principalId" IS DISTINCT FROM');
    // a tombstoned row that is back gets revived; the stamp goes on written rows only
    expect(upd).toContain('t."deletedAt" IS NOT NULL');
    expect(upd).toContain('"deletedAt" = NULL');
    expect(upd).toContain('"updatedAt" = now()');
    expect(engine.scopedDelete).toHaveBeenCalledWith(
      expect.anything(), 'ResourceAssignments', RA_KEYS, st.stageTable, 7, {}, 'systemId',
      expect.any(Set), '"principalId" IS NOT NULL', null);
  });

  it('does not delete anything unless asked', async () => {
    const st = open();
    await S.appendToStage(st, [rec]);
    const r = await S.finalizeStage(st);
    expect(r.deleted).toBe(0);
    expect(engine.scopedDelete).not.toHaveBeenCalled();
  });

  it('a column the directory owns is never overwritten or compared', async () => {
    const st = open({ preserveColumns: ['systemId'] });
    await S.appendToStage(st, [rec]);
    await S.finalizeStage(st);
    const upd = sqls.find(s => /^\s*UPDATE "ResourceAssignments" t SET/.test(s));
    expect(upd).not.toContain('"systemId" = s."systemId"');
    expect(upd).not.toContain('t."systemId" IS DISTINCT FROM');
  });

  it('a keys-only stage (a key sweep) neither inserts nor updates — it only removes what is missing', async () => {
    engine.resolveActiveColumns.mockResolvedValue(cols(...RA_KEYS));
    const st = open();
    await S.appendToStage(st, [{ resourceId: 'r', principalId: 'p', assignmentType: 'Direct', governed: false }]);
    const r = await S.finalizeStage(st, { deleteMissing: true });
    expect(r).toMatchObject({ path: 'merge', inserted: 0, updated: 0, deleted: 3 });
    expect(sqls.some(s => /LOCK TABLE/.test(s))).toBe(false);   // never the index-rebuild path
    expect(sqls.some(s => /^\s*(INSERT INTO "ResourceAssignments"|UPDATE)/.test(s))).toBe(false);
  });

  it('an empty stage is a no-op and still cleans up', async () => {
    const st = open();
    const r = await S.finalizeStage(st, { deleteMissing: true });
    expect(r).toEqual({ path: 'empty-stage', inserted: 0, updated: 0, deleted: 0, rows: 0 });
    expect(engine.scopedDelete).not.toHaveBeenCalled();
    expect(S._stagesForTest().has(st.id)).toBe(false);
  });
});
