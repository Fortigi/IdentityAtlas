// Contract test — the custom-report catalog against a real PostgreSQL schema.
//
// Every field, relation and comparison in nlreports/catalog.js carries a constant SQL
// template, and the unit tests only check the SQL *text*. A template that names a
// column the schema does not have compiles fine and fails only when an analyst runs
// the report. This file compiles a definition for every field (as a condition and as
// a column), every relation (has / has no, and its columns) and every comparison, and
// executes each against the migrated schema.
//
// It also pins what the sign-in fields MEAN, on seeded activity: "days since last
// sign-in" counts back from the system's measurement moment (as the standard
// activity reports do), and "never signed in" excludes systems that collect no
// sign-in data at all.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';
import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE } from '../src/nlreports/catalog.js';
import { validateSpec, availableColumns, MAX_COLUMNS } from '../src/nlreports/spec.js';
import { compileSpec } from '../src/nlreports/compile.js';
import { manyRelationsOf, MEASURES } from '../src/nlreports/compare.js';
import { AGG_RESOURCE_ID } from '../src/lib/principalActivity.js';

const PREFIX = 'CR-catalog-';

// A value of the right shape for a field type and operator (null when none is taken).
const SAMPLE_VALUES = { text: 'x', enum: 'x', boolean: true, number: 1, date: 30 };
const sampleValue = (type, op) => (OPERATORS[op].needsValue ? SAMPLE_VALUES[type] : null);
const MEASURED = new Date('2026-06-01T12:00:00Z');
const daysBefore = (n) => new Date(MEASURED.getTime() - n * 86_400_000);

let pool;
const ids = {
  collecting: null, silent: null,           // systems: one collects sign-in data, one does not
  recent: randomUUID(), stale: randomUUID(), never: randomUUID(), uncollected: randomUUID(),
  group: randomUUID(), role: randomUUID(), identity: randomUUID(),
};

async function insertSystem(name) {
  return (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`, [name],
  )).rows[0].id;
}

async function insertUser(id, systemId, name) {
  await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "accountEnabled", "extendedAttributes")
     VALUES ($1, $2, $3, $4, 'User', true, '{}'::jsonb)`,
    [id, systemId, `${PREFIX}${name}`, `${name}@example.com`],
  );
}

async function insertSignIn(principalId, { interactive = null, nonInteractive = null, successful = null }) {
  await pool.query(
    `INSERT INTO "PrincipalActivity" ("principalId", "resourceId", "activityType",
       "lastSignInDateTime", "lastNonInteractiveSignInDateTime", "lastSuccessfulSignInDateTime", "updatedAt")
     VALUES ($1, $2, 'SignIn', $3, $4, $5, $6)`,
    [principalId, AGG_RESOURCE_ID, interactive, nonInteractive, successful, MEASURED],
  );
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  ids.collecting = await insertSystem(`${PREFIX}collecting`);
  ids.silent = await insertSystem(`${PREFIX}silent`);

  await insertUser(ids.recent, ids.collecting, 'recent');
  await insertUser(ids.stale, ids.collecting, 'stale');
  await insertUser(ids.never, ids.collecting, 'never');
  await insertUser(ids.uncollected, ids.silent, 'uncollected');

  await insertSignIn(ids.recent, { interactive: daysBefore(10) });
  // The newest of the three timestamps counts: interactive is older, non-interactive newer.
  await insertSignIn(ids.stale, { interactive: daysBefore(200), nonInteractive: daysBefore(100) });

  await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType") VALUES
       ($1, $2, $3, 'Group'), ($4, $2, $5, 'BusinessRole')`,
    [ids.group, ids.collecting, `${PREFIX}group`, ids.role, `${PREFIX}role`],
  );
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId")
     VALUES ($1, $2, 'Direct', 'User', $3), ($1, $4, 'Direct', 'User', $3)`,
    [ids.group, ids.recent, ids.collecting, ids.stale],
  );
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId", "roleName")
     VALUES ($1, $2, 'Contains', $3, 'Member')`,
    [ids.role, ids.group, ids.collecting],
  );
  await pool.query(`INSERT INTO "Identities" ("id", "displayName") VALUES ($1, $2)`, [ids.identity, `${PREFIX}person`]);
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId", "principalId") VALUES ($1, $2)`, [ids.identity, ids.recent]);
});

afterAll(async () => {
  const principals = [ids.recent, ids.stale, ids.never, ids.uncollected];
  await pool.query(`DELETE FROM "PrincipalActivity" WHERE "principalId" = ANY($1::uuid[])`, [principals]);
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [ids.identity]);
  await pool.query(`DELETE FROM "ResourceRelationships" WHERE "parentResourceId" = $1`, [ids.role]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "resourceId" = $1`, [ids.group]);
  await pool.query(`DELETE FROM "Resources" WHERE "id" = ANY($1::uuid[])`, [[ids.group, ids.role]]);
  await pool.query(`DELETE FROM "Principals" WHERE "id" = ANY($1::uuid[])`, [principals]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = ANY($1::int[])`, [[ids.collecting, ids.silent]]);
  await pool.end();
});

/** Validate, compile and execute a definition; fail loudly on either step. */
async function run(raw) {
  const { ok, spec, errors } = validateSpec(raw);
  expect(errors, JSON.stringify(raw)).toEqual([]);
  expect(ok).toBe(true);
  const { text, params } = compileSpec(spec);
  try {
    return (await pool.query(text, params)).rows;
  } catch (err) {
    throw new Error(`${err.message}\n--- definition ---\n${JSON.stringify(raw)}\n--- SQL ---\n${text}`);
  }
}

// A record of the same kind as the entity, for comparisons to point at.
const referenceIdFor = (entityName) => ({
  user: ids.recent, account: ids.recent, identity: ids.identity, group: ids.group, resource: ids.group,
}[entityName]);

describe('custom-report catalog SQL matches the schema', () => {
  for (const [entityName, entity] of Object.entries(ENTITIES)) {
    it(`${entityName}: every field works with every operator its type allows, and as a column`, async () => {
      // Every failure is collected, so one broken field cannot hide the ones after it.
      const failures = [];
      for (const [fieldName, field] of Object.entries(entity.fields)) {
        for (const op of OPERATORS_BY_TYPE[field.type]) {
          try {
            await run({ entity: entityName, conditions: [{ field: fieldName, op, value: sampleValue(field.type, op) }], columns: [fieldName] });
          } catch (err) {
            failures.push(`${fieldName} ${op}: ${err.message.split('\n')[0]}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${entityName}: every relation works as "has" and "has no"`, async () => {
      for (const relation of Object.keys(entity.relations)) {
        for (const quantifier of ['some', 'none']) {
          await run({ entity: entityName, conditions: [{ type: 'relation', relation, quantifier, match: 'all', conditions: [] }] });
        }
      }
    });

    it(`${entityName}: every pickable column compiles and runs`, async () => {
      const columns = availableColumns(entityName).map(c => c.key).filter(k => !k.startsWith('compare.'));
      for (let i = 0; i < columns.length; i += MAX_COLUMNS) {
        await run({ entity: entityName, conditions: [], columns: columns.slice(i, i + MAX_COLUMNS) });
      }
    });

    it(`${entityName}: every comparison measure runs, with its columns`, async () => {
      for (const relation of manyRelationsOf(entityName)) {
        for (const measure of Object.keys(MEASURES)) {
          await run({
            entity: entityName,
            conditions: [{
              type: 'compare', relation, measure, minSimilarity: 50,
              reference: { entity: entityName, name: 'reference', id: referenceIdFor(entityName) },
            }],
          });
        }
      }
    });
  }
});

describe('sign-in fields mean what the standard activity reports mean', () => {
  const ours = { field: 'displayName', op: 'startsWith', value: PREFIX };
  const names = (rows) => rows.map(r => r.displayName.slice(PREFIX.length)).sort();

  it('"not signed in for N days" counts back from when the data was collected, using the newest timestamp', async () => {
    const rows = await run({
      entity: 'user',
      conditions: [ours, { field: 'daysSinceLastSignIn', op: 'gt', value: 90 }],
      columns: ['displayName', 'daysSinceLastSignIn', 'lastSignIn', 'signInDataCollected'],
    });
    // MEASURED is months in the past, so counted from today every account would
    // be stale; counted from the measurement only "stale" (100 days) is.
    expect(names(rows)).toEqual(['stale']);
    expect(rows[0].daysSinceLastSignIn).toBe(100);
    expect(new Date(rows[0].lastSignIn).toISOString()).toBe(daysBefore(100).toISOString());
    expect(new Date(rows[0].signInDataCollected).toISOString()).toBe(MEASURED.toISOString());
  });

  it('"never signed in" lists accounts with no sign-in in a system that collects sign-in data — and not the others', async () => {
    const rows = await run({
      entity: 'user',
      conditions: [ours,
        { field: 'lastSignIn', op: 'isEmpty', value: null },
        { field: 'signInDataCollected', op: 'isNotEmpty', value: null }],
    });
    expect(names(rows)).toEqual(['never']);

    // Without the collection check, the account from the silent system slips in —
    // the reason the prompt tells the model to add it.
    const loose = await run({ entity: 'user', conditions: [ours, { field: 'lastSignIn', op: 'isEmpty', value: null }] });
    expect(names(loose)).toEqual(['never', 'uncollected']);
  });

  it('leaves days-since empty where it cannot be known', async () => {
    const rows = await run({ entity: 'user', conditions: [ours], columns: ['displayName', 'daysSinceLastSignIn'] });
    const byName = Object.fromEntries(rows.map(r => [r.displayName.slice(PREFIX.length), r.daysSinceLastSignIn]));
    expect(byName).toEqual({ recent: 10, stale: 100, never: null, uncollected: null });
  });
});
