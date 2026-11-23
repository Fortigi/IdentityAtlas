// Contract test: an owner's tree over real PostgreSQL. The units above a held
// context are named top first, and nothing beside them leaks in. (A parent cycle
// cannot be stored: the Contexts trigger refuses it.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { loadOwnerTree } from '../src/auth/ownerTree.js';

let pool;
const id = { top: randomUUID(), mid: randomUUID(), sibling: randomUUID(), mine: randomUUID(), child: randomUUID(), alone: randomUUID() };
const unit = (ctxId, name, parent = null) => pool.query(
  `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "contextCategory", "parentContextId")
   VALUES ($1, 'manual', 'Principal', 'Department', $2, 'OrganizationalUnit', $3)`, [ctxId, name, parent]);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  await unit(id.top, 'OT Board');
  await unit(id.mid, 'OT Management', id.top);
  await unit(id.sibling, 'OT Sibling', id.mid);
  await unit(id.mine, 'OT Mine', id.mid);
  await unit(id.child, 'OT Child', id.mine);
  await unit(id.alone, 'OT Alone');
});

afterAll(async () => {
  for (const ctxId of [id.child, id.mine, id.sibling, id.mid, id.top, id.alone]) {
    await pool.query(`DELETE FROM "Contexts" WHERE id = $1`, [ctxId]);
  }
  await pool.end();
});

describe('loadOwnerTree', () => {
  it('names the units above, top first, and only what is theirs below', async () => {
    const [root, ...others] = await loadOwnerTree(pool, {
      contextIds: new Set([id.mine, id.child]), contexts: [{ id: id.mine, role: 'Accountable' }],
    });
    expect(others).toEqual([]);
    expect(root.ancestors).toEqual(['OT Board', 'OT Management']);
    expect(root.children.map(c => c.displayName)).toEqual(['OT Child']);
    expect(JSON.stringify(root)).not.toContain('OT Sibling');
  });

  it('has nothing above a tree at the top', async () => {
    const [root] = await loadOwnerTree(pool, {
      contextIds: new Set([id.alone]), contexts: [{ id: id.alone, role: 'Responsible' }],
    });
    expect(root.ancestors).toEqual([]);
  });
});
