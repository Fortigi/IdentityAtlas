// Contract test — the lookup sources against a real PostgreSQL schema.
//
// The unit tests assert which parameters the source binds; they cannot say
// whether the statement is valid. This one runs it. The `ESCAPE '\'` clause is
// the specific reason: it is correct only while standard_conforming_strings is
// on, and a search box that 500s on every underscore is the kind of thing a
// SQL-blind mock reports as green.
//
// The database is shared with the other contract files, so every assertion is
// scoped to this file's own system and its own contexts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

const SYSTEM_NAME = 'contract-lookups';
const PREFIX = 'CTL_';

let agent;
let pool;
let systemId;

const id = { big: randomUUID(), small: randomUUID(), under: randomUUID(), other: randomUUID() };

async function context(contextId, displayName, members, contextType = 'LogicalApplication') {
  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName",
                             "scopeSystemId","directMemberCount")
     VALUES ($1,'synced','Resource',$2,$3,$4,$5)`,
    [contextId, contextType, displayName, systemId, members]);
}

const options = async (queryString) => {
  const res = await agent.get(`/api/lookups/logical-applications${queryString}`);
  expect(res.status).toBe(200);
  return res.body;
};

/** Only the rows this file seeded — the database is shared. */
const own = (body) => body.data.filter(o => o.label.startsWith(PREFIX));

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test',$1) RETURNING "id"`, [SYSTEM_NAME]);
  systemId = sys.rows[0].id;

  await context(id.big, `${PREFIX}Ledger Engineering`, 16387);
  await context(id.small, `${PREFIX}Ledger Audit`, 12);
  await context(id.under, `${PREFIX}MAI23_LEG_ADMIN`, 5);
  // Same shape, different contextType — must never be offered.
  await context(id.other, `${PREFIX}Not An Application`, 99, 'Department');
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /api/lookups/logical-applications', () => {
  it('matches on part of a name, case-insensitively, and echoes the term', async () => {
    const body = await options('?q=ledger%20engineering');
    expect(body.q).toBe('ledger engineering');
    expect(own(body).map(o => o.label)).toEqual([`${PREFIX}Ledger Engineering`]);
  });

  it('offers the biggest first when nothing is typed', async () => {
    const labels = own(await options('?limit=50')).map(o => o.label);
    expect(labels.indexOf(`${PREFIX}Ledger Engineering`)).toBeLessThan(labels.indexOf(`${PREFIX}Ledger Audit`));
  });

  it('carries the size and the source system as the hint', async () => {
    const [option] = own(await options('?q=Ledger%20Engineering'));
    expect(option.value).toBe(id.big);
    expect(option.hint).toBe(`16,387 members · ${SYSTEM_NAME}`);
  });

  it('treats an underscore as an underscore, not as a wildcard', async () => {
    // The ESCAPE clause under test. Unescaped, `MAI23_LEG` is `MAI23<any>LEG`
    // — and a statement with a broken ESCAPE would 500 instead of answering.
    expect(own(await options('?q=MAI23_LEG')).map(o => o.label)).toEqual([`${PREFIX}MAI23_LEG_ADMIN`]);
    expect(own(await options('?q=MAI23XLEG'))).toEqual([]);
  });

  it('treats a percent sign as a character, not as "everything"', async () => {
    expect(own(await options('?q=%25'))).toEqual([]);
  });

  it('offers only logical applications, never another context type', async () => {
    const labels = own(await options(`?q=${encodeURIComponent(PREFIX)}&limit=50`)).map(o => o.label);
    expect(labels).toContain(`${PREFIX}Ledger Audit`);
    expect(labels).not.toContain(`${PREFIX}Not An Application`);
  });

  it('resolves stored ids back into labels, ignoring one that is not a uuid', async () => {
    const body = await options(`?ids=${id.big},not-a-uuid,${id.small}`);
    expect(body.data.map(o => o.value).sort()).toEqual([id.big, id.small].sort());
  });

  it('honours the limit', async () => {
    expect((await options(`?q=${encodeURIComponent(PREFIX)}&limit=2`)).data).toHaveLength(2);
  });
});
