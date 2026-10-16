// The extended search only uses the trigram index of migration 091 when the
// query repeats the index expression exactly. A column added to one side and
// not the other does not fail anything: Postgres silently scans the table. This
// test is the guard — it reads the migration and holds it to SEARCH_ENTITIES.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SEARCH_ENTITIES, searchExpression } from './entitySearch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '../db/migrations/091_search_all_attributes.sql'), 'utf8');

const TABLE = { principal: 'Principals', identity: 'Identities', resource: 'Resources', context: 'Contexts' };

function indexExpression(table) {
  const re = new RegExp(`CREATE INDEX IF NOT EXISTS "ix_${table}_search" ON "${table}" USING GIN \\(\\s*([\\s\\S]*?)\\s*gin_trgm_ops\\);`);
  const m = sql.match(re);
  return m ? m[1].trim() : null;
}

describe('migration 091 ↔ lib/entitySearch.js', () => {
  it('indexes exactly the four searchable tables', () => {
    const indexed = [...sql.matchAll(/CREATE INDEX IF NOT EXISTS "ix_(\w+)_search"/g)].map(m => m[1]).sort();
    expect(indexed).toEqual(Object.values(TABLE).sort());
  });

  it.each(Object.entries(TABLE))('%s: the query expression is the index expression', (entity, table) => {
    const expr = indexExpression(table);
    expect(expr, `no search index on ${table}`).not.toBeNull();
    // The query qualifies columns with its alias; the index cannot.
    const unaliased = searchExpression(entity, 'x').replace(/x\./g, '');
    expect(expr).toBe(unaliased);
  });

  it.each(Object.entries(TABLE))('%s: column order matches SEARCH_ENTITIES', (entity, table) => {
    const cols = [...indexExpression(table).matchAll(/"(\w+)"/g)].map(m => m[1]).filter(c => c !== 'extendedAttributes');
    expect(cols).toEqual(SEARCH_ENTITIES[entity].all);
  });

  it('declares both functions IMMUTABLE (an index expression requires it)', () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([^)]*\) RETURNS text\s+LANGUAGE sql IMMUTABLE/g)].map(m => m[1]);
    expect(fns.sort()).toEqual(['ia_search_text', 'ia_search_token']);
  });
});
