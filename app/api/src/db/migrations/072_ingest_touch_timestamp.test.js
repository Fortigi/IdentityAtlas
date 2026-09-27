import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '072_ingest_touch_timestamp.sql'), 'utf8');
// The executable half only. This migration's header quotes the very pattern it
// removes in order to explain why, so a scan over the raw text would flag the
// prose that documents the fix.
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

// Text-level guard over the two halves of this migration. Both are load-bearing
// in a way that is invisible on clean data:
//
//   * without the column, POST /ingest/reconcile refuses every entity table and
//     a streamed full sync can never delete anything;
//   * without the trigger rebuild, stamping that column turns every re-ingested
//     row into an audit "change" — millions of _history rows per sync and a
//     fake event on every entity Timeline.
//
// The behavioural proof (a real engine upsert leaving history untouched, and a
// reconcile removing only the untouched row) runs against PostgreSQL in
// app/api/src/ingest/reconcileStale.test.js's unit layer and the SQL crawler's
// integration test; what this file stops is a half of the migration being
// dropped or loosened.
describe('migration 072 — last-ingested stamp', () => {
  const RECONCILED = ['Principals', 'Resources', 'ResourceAssignments', 'ResourceRelationships'];

  it('adds "updatedAt" idempotently to every table the reconcile can target', () => {
    for (const t of RECONCILED) {
      expect(sql, `${t} must gain the column`)
        // eslint-disable-next-line security/detect-non-literal-regexp -- t is a table name from the RECONCILED constant, not input
        .toMatch(new RegExp(`ALTER TABLE "${t}"\\s+ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT now\\(\\)`));
    }
  });

  it('gives the column a default rather than leaving existing rows NULL', () => {
    // A NULL stamp is indistinguishable from "not touched by this run", so the
    // first reconcile after the migration would delete every pre-existing row
    // the crawler did not happen to re-send.
    const adds = sql.match(/ADD COLUMN IF NOT EXISTS "updatedAt"[^;]*/g) || [];
    expect(adds.length).toBeGreaterThanOrEqual(RECONCILED.length);
    for (const a of adds) expect(a, a).toContain('DEFAULT now()');
  });

  it('guards the one table that may not exist yet', () => {
    // PrincipalRelationships arrived in migration 057; a database older than it
    // must still apply this migration.
    expect(sql).toMatch(/to_regclass\('public\."PrincipalRelationships"'\) IS NOT NULL/);
  });

  it('rebuilds the history UPDATE trigger to ignore the stamp', () => {
    expect(code).toContain('DROP TRIGGER IF EXISTS trg_history_upd');
    expect(code).toMatch(/WHEN \(\(to_jsonb\(OLD\) - 'updatedAt'\) IS DISTINCT FROM \(to_jsonb\(NEW\) - 'updatedAt'\)\)/);
    // The bare whole-row comparison is exactly what this replaces — if it
    // survives in executable SQL, every sync writes history for every row.
    expect(code).not.toMatch(/WHEN \(OLD IS DISTINCT FROM NEW\)/);
  });

  it('keeps every table migration 022 tracked, so none silently loses its audit trail', () => {
    const tracked = readFileSync(join(__dirname, '022_history_composite_keys.sql'), 'utf8');
    const listOf = (text) => {
      const block = text.slice(text.indexOf('tracked text[] := ARRAY['));
      return (block.slice(0, block.indexOf(']')).match(/'([A-Za-z]+)'/g) || []).map(s => s.replace(/'/g, ''));
    };
    expect(listOf(sql).sort()).toEqual(listOf(tracked).sort());
  });

  it('only touches the UPDATE trigger — insert/delete history is left alone', () => {
    expect(sql).not.toContain('trg_history_ins_del');
  });

  it('indexes the reconcile lookup on (systemId, updatedAt)', () => {
    // The reconcile scans one system's rows by stamp; without this it is a
    // sequential scan of a table with tens of millions of rows.
    for (const t of RECONCILED) {
      expect(code, `${t} needs a reconcile index`)
        // eslint-disable-next-line security/detect-non-literal-regexp -- t is a table name from the RECONCILED constant, not input
        .toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS "[^"]+"\\s+ON "${t}" \\("systemId", "updatedAt"\\)`));
    }
  });

  it('applies after the migrations that create the tables it alters', () => {
    // Was "is the highest-numbered migration" — true only until the next one landed.
    // What matters is the order relative to the CREATE TABLE of each altered table.
    const files = readdirSync(__dirname).filter(f => f.endsWith('.sql'));
    for (const t of RECONCILED) {
      const creators = files.filter(f => readFileSync(join(__dirname, f), 'utf8').includes(`CREATE TABLE IF NOT EXISTS "${t}"`)
        || readFileSync(join(__dirname, f), 'utf8').includes(`CREATE TABLE "${t}"`));
      expect(creators.length, `no migration creates ${t}`).toBeGreaterThan(0);
      expect(Math.min(...creators.map(f => Number(f.slice(0, 3)))), t).toBeLessThan(72);
    }
  });
});
