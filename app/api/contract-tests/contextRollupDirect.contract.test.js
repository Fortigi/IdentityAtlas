// Contract test — the context roll-up's frontier (src/matrix/contextRollup.js)
// against PostgreSQL: a direct-members column counts only its unit's own
// members, a plain column its whole subtree. Uses the per-node totals query,
// which reads only Contexts + ContextMembers.
//
//   CTO (Carla, Hanna, Zelma)
//   └ Development (Dev1)
//     └ Dev team (Dev2)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { frontierValues, buildContextTotalsSql, withDirectMemberNodes, frontierOf } from '../src/matrix/contextRollup.js';

let pool;
let systemId;
const id = Object.fromEntries(['cto', 'dev', 'team', 'carla', 'hanna', 'zelma', 'dev1', 'dev2'].map(k => [k, randomUUID()]));

async function unit(ctxId, name, parent, members) {
  await pool.query(
    `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","scopeSystemId","parentContextId")
     VALUES ($1,'manual','Principal','Department',$2,$3,$4)`, [ctxId, name, systemId, parent]);
  for (const m of members) {
    await pool.query(`INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy") VALUES ($1,'Principal',$2,'analyst')`, [ctxId, m]);
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  systemId = (await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-rollup-direct') RETURNING "id"`)).rows[0].id;
  for (const p of ['carla', 'hanna', 'zelma', 'dev1', 'dev2']) {
    await pool.query(`INSERT INTO "Principals" ("id","systemId","displayName","principalType") VALUES ($1,$2,$3,'User')`, [id[p], systemId, p]);
  }
  await unit(id.cto, 'CTO', null, [id.carla, id.hanna, id.zelma]);
  await unit(id.dev, 'Development', id.cto, [id.dev1]);
  await unit(id.team, 'Dev team', id.dev, [id.dev2]);
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

const totals = async (entries) => {
  const sql = buildContextTotalsSql({ values: frontierValues(entries), subjectId: 'nm.pid', subjectScope: 'nm.pid', subjectSql: null });
  const { rows } = await pool.query(sql);
  return Object.fromEntries(rows.map(r => [r.groupValue, r.total]));
};

describe('the roll-up frontier', () => {
  it('the root\'s direct members beside its sub-unit: 3 + 2 = the root\'s 5', async () => {
    const t = await totals([{ id: id.cto, direct: true }, id.dev]);
    expect(t).toEqual({ [`${id.cto}:direct`]: 3, [id.dev]: 2 });
    expect(await totals([id.cto])).toEqual({ [id.cto]: 5 });
  });

  it('a direct-members column of a unit with sub-units does not walk them', async () => {
    expect(await totals([{ id: id.dev, direct: true }])).toEqual({ [`${id.dev}:direct`]: 1 });
  });

  it('a leaf root: its direct-members column holds its people', async () => {
    const nodes = withDirectMemberNodes([], { id: id.team, displayName: 'Dev team' });
    expect(await totals(frontierOf(nodes))).toEqual({ [`${id.team}:direct`]: 1 });
  });
});
