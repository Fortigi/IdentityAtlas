// The canonical objects of knowledge claims: found by name, else created under
// the kind's root (created too when there is none). The SQL itself runs against
// PostgreSQL in contract-tests/workbench.contract.test.js.
import { describe, it, expect, vi } from 'vitest';
import { objectFor, listObjects, FIND_OBJECT_SQL, FIND_ROOT_SQL, INSERT_OBJECT_SQL, LIST_OBJECTS_SQL } from './objects.js';

function client({ existing = null, root = null } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (sql === FIND_OBJECT_SQL) return { rows: existing ? [existing] : [] };
      if (sql === FIND_ROOT_SQL) return { rows: root ? [{ id: root }] : [] };
      if (sql === INSERT_OBJECT_SQL) { n += 1; return { rows: [{ id: `new-${n}` }] }; }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
}

describe('objectFor', () => {
  it('returns the existing object, matched by its key (case and spacing aside), and creates nothing', async () => {
    const c = client({ existing: { id: 'o1', displayName: 'Handle claims' } });
    expect(await objectFor(c, 'activity', '  Handle   CLAIMS ')).toEqual({ id: 'o1', created: false });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].params).toEqual(['Activity', 'handle claims']);
  });

  it('creates a missing object under the existing root of its kind, with its name as given', async () => {
    const c = client({ root: 'root-duty' });
    expect(await objectFor(c, 'duty', 'Works  council member')).toEqual({ id: 'new-1', created: true });
    const insert = c.calls.find(x => x.sql === INSERT_OBJECT_SQL);
    expect(insert.params).toEqual(['Duty', 'Works council member', null, 'root-duty', JSON.stringify({ knowledgeKind: 'duty' })]);
  });

  it('creates the root first when the kind has none', async () => {
    const c = client();
    expect(await objectFor(c, 'expertise', 'Fraud')).toEqual({ id: 'new-2', created: true });
    const inserts = c.calls.filter(x => x.sql === INSERT_OBJECT_SQL);
    expect(inserts[0].params.slice(0, 2)).toEqual(['Expertise', 'Expertise']);
    expect(inserts[0].params[3]).toBeNull();
    expect(JSON.parse(inserts[0].params[4])).toEqual({ knowledgeRoot: true });
    expect(inserts[1].params[3]).toBe('new-1');
  });

  it('cuts a name to 200 characters and refuses a kind or a name that is not one', async () => {
    const c = client({ root: 'r' });
    await objectFor(c, 'activity', 'x'.repeat(250));
    expect(c.calls.find(x => x.sql === INSERT_OBJECT_SQL).params[1]).toHaveLength(200);
    await expect(objectFor(client(), 'role', 'Owner')).rejects.toThrow('Not a knowledge kind: role');
    await expect(objectFor(client(), 'duty', '   ')).rejects.toThrow('An object needs a name');
  });

  it('inserts a manual Tag context of people, never touching access', () => {
    expect(INSERT_OBJECT_SQL).toMatch(/'Tag', 'Identity', 'manual'/);
    expect(FIND_OBJECT_SQL + INSERT_OBJECT_SQL).not.toMatch(/ResourceAssignments|ContextMembers/);
  });
});

describe('listObjects', () => {
  it('asks for one kind’s type, or for all three', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ id: 'o1' }] })) };
    expect(await listObjects(db, 'duty')).toEqual([{ id: 'o1' }]);
    expect(db.query).toHaveBeenCalledWith(LIST_OBJECTS_SQL, [['Duty']]);
    await listObjects(db);
    expect(db.query).toHaveBeenLastCalledWith(LIST_OBJECTS_SQL, [['Activity', 'Expertise', 'Duty']]);
  });
});
