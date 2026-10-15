import { describe, it, expect } from 'vitest';
import { compareDbSchema, parseInListCheck, DB_SCHEMA_QUERIES } from './dbSchema.js';
import { modelOf } from '../__tests__/miniOntology.js';

describe('parseInListCheck', () => {
  // The exact strings pg_get_constraintdef produced for this schema (PostgreSQL 16).
  it('parses a quoted camelCase column', () => {
    expect(parseInListCheck(`CHECK (("assignmentType" = ANY (ARRAY['Direct'::text, 'Indirect'::text, 'Eligible'::text])))`))
      .toEqual({ column: 'assignmentType', values: ['Direct', 'Indirect', 'Eligible'] });
  });

  it('parses an unquoted lowercase column and a NOT VALID suffix', () => {
    expect(parseInListCheck(`CHECK ((origin = ANY (ARRAY['Automatic'::text, 'Requested'::text, 'Discovered'::text]))) NOT VALID`))
      .toEqual({ column: 'origin', values: ['Automatic', 'Requested', 'Discovered'] });
  });

  it('unescapes a doubled quote inside a value', () => {
    expect(parseInListCheck(`CHECK ((kind = ANY (ARRAY['it''s'::text])))`)).toEqual({ column: 'kind', values: ["it's"] });
  });

  it('ignores deny-lists and other expressions', () => {
    expect(parseInListCheck(`CHECK ((("resourceType" IS NULL) OR ("resourceType" <> ALL (ARRAY['EntraGroup'::text]))))`)).toBeNull();
    expect(parseInListCheck(`CHECK ((((("principalId" IS NOT NULL))::integer + (("identityId" IS NOT NULL))::integer) = 1))`)).toBeNull();
    expect(parseInListCheck(`CHECK ((("directorySystemId" IS NULL) OR ("directorySystemId" <> id)))`)).toBeNull();
  });
});

// A database that matches the mini ontology exactly.
function cleanDb() {
  const col = (table_name, column_name, data_type) => ({ table_name, column_name, data_type });
  return {
    columns: [
      col('Systems', 'id', 'integer'), col('Systems', 'displayName', 'text'),
      col('Principals', 'id', 'uuid'), col('Principals', 'displayName', 'text'), col('Principals', 'systemId', 'integer'), col('Principals', 'principalType', 'text'),
      col('Resources', 'id', 'uuid'), col('Resources', 'displayName', 'text'), col('Resources', 'systemId', 'integer'), col('Resources', 'resourceType', 'text'),
      col('ResourceRelationships', 'parentResourceId', 'uuid'), col('ResourceRelationships', 'childResourceId', 'uuid'), col('ResourceRelationships', 'relationshipType', 'text'),
      col('ResourceAssignments', 'principalId', 'uuid'), col('ResourceAssignments', 'resourceId', 'uuid'), col('ResourceAssignments', 'assignmentType', 'text'),
    ],
    constraints: [
      { table_name: 'ResourceAssignments', definition: `CHECK (("assignmentType" = ANY (ARRAY['Direct'::text, 'Eligible'::text])))` },
      { table_name: 'ResourceRelationships', definition: `CHECK (("relationshipType" = ANY (ARRAY['HasOwnership'::text, 'Contains'::text])))` },
    ],
  };
}
const run = (db) => compareDbSchema(modelOf(), db.columns, db.constraints).map(f => `${f.code} ${f.subject}`);

describe('compareDbSchema', () => {
  it('finds nothing when the database matches (CHECK order does not matter)', () => {
    expect(compareDbSchema(modelOf(), cleanDb().columns, cleanDb().constraints)).toEqual([]);
  });

  it('fails on a column the ontology does not describe', () => {
    const db = cleanDb();
    db.columns.push({ table_name: 'Principals', column_name: 'nickname', data_type: 'text' });
    expect(run(db)).toEqual(['db-column-undescribed Principals.nickname']);
  });

  it('fails on a column whose type differs', () => {
    const db = cleanDb();
    db.columns.find(c => c.table_name === 'Resources' && c.column_name === 'systemId').data_type = 'bigint';
    expect(run(db)).toEqual(['db-column-type Resources.systemId']);
  });

  it('fails on a described column the table lacks', () => {
    const db = cleanDb();
    db.columns = db.columns.filter(c => !(c.table_name === 'Principals' && c.column_name === 'principalType'));
    expect(run(db)).toEqual(['db-column-missing Principals.principalType']);
  });

  it('checks the identifier column type and presence', () => {
    const db = cleanDb();
    db.columns.find(c => c.table_name === 'Systems' && c.column_name === 'id').data_type = 'uuid';
    expect(run(db)).toEqual(['db-identifier-type Systems.id']);
    const gone = cleanDb();
    gone.columns = gone.columns.filter(c => !(c.table_name === 'Systems' && c.column_name === 'id'));
    expect(run(gone)).toEqual(['db-column-missing Systems.id']);
  });

  it('fails on a missing table', () => {
    const db = cleanDb();
    db.columns = db.columns.filter(c => c.table_name !== 'ResourceAssignments');
    db.constraints = db.constraints.filter(c => c.table_name !== 'ResourceAssignments');
    expect(run(db)).toEqual(['db-table-missing ResourceAssignments']);
  });

  // The database-side half of the required demonstration: a migration that
  // widens a relationship CHECK without an ontology definition fails.
  it('fails when a CHECK admits a relationship type the ontology does not define', () => {
    const db = cleanDb();
    db.constraints[1].definition = `CHECK (("relationshipType" = ANY (ARRAY['Contains'::text, 'HasOwnership'::text, 'Mirrors'::text])))`;
    expect(run(db)).toEqual(['db-check-mismatch ResourceRelationships.relationshipType']);
  });

  it('fails when a CHECK closes a column the ontology leaves open', () => {
    const db = cleanDb();
    db.constraints.push({ table_name: 'Resources', definition: `CHECK (("resourceType" = ANY (ARRAY['Group'::text])))` });
    expect(run(db)).toEqual(['db-check-not-in-ontology Resources.resourceType']);
  });

  it('exposes the catalog queries the contract test runs', () => {
    expect(DB_SCHEMA_QUERIES.columns).toMatch(/information_schema\.columns/);
    expect(DB_SCHEMA_QUERIES.constraints).toMatch(/pg_get_constraintdef/);
    expect(DB_SCHEMA_QUERIES.constraints).toMatch(/contype = 'c'/);
  });
});
