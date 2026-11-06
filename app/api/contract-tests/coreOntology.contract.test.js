// Contract test — the core ontology describes the schema the migrations build.
//
// The unit check (`npm run ontology:check`) compares the ontology with the
// code's registries. This half compares it with PostgreSQL itself: a database
// migrated from scratch must have exactly the described columns, with the
// described types, on every core table, and every `col IN (…)` CHECK must
// admit exactly the ontology's closed list. A migration that adds a column, a
// table type change or a widened relationship CHECK without an ontology update
// fails here. The comparison is src/ontology/checks/dbSchema.js (unit-tested);
// this file only feeds it the catalog rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, loadOntology } from '../src/ontology/cli.js';
import { tableClasses } from '../src/ontology/model.js';
import { compareDbSchema, DB_SCHEMA_QUERIES } from '../src/ontology/checks/dbSchema.js';
import { applyKnownGaps } from '../src/ontology/checks/knownGaps.js';

let pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await pool?.end();
});

describe('core ontology ↔ migrated schema', () => {
  it('describes every column, type and CHECK list of the core tables', async () => {
    const { model, errors } = loadOntology();
    expect(errors).toBeUndefined();
    const tables = tableClasses(model).map(c => c.table);
    expect(tables).toHaveLength(10);

    const columns = (await pool.query(DB_SCHEMA_QUERIES.columns, [tables])).rows;
    const constraints = (await pool.query(DB_SCHEMA_QUERIES.constraints, [tables])).rows;
    // Guard against a vacuous pass: the catalog queries must actually see the schema.
    expect(new Set(columns.map(c => c.table_name)).size).toBe(10);
    expect(constraints.some(c => /"assignmentType" = ANY/.test(c.definition))).toBe(true);

    const findings = compareDbSchema(model, columns, constraints);
    const { errors: drift } = applyKnownGaps(findings, loadConfig().knownGaps, 'database');
    const lines = drift.map(e => `${e.code} ${e.subject}: ${e.message}`);
    expect(lines, `the migrated schema and ontology/core.ttl disagree:\n${lines.join('\n')}`).toEqual([]);
  });
});
