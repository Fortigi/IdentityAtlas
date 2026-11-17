// Reads the tables and foreign keys the migrations leave behind, from the SQL
// text alone (no database). Used by the table-classification guard test and the
// clean-database contract test, so both see the same schema.
//
// It understands the shapes the migrations use: CREATE TABLE [IF NOT EXISTS]
// "X" (…), DROP TABLE [IF EXISTS] "X", and ALTER TABLE "X" … REFERENCES "Y" …
// ON DELETE …. Temp tables are skipped. Files are applied in name order, and
// statements in the order they appear, so a table dropped and created again
// (Contexts, migration 018) ends up with only its later foreign keys.

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const NAME = String.raw`(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?`;
// eslint-disable-next-line security/detect-non-literal-regexp -- built from this file's own literals, never input
const STATEMENT = new RegExp(
  String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}\s*\(` +
  String.raw`|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${NAME}` +
  String.raw`|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}([^;]*);`,
  'gi',
);
// eslint-disable-next-line security/detect-non-literal-regexp -- built from this file's own literals, never input
const REFERENCE = new RegExp(String.raw`REFERENCES\s+${NAME}\s*\([^)]*\)(?:\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT))?`, 'gi');

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

// The text between the "(" at `open` and its matching ")".
function parenBody(sql, open) {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return sql.slice(open + 1, i);
  }
  return sql.slice(open + 1);
}

function referencesIn(child, text) {
  const out = [];
  for (const m of text.matchAll(REFERENCE)) {
    out.push({ child, parent: m[1], onDelete: (m[2] || 'NO ACTION').replace(/\s+/g, ' ').toUpperCase() });
  }
  return out;
}

/**
 * Apply migration texts in order. `files` is [{ name, sql }].
 * @returns {{ tables: Set<string>, foreignKeys: Array<{child, parent, onDelete}> }}
 */
export function schemaFromMigrations(files) {
  const tables = new Set();
  let foreignKeys = [];
  for (const { sql: raw } of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = stripComments(raw);
    for (const m of sql.matchAll(STATEMENT)) {
      const [whole, created, dropped, altered, alterBody] = m;
      if (created) {
        tables.add(created);
        foreignKeys = foreignKeys.filter(fk => fk.child !== created);
        foreignKeys.push(...referencesIn(created, parenBody(sql, m.index + whole.length - 1)));
      } else if (dropped) {
        tables.delete(dropped);
        foreignKeys = foreignKeys.filter(fk => fk.child !== dropped && fk.parent !== dropped);
      } else if (altered) {
        foreignKeys.push(...referencesIn(altered, alterBody));
      }
    }
  }
  return { tables, foreignKeys };
}

/** The schema the shipped migrations produce. */
export function readMigrationSchema(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .map(name => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
  return schemaFromMigrations(files);
}
