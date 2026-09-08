// Contract test — the report routes and the orphaned-accounts template against
// a real PostgreSQL schema.
//
// The unit tests mock the DB, so they say nothing about whether the anti-join
// (Principals LEFT JOIN IdentityMembers, LEFT JOIN Systems) is valid SQL or
// selects the right rows. That is what this file proves.
//
// The database is shared with the other contract files, so every assertion is
// scoped to this file's own system by systemName.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

const SYSTEM_NAME = 'contract-reports';

let agent;
let pool;
let systemId;

const ids = { linked: randomUUID(), orphan: randomUUID(), servicePrincipal: randomUUID(), identity: randomUUID() };

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`, [SYSTEM_NAME],
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [ids.identity]); // cascades IdentityMembers
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [ids.identity]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
});

async function insertPrincipal(id, displayName, principalType, email = null) {
  await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "extendedAttributes")
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
    [id, systemId, displayName, email, principalType],
  );
}

async function linkToIdentity(principalId) {
  await pool.query(`INSERT INTO "Identities" ("id", "displayName") VALUES ($1, 'Linked Person')
                    ON CONFLICT ("id") DO NOTHING`, [ids.identity]);
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId", "principalId") VALUES ($1, $2)`,
    [ids.identity, principalId]);
}

/** The report's rows, narrowed to the ones this file seeded. */
async function ownRows() {
  const res = await agent.get('/api/reports/orphaned-accounts/rows');
  expect(res.status).toBe(200);
  return { body: res.body, rows: res.body.rows.filter(r => r.systemName === SYSTEM_NAME) };
}

describe('GET /reports', () => {
  it('lists the orphaned-accounts template with its form and columns', async () => {
    const res = await agent.get('/api/reports');

    expect(res.status).toBe(200);
    const report = res.body.data.find(r => r.name === 'orphaned-accounts');
    expect(report).toBeTruthy();
    expect(report.form).toBe('list');
    expect(report.columns.map(c => c.key)).toEqual(
      ['displayName', 'email', 'principalType', 'accountType', 'systemName']);
  });
});

describe('GET /reports/orphaned-accounts/rows', () => {
  it('lists only the unlinked human account — linked accounts and service principals are out', async () => {
    await insertPrincipal(ids.linked, 'Linked User', 'User', 'linked@example.com');
    await insertPrincipal(ids.orphan, 'Orphan User', 'User', 'orphan@example.com');
    await insertPrincipal(ids.servicePrincipal, 'Deploy Pipeline', 'ServicePrincipal');
    await linkToIdentity(ids.linked);

    const { rows } = await ownRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      displayName: 'Orphan User',
      email: 'orphan@example.com',
      principalType: 'User',
      systemName: SYSTEM_NAME,
      _entity: { kind: 'user', id: ids.orphan },
    });
    expect(rows[0].accountType).toBeTruthy();
  });

  it('excludes every non-human principal class', async () => {
    for (const [i, type] of ['ServicePrincipal', 'ManagedIdentity', 'AIAgent'].entries()) {
      await insertPrincipal(randomUUID(), `Non-human ${i}`, type);
    }

    expect((await ownRows()).rows).toEqual([]);
  });

  it('returns an empty result set, not an error, when every account is linked', async () => {
    await insertPrincipal(ids.linked, 'Linked User', 'User');
    await linkToIdentity(ids.linked);

    const { body, rows } = await ownRows();
    expect(rows).toEqual([]);
    expect(body.total).toBe(body.rows.length);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
  });

  it('lists every human account when linking has never run (no IdentityMembers at all)', async () => {
    await insertPrincipal(ids.linked, 'Never Linked A', 'User');
    await insertPrincipal(ids.orphan, 'Never Linked B', 'Guest');

    const { rows } = await ownRows();
    expect(rows.map(r => r.displayName).sort()).toEqual(['Never Linked A', 'Never Linked B']);
  });

  it('reflects the latest data on every request — a refresh after linking drops the row', async () => {
    await insertPrincipal(ids.orphan, 'Orphan User', 'User');
    expect((await ownRows()).rows).toHaveLength(1);

    await linkToIdentity(ids.orphan);
    expect((await ownRows()).rows).toEqual([]);
  });

  it('404s on an unknown report name', async () => {
    const res = await agent.get('/api/reports/no-such-report/rows');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Report not found' });
  });
});
