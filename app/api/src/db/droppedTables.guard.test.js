// Guard: no API code queries a table that a migration has dropped.
//
// Why: migration 117 dropped "GovernanceCatalogs". The business-role snapshot
// (composition review) still joined it, and its unit test pinned that SQL text
// against a mocked database, so CI stayed green while saving a review failed on
// every migrated database. Mocked-db tests cannot see a dropped table; this
// guard reads the migrations instead.
//
// A dropped table is one some migration creates and the migrations as a whole
// no longer have (readMigrationSchema), unless a view of the same name replaced
// it. Comment lines may still name it, to explain history.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { readMigrationSchema } from './migrationSchema.js';
import { repoRoot } from '../lib/repoRoot.js';

const SRC = join(repoRoot(), 'app', 'api', 'src');
const MIGRATIONS = join(SRC, 'db', 'migrations');

function allMigrationSql() {
  return readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n');
}

function names(sql, pattern) {
  return new Set([...sql.matchAll(pattern)].map(m => m[1]));
}

function droppedTables(sql, current) {
  const created = names(sql, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"/gi);
  const views = names(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"/gi);
  return [...created].filter(t => !current.has(t) && !views.has(t)).sort();
}

const COMMENT = /^\s*(\/\/|\*|\/\*)/;

/** [{ line, table }] for every non-comment line of `text` naming a dropped table in quotes. */
function referencesTo(text, tables) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (COMMENT.test(line)) return;
    for (const t of tables) if (line.includes(`"${t}"`)) hits.push({ line: i + 1, table: t });
  });
  return hits;
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' || e.name === '__mocks__' ? [] : sourceFiles(p);
    return e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [p] : [];
  });
}

const DROPPED = droppedTables(allMigrationSql(), readMigrationSchema().tables);

describe('dropped tables', () => {
  it('finds the tables the migrations dropped, and not one a view replaced', () => {
    expect(DROPPED).toContain('GovernanceCatalogs');
    // "GraphTags" was dropped as a table and recreated as a compatibility view.
    expect(DROPPED).not.toContain('GraphTags');
    expect(DROPPED).not.toContain('Contexts');
  });

  it('would have caught the snapshot query migration 117 broke', () => {
    const old = '      FROM "Resources" r\n      LEFT JOIN "GovernanceCatalogs" c ON c.id = r."catalogId"\n';
    expect(referencesTo(old, DROPPED)).toEqual([{ line: 2, table: 'GovernanceCatalogs' }]);
    expect(referencesTo('// the old LEFT JOIN on "GovernanceCatalogs" gave', DROPPED)).toEqual([]);
  });

  it('are named by no API code outside the migrations', () => {
    const hits = sourceFiles(SRC).flatMap(file => referencesTo(readFileSync(file, 'utf8'), DROPPED)
      .map(h => `${relative(SRC, file)}:${h.line} "${h.table}"`));
    expect(hits, 'These lines query a table a migration dropped. Read what replaced it (the migration that dropped it says) and use that.').toEqual([]);
  });
});
