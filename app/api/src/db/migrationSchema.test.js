import { describe, it, expect } from 'vitest';
import { schemaFromMigrations, readMigrationSchema } from './migrationSchema.js';

const fk = (child, parent, onDelete) => ({ child, parent, onDelete });

describe('schemaFromMigrations', () => {
  it('reads tables and inline foreign keys with their ON DELETE action', () => {
    const s = schemaFromMigrations([{ name: '001.sql', sql: `
      CREATE TABLE "Parent" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS "Child" (
        "a" INTEGER NOT NULL REFERENCES "Parent"("id") ON DELETE CASCADE,
        "b" INTEGER REFERENCES "Parent"("id") ON DELETE SET NULL,
        "c" INTEGER REFERENCES "Parent"("id"),
        "d" NUMERIC(3, 2) CHECK ("d" >= 0)
      );
      CREATE TABLE _plain (id bigserial PRIMARY KEY);` }]);
    expect([...s.tables].sort()).toEqual(['Child', 'Parent', '_plain']);
    expect(s.foreignKeys).toEqual([fk('Child', 'Parent', 'CASCADE'), fk('Child', 'Parent', 'SET NULL'), fk('Child', 'Parent', 'NO ACTION')]);
  });

  it('applies files in name order, so a later drop wins and a re-create keeps only its own keys', () => {
    const s = schemaFromMigrations([
      { name: '003.sql', sql: `DROP TABLE IF EXISTS "Gone" CASCADE; DROP TABLE "Twice" CASCADE;
        CREATE TABLE "Twice" ("p" INTEGER REFERENCES "Keep"("id") ON DELETE SET NULL);` },
      { name: '001.sql', sql: `CREATE TABLE "Keep" (id INTEGER); CREATE TABLE "Gone" ("k" INTEGER REFERENCES "Keep"(id) ON DELETE CASCADE);
        CREATE TABLE "Twice" ("k" INTEGER REFERENCES "Keep"(id) ON DELETE CASCADE);
        CREATE TABLE "Ref" ("g" INTEGER REFERENCES "Gone"(id) ON DELETE CASCADE);` },
    ]);
    expect([...s.tables].sort()).toEqual(['Keep', 'Ref', 'Twice']);
    // Gone's own key and the key pointing AT it both vanish with the drop.
    expect(s.foreignKeys).toEqual([fk('Twice', 'Keep', 'SET NULL')]);
  });

  it('reads keys added by ALTER TABLE and ignores comments, temp tables and format() placeholders', () => {
    const s = schemaFromMigrations([{ name: '001.sql', sql: `
      CREATE TABLE "A" (id INTEGER);
      -- CREATE TABLE "Commented" (id INTEGER);
      CREATE TEMP TABLE "_tmp" ON COMMIT DROP AS SELECT 1;
      ALTER TABLE "A" ADD COLUMN "self" INTEGER REFERENCES "A"("id") ON DELETE SET NULL;
      ALTER TABLE IF EXISTS "A" ADD COLUMN "x" INTEGER;
      DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD COLUMN y INT', 'A'); END $$;` }]);
    expect([...s.tables]).toEqual(['A']);
    expect(s.foreignKeys).toEqual([fk('A', 'A', 'SET NULL')]);
  });

  it('still reads the keys of a CREATE TABLE whose closing parenthesis is missing', () => {
    const s = schemaFromMigrations([{ name: '1.sql', sql: `CREATE TABLE "Open" ("a" INT REFERENCES "P"(id) ON DELETE RESTRICT` }]);
    expect(s.foreignKeys).toEqual([fk('Open', 'P', 'RESTRICT')]);
  });
});

describe('readMigrationSchema — the shipped migrations', () => {
  const s = readMigrationSchema();

  it('sees the tables a later migration created and not the ones it dropped', () => {
    expect(s.tables.has('Contexts')).toBe(true);
    expect(s.tables.has('ContextTreeAdjustments')).toBe(true);
    expect(s.tables.has('GraphTags')).toBe(false); // a view since 020
    expect(s.tables.has('GraphResourceClusters')).toBe(false);
  });

  it('keeps only the Contexts foreign keys of its 018 re-creation', () => {
    const own = s.foreignKeys.filter(k => k.child === 'Contexts').map(k => `${k.parent}:${k.onDelete}`).sort();
    expect(own).toEqual(['ContextAlgorithmRuns:SET NULL', 'ContextAlgorithms:SET NULL', 'Contexts:CASCADE', 'Systems:SET NULL']);
  });
});
