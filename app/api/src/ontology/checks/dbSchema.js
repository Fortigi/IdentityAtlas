// Agreement between the ontology and a migrated PostgreSQL schema.
//
// Pure: it takes rows from information_schema.columns and pg_constraint (the
// contract test queries a real database migrated from scratch and passes them
// in), so the comparison itself is unit-tested without a database.
//
//   - every column of every core table is described, with the same SQL type;
//   - every described column exists;
//   - every `col IN (…)` CHECK constraint on a core table admits exactly the
//     closed list the ontology declares for that column.

import { columnsOf, tableClasses, valueSetFor } from '../model.js';

const err = (code, subject, message) => ({ code, subject, message });

// pg_get_constraintdef renders `"col" IN ('a','b')` as
//   CHECK (("col" = ANY (ARRAY['a'::text, 'b'::text])))
// (unquoted for an all-lowercase column). NOT IN renders as `<> ALL (…)` and is
// a deny-list, which says nothing about the allowed values, so it is skipped.
const IN_LIST = /^CHECK \(\(+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*ANY\s*\(+ARRAY\[(.*)\]\)+.*$/;

/** Parse one constraint definition into { column, values } or null. */
export function parseInListCheck(definition) {
  const m = IN_LIST.exec(String(definition).trim());
  if (!m) return null;
  const values = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map(v => v[1].replace(/''/g, "'"));
  return values.length ? { column: m[1], values } : null;
}

function sameSet(a, b) {
  return a.length === b.length && a.every(v => b.includes(v));
}

function checkColumns(model, cls, dbCols) {
  const out = [];
  const described = new Map(columnsOf(model, cls.local).map(p => [p.local, p]));
  for (const [name, type] of dbCols) {
    const subject = `${cls.table}.${name}`;
    if (name === cls.identifierColumn) {
      if (type !== cls.identifierSqlType) out.push(err('db-identifier-type', subject, `is ${type}, the ontology says ${cls.identifierSqlType}`));
      continue;
    }
    const prop = described.get(name);
    if (!prop) out.push(err('db-column-undescribed', subject, `exists in the database (${type}) but ia:${cls.local} has no column property "${name}"`));
    else if (prop.sqlType !== type) out.push(err('db-column-type', subject, `is ${type} in the database, ia:${name} says ${prop.sqlType}`));
  }
  for (const name of described.keys()) {
    if (!dbCols.has(name)) out.push(err('db-column-missing', `${cls.table}.${name}`, `ia:${name} is described for ia:${cls.local} but the table has no such column`));
  }
  if (cls.identifierColumn && !dbCols.has(cls.identifierColumn)) {
    out.push(err('db-column-missing', `${cls.table}.${cls.identifierColumn}`, 'the identifier column does not exist'));
  }
  return out;
}

function checkConstraints(model, cls, defs) {
  const out = [];
  for (const def of defs) {
    const parsed = parseInListCheck(def);
    if (!parsed) continue;
    const subject = `${cls.table}.${parsed.column}`;
    const declared = valueSetFor(model, cls.local, parsed.column);
    if (declared === null) {
      out.push(err('db-check-not-in-ontology', subject, `the database admits only [${parsed.values.join(', ')}] but the ontology declares no closed list`));
    } else if (!sameSet(declared, parsed.values)) {
      out.push(err('db-check-mismatch', subject, `the database admits [${parsed.values.join(', ')}], the ontology declares [${declared.join(', ')}]`));
    }
  }
  return out;
}

/**
 * @param model        buildModel() result
 * @param columns      rows { table_name, column_name, data_type }
 * @param constraints  rows { table_name, definition } (CHECK constraints)
 */
export function compareDbSchema(model, columns, constraints) {
  const out = [];
  for (const cls of tableClasses(model)) {
    const dbCols = new Map(columns.filter(c => c.table_name === cls.table).map(c => [c.column_name, c.data_type]));
    if (dbCols.size === 0) { out.push(err('db-table-missing', cls.table, `ia:${cls.local} maps to a table that does not exist`)); continue; }
    out.push(...checkColumns(model, cls, dbCols));
    out.push(...checkConstraints(model, cls, constraints.filter(c => c.table_name === cls.table).map(c => c.definition)));
  }
  return out;
}

/** The two catalog queries the comparison needs, for a given list of tables. */
export const DB_SCHEMA_QUERIES = {
  columns: `SELECT table_name, column_name, data_type
              FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ANY($1)`,
  constraints: `SELECT c.relname AS table_name, pg_get_constraintdef(k.oid) AS definition
                  FROM pg_constraint k
                  JOIN pg_class c ON c.oid = k.conrelid
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE k.contype = 'c' AND n.nspname = 'public' AND c.relname = ANY($1)`,
};
