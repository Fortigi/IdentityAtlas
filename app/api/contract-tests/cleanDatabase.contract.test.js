// Contract test — Admin → Data → Clean database against the real schema.
//
// The rule: a clean removes everything a crawler or plugin can recreate and
// nothing a person made; person-made work that hangs on removed data goes and
// the dialog names it. db/tableClassification.js states it per table. This test
// seeds a row in EVERY table the migrations create (test-utils/cleanDatabaseSeed.js),
// runs the real endpoint, and checks each row — so a new table is covered the
// moment it is classified, and an FK cascade nobody listed shows up here.
//
// It also proves the clean is one transaction: with a DELETE made to fail, the
// call answers 500 without SQL detail and nothing is removed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';
import { seedEverything } from '../test-utils/cleanDatabaseSeed.js';
import { readMigrationSchema } from '../src/db/migrationSchema.js';
import { TABLE_CLASSIFICATION, ALSO_REMOVED, isRemovedLabel, classificationOf } from '../src/db/tableClassification.js';

const CONFIRM = { confirm: 'DELETE ALL DATA' };
let agent, pool, seeded, failed, cleaned;

const count = async (table, where = 'TRUE', params = []) =>
  Number((await pool.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, params)).rows[0].n);

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  seeded = await seedEverything((sql, params) => pool.query(sql, params));

  // 1. Make the clean fail half-way: a DELETE on the sync log raises.
  await pool.query(`CREATE OR REPLACE FUNCTION clean_db_contract_fail() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'clean_db_contract_secret_detail'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER clean_db_contract_fail BEFORE DELETE ON "GraphSyncLog" FOR EACH ROW EXECUTE FUNCTION clean_db_contract_fail()`);
  failed = await agent.post('/api/admin/clean-database').send(CONFIRM);
  failed.counts = {
    principals: await count('Principals', 'id = $1', [seeded.expectations.find(e => e.table === 'Principals').params[0]]),
    contexts: await count('Contexts'),
    history: await count('_history'),
  };
  await pool.query(`DROP TRIGGER clean_db_contract_fail ON "GraphSyncLog"`);
  await pool.query(`DROP FUNCTION clean_db_contract_fail()`);

  // 2. The real clean.
  cleaned = await agent.post('/api/admin/clean-database').send(CONFIRM);
});

afterAll(async () => {
  // The clean schedules a matrix-view rebuild in this process; let it finish
  // before the next file gets the database.
  const { viewRefresh } = await import('../src/routes/ingest/matrixViews.js');
  await viewRefresh.whenIdle();
  await pool.end();
  delete process.env.USE_SQL;
});

describe('a clean that fails half-way', () => {
  it('answers 500 without SQL detail', () => {
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Clean database failed. Nothing was removed.' });
    expect(JSON.stringify(failed.body)).not.toContain('secret_detail');
  });

  it('removes nothing — the deletes before the failing one are rolled back', () => {
    // Principals is deleted before GraphSyncLog in the classification order.
    expect(failed.counts.principals).toBe(1);
    expect(failed.counts.contexts).toBeGreaterThanOrEqual(7);
  });
});

describe('the seed covers every table', () => {
  it('has a row with an expectation for every table the migrations create', () => {
    const covered = new Set(seeded.expectations.map(e => e.table));
    const missing = [...readMigrationSchema().tables].filter(t => !covered.has(t));
    expect(missing, 'Seed a row for each in test-utils/cleanDatabaseSeed.js and say whether a clean keeps it').toEqual([]);
  });

  it('expects of each table only what its classification allows', () => {
    const named = new Set(ALSO_REMOVED.flatMap(a => a.tables));
    const wrong = seeded.expectations.filter(e => {
      const c = classificationOf(e.table);
      const whole = isRemovedLabel(c.label) && !c.removeWhere;
      if (whole) return e.expect !== 'removed';
      const mayLose = isRemovedLabel(c.label) || c.removeWhere || named.has(e.table) || e.table === '_history';
      return e.expect === 'removed' && !mayLose;
    });
    expect(wrong.map(e => `${e.table}: ${e.where} → ${e.expect}`)).toEqual([]);
  });
});

describe('a clean', () => {
  it('answers 200 with what it removed', () => {
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.message).toBe('Database cleaned');
    const wiped = Object.fromEntries(cleaned.body.wiped.map(w => [w.table, w.rowsAffected]));
    expect(wiped.Principals).toBeGreaterThanOrEqual(2);
    expect(wiped.Contexts).toBeGreaterThanOrEqual(3);
    expect(cleaned.body.historyRowsRemoved).toBeGreaterThan(0);
  });

  it('names in alsoRemoved the kept tables that lost rows through a cascade, and only those', () => {
    const named = new Set(ALSO_REMOVED.flatMap(a => a.tables));
    const lost = cleaned.body.alsoRemoved.map(a => a.table);
    expect(lost.filter(t => !named.has(t) && !classificationOf(t).removeWhere)).toEqual([]);
    for (const t of ['SystemOwners', 'ManagerHierarchyOverrides', 'ContextInterviews', 'ContextTreeAdjustments', 'WorkbenchInvestigations']) {
      expect(lost, t).toContain(t);
    }
    expect(lost).not.toContain('SavedMatrixFilters');
  });

  it('does to every seeded row what the classification says', async () => {
    const wrong = [];
    for (const e of seeded.expectations) {
      const n = await count(e.table, e.where, e.params);
      if (e.expect === 'kept' ? n < 1 : n !== 0) wrong.push(`${e.table} WHERE ${e.where} ${JSON.stringify(e.params)}: expected ${e.expect}, found ${n}`);
    }
    expect(wrong).toEqual([]);
  });

  it('empties every table it removes whole', async () => {
    const notEmpty = [];
    for (const e of TABLE_CLASSIFICATION.filter(c => isRemovedLabel(c.label) && !c.removeWhere)) {
      const n = await count(e.table);
      if (n !== 0) notEmpty.push(`${e.table}: ${n}`);
    }
    expect(notEmpty).toEqual([]);
  });

  it('leaves no history of a table it removed whole', async () => {
    const whole = TABLE_CLASSIFICATION.filter(c => isRemovedLabel(c.label) && !c.removeWhere).map(c => c.table);
    expect(await count('_history', '"tableName" = ANY($1::text[])', [whole])).toBe(0);
  });

  it('restarts the Systems sequence right after the kept uploaded list', async () => {
    const max = Number((await pool.query(`SELECT max(id) AS m FROM "Systems"`)).rows[0].m);
    expect(max).toBeGreaterThanOrEqual(seeded.systems.sUpload);
    const { rows } = await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','after-clean') RETURNING id`);
    expect(rows[0].id).toBe(max + 1);
    await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [rows[0].id]);
  });
});
