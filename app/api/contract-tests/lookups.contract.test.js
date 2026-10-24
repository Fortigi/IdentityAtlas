// Contract test — the lookup sources against a real PostgreSQL schema.
//
// The unit tests assert which parameters the source binds; they cannot say
// whether the statement is valid. This one runs it. The `ESCAPE '\'` clause is
// one specific reason: it is correct only while standard_conforming_strings is
// on, and a search box that 500s on every underscore is the kind of thing a
// SQL-blind mock reports as green. The attribute discovery behind the access
// review's field picker — two jsonb_each aggregates — is the other.
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

const id = {
  big: randomUUID(), small: randomUUID(), under: randomUUID(), tag: randomUUID(), people: randomUUID(),
  r1: randomUUID(), r2: randomUUID(), gone: randomUUID(),
};

async function context(contextId, displayName, members, { contextType = 'LogicalApplication', targetType = 'Resource', attrs = {} } = {}) {
  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName",
                             "scopeSystemId","directMemberCount","extendedAttributes")
     VALUES ($1,'synced',$2,$3,$4,$5,$6,$7::jsonb)`,
    [contextId, targetType, contextType, displayName, systemId, members, JSON.stringify(attrs)]);
}

async function resource(rid, attrs, { deleted = false } = {}) {
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","extendedAttributes","deletedAt")
     VALUES ($1,$2,$3,'Entitlement',$4::jsonb,$5)`,
    [rid, systemId, `${PREFIX}${rid}`, JSON.stringify(attrs), deleted ? new Date() : null]);
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy") VALUES ($1,'Resource',$2,'sync')`,
    [id.big, rid]);
}

const get = async (source, queryString) => {
  const res = await agent.get(`/api/lookups/${source}${queryString}`);
  expect(res.status).toBe(200);
  return res.body;
};
const options = queryString => get('resource-contexts', queryString);

/** Only the rows this file seeded — the database is shared. */
const own = (body) => body.data.filter(o => o.label.startsWith(PREFIX));

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test',$1) RETURNING "id"`, [SYSTEM_NAME]);
  systemId = sys.rows[0].id;

  await context(id.big, `${PREFIX}Ledger Engineering`, 16387, { attrs: { cmdbReference: 'CI-1', tags: ['x'] } });
  await context(id.small, `${PREFIX}Ledger Audit`, 12);
  await context(id.under, `${PREFIX}MAI23_LEG_ADMIN`, 5);
  // Another context type of resources — offered now.
  await context(id.tag, `${PREFIX}PCI scope`, 7, { contextType: 'Tag' });
  // A context of people is not something an access review runs over.
  await context(id.people, `${PREFIX}Ledger Department`, 99, { contextType: 'Department', targetType: 'Identity' });

  await resource(id.r1, { certfrequency: 'Quarterly', costcentercode: 4410, nested: { a: 1 } });
  await resource(id.r2, { certfrequency: 'Annually' });
  // A deleted member is not part of the scope, so its key is not on offer.
  await resource(id.gone, { onlyOnDeleted: 'x' }, { deleted: true });
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1`, [id.big]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /api/lookups/resource-contexts', () => {
  it('matches on part of a name, case-insensitively, and echoes the term', async () => {
    const body = await options('?q=ledger%20engineering');
    expect(body.q).toBe('ledger engineering');
    expect(own(body).map(o => o.label)).toEqual([`${PREFIX}Ledger Engineering`]);
  });

  it('offers the biggest first when nothing is typed', async () => {
    const labels = own(await options('?limit=50')).map(o => o.label);
    expect(labels.indexOf(`${PREFIX}Ledger Engineering`)).toBeLessThan(labels.indexOf(`${PREFIX}Ledger Audit`));
  });

  it('carries the type, the size and the source system as the hint', async () => {
    const [option] = own(await options('?q=Ledger%20Engineering'));
    expect(option.value).toBe(id.big);
    expect(option.hint).toBe(`LogicalApplication · 16,387 members · ${SYSTEM_NAME}`);
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

  it('offers every context of resources, and no context of people', async () => {
    const labels = own(await options(`?q=${encodeURIComponent(PREFIX)}&limit=50`)).map(o => o.label);
    expect(labels).toContain(`${PREFIX}PCI scope`);
    expect(labels).not.toContain(`${PREFIX}Ledger Department`);
  });

  it('resolves stored ids back into labels, ignoring one that is not a uuid or not of resources', async () => {
    const body = await options(`?ids=${id.big},not-a-uuid,${id.small},${id.people}`);
    expect(body.data.map(o => o.value).sort()).toEqual([id.big, id.small].sort());
  });

  it('honours the limit', async () => {
    expect((await options(`?q=${encodeURIComponent(PREFIX)}&limit=2`)).data).toHaveLength(2);
  });
});

describe('GET /api/lookups/access-review-fields', () => {
  it('offers the scalar attributes the picked context and its live resources carry, with how widely', async () => {
    const body = await get('access-review-fields', `?limit=50&contexts=${id.big}`);
    const byValue = Object.fromEntries(body.data.map(o => [o.value, o.hint]));

    expect(byValue['context.ext.cmdbReference']).toBe('Context attribute · on 1 of 1 contexts');
    expect(byValue['entitlement.ext.certfrequency']).toBe('Entitlement attribute · on 2 of 2 resources');
    expect(byValue['entitlement.ext.costcentercode']).toBe('Entitlement attribute · on 1 of 2 resources');
    // Not scalar, or only on a deleted member: not on offer.
    for (const absent of ['context.ext.tags', 'entitlement.ext.nested', 'entitlement.ext.onlyOnDeleted']) {
      expect(byValue[absent], absent).toBeUndefined();
    }
    // The built-ins come first and need no context.
    expect(body.data[0].value).toBe('context.name');
  });

  it('offers only the built-ins for a context with no attributes and no members', async () => {
    const body = await get('access-review-fields', `?limit=50&contexts=${id.small}`);
    expect(body.data.every(o => !o.value.includes('.ext.'))).toBe(true);
  });

  it('resolves stored field keys back into headings', async () => {
    const body = await get('access-review-fields', '?ids=entitlement.ext.certfrequency,context.name');
    expect(body.data.map(o => o.label)).toEqual(['certfrequency', 'Context']);
  });
});
