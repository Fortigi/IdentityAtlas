// Unit tests for db/cleanDatabase.js against a scripted transaction client.
// Real-SQL behaviour (cascades, the row rules, history) is the contract test's
// job (contract-tests/cleanDatabase.contract.test.js); this pins the ORDER of
// the steps, what each one sends, and how the result is counted.

import { describe, it, expect } from 'vitest';
import { cleanDatabase, removalSteps, deleteSql, countedTables, reparentSql } from './cleanDatabase.js';
import { TABLE_CLASSIFICATION } from './tableClassification.js';

// before/after: row counts the two count queries report; deleted: rowCount per DELETE.
function scriptedClient({ before = {}, after = {}, deleted = {}, failOn = null } = {}) {
  const calls = [];
  let counts = 0;
  const client = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (failOn && sql.startsWith(failOn)) throw new Error('relation "secret_detail" does not exist');
      if (sql.startsWith('SELECT COALESCE(max(id), 0) AS m')) return { rows: [{ m: '17' }] };
      if (sql.includes(' UNION ALL ')) {
        const src = counts++ === 0 ? before : after;
        const tables = [...sql.matchAll(/SELECT '([^']+)' AS t/g)].map(m => m[1]);
        return { rows: tables.map(t => ({ t, n: String(src[t] ?? 0) })) };
      }
      const del = sql.match(/^DELETE FROM "([^"]+)"/);
      if (del && del[1] !== '_history') return { rows: [], rowCount: deleted[del[1]] ?? 0 };
      if (del) return { rows: [], rowCount: sql.includes('USING') ? 5 : 30 };
      if (sql.includes('FROM pg_class t')) return { rows: [{ tbl: 'Systems', col: 'id', seq: '"Systems_id_seq"' }] };
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

const indexOf = (calls, re) => calls.findIndex(c => re.test(c.sql));

describe('removalSteps / deleteSql', () => {
  it('deletes crawler and derived tables, plus kept tables that carry a row rule — never _history or curated work', () => {
    const tables = removalSteps().map(e => e.table);
    expect(tables).toContain('Principals');
    expect(tables).toContain('RiskScores');
    expect(tables).toContain('WorkerConfig'); // config, but crawl-state keys go
    expect(tables).not.toContain('_history');
    expect(tables).not.toContain('SavedMatrixFilters');
    expect(tables).not.toContain('ContextInterviews');
    // children before parents
    expect(tables.indexOf('ContextMembers')).toBeLessThan(tables.indexOf('Contexts'));
    expect(tables.indexOf('ContextRoles')).toBeLessThan(tables.indexOf('Principals'));
    expect(tables.indexOf('Principals')).toBeLessThan(tables.indexOf('Systems'));
  });

  it('empties a plain table whole and applies a row rule as its WHERE', () => {
    const byName = (t) => TABLE_CLASSIFICATION.find(e => e.table === t);
    expect(deleteSql(byName('Principals'))).toBe('DELETE FROM "Principals"');
    expect(deleteSql(byName('Systems'))).toBe(`DELETE FROM "Systems" WHERE "systemType" IS DISTINCT FROM 'Upload'`);
    expect(deleteSql({ table: 'we"ird' })).toBe('DELETE FROM "we""ird"');
  });

  it('counts before and after for every table except the ones emptied whole', () => {
    const counted = countedTables();
    expect(counted).toContain('Contexts');
    expect(counted).toContain('SavedMatrixFilters');
    expect(counted).not.toContain('Principals');
    expect(counted).not.toContain('_history');
  });

  it('reparents only kept contexts, and only from a parent that is removed', () => {
    const sql = reparentSql();
    const rule = TABLE_CLASSIFICATION.find(e => e.table === 'Contexts').removeWhere;
    expect(sql).toContain(`WHERE NOT (${rule})`);
    expect(sql).toContain(`"parentContextId" IN (SELECT id FROM "Contexts" WHERE ${rule})`);
  });
});

describe('cleanDatabase', () => {
  it('runs the steps in order: mark, count, reparent, deletes, history, crawl state, sequences, count', async () => {
    const client = scriptedClient();
    await cleanDatabase(client);
    const { calls } = client;
    const mark = indexOf(calls, /^SELECT COALESCE\(max\(id\), 0\) AS m FROM "_history"/);
    const reparent = indexOf(calls, /^UPDATE "Contexts" SET "parentContextId" = NULL/);
    const firstDelete = indexOf(calls, /^DELETE FROM "ResourceAssignments"/);
    const lastDelete = indexOf(calls, /^DELETE FROM "WorkerConfig"/);
    const history = indexOf(calls, /^DELETE FROM "_history" WHERE "tableName" = ANY/);
    const sync = indexOf(calls, /"configKey" = 'syncVersion'/);
    const seq = indexOf(calls, /^SELECT setval/);
    expect(mark).toBe(0);
    expect(mark < reparent && reparent < firstDelete && firstDelete < lastDelete && lastDelete < history && history < sync && sync < seq).toBe(true);
    expect(calls.filter(c => c.sql.includes(' UNION ALL '))).toHaveLength(2);
  });

  it('removes all history of a table emptied whole, and the history of exactly the rows it deleted for the rest', async () => {
    const client = scriptedClient();
    const out = await cleanDatabase(client);
    const whole = client.calls.find(c => /^DELETE FROM "_history" WHERE "tableName" = ANY/.test(c.sql));
    expect(whole.params[0]).toContain('Principals');
    expect(whole.params[0]).not.toContain('Contexts');
    expect(whole.params[0]).not.toContain('Systems');
    expect(whole.params[0]).not.toContain('RiskScores');
    const rows = client.calls.find(c => /^DELETE FROM "_history" h/.test(c.sql));
    expect(rows.params).toEqual([17]); // only the 'D' rows written after the mark
    expect(rows.sql).toContain(`operation = 'D'`);
    expect(out.historyRowsRemoved).toBe(35);
  });

  it('advances syncVersion only when it holds a number, and resets the crawler configs', async () => {
    const client = scriptedClient();
    await cleanDatabase(client);
    expect(client.calls.find(c => c.sql.includes(`'syncVersion'`)).sql).toContain(`"configValue" ~ '^[0-9]+$'`);
    expect(client.calls.some(c => c.sql === `UPDATE "CrawlerConfigs" SET "lastRunAt" = NULL, "lastRunStatus" = NULL`)).toBe(true);
  });

  it('restarts a sequence after the highest id left, not at 1', async () => {
    const client = scriptedClient();
    await cleanDatabase(client);
    const setval = client.calls.find(c => c.sql.startsWith('SELECT setval'));
    expect(setval.sql).toBe('SELECT setval($1::regclass, COALESCE((SELECT max("id") FROM "Systems"), 0) + 1, false)');
    expect(setval.params).toEqual(['"Systems_id_seq"']);
    const lookup = client.calls.find(c => c.sql.includes('FROM pg_class t'));
    expect(lookup.params[0]).toEqual(removalSteps().map(e => e.table));
  });

  it('reports removed rows per table and the kept tables that lost rows through a cascade', async () => {
    const client = scriptedClient({
      deleted: { Principals: 12, Contexts: 3 },
      before: { Contexts: 10, ContextMembers: 50, SystemOwners: 3, SavedMatrixFilters: 4 },
      after: { Contexts: 6, ContextMembers: 20, SystemOwners: 1, SavedMatrixFilters: 4 },
    });
    const out = await cleanDatabase(client);
    const wiped = Object.fromEntries(out.wiped.map(w => [w.table, w.rowsAffected]));
    expect(wiped.Principals).toBe(12);       // whole table: the DELETE's own count
    expect(wiped.Contexts).toBe(4);          // row rule: before − after, cascades included
    expect(wiped.ContextMembers).toBe(30);
    expect(out.alsoRemoved).toEqual([{ table: 'SystemOwners', rowsAffected: 2 }]);
    expect(out.touched).toEqual(removalSteps().map(e => e.table));
  });

  it('stops at the first failing statement and lets the error reach the transaction', async () => {
    const client = scriptedClient({ failOn: 'DELETE FROM "Principals"' });
    await expect(cleanDatabase(client)).rejects.toThrow(/secret_detail/);
    expect(client.calls.some(c => c.sql.startsWith('DELETE FROM "Systems"'))).toBe(false);
    expect(client.calls.some(c => c.sql.startsWith('DELETE FROM "_history"'))).toBe(false);
    expect(client.calls.some(c => c.sql.startsWith('UPDATE "CrawlerConfigs"'))).toBe(false);
  });

  it('treats an empty history table as mark 0, so every D row it writes counts as this clean\'s', async () => {
    const client = scriptedClient();
    const real = client.query.bind(client);
    client.query = async (sql, params) => (sql.startsWith('SELECT COALESCE(max(id), 0) AS m') ? { rows: [] } : real(sql, params));
    await cleanDatabase(client);
    expect(client.calls.find(c => /^DELETE FROM "_history" h/.test(c.sql)).params).toEqual([0]);
  });
});
