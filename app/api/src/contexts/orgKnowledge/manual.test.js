// An analyst's own knowledge link: the body check, the "Analyst notes" source,
// confirmed (with its object) or left proposed. The SQL runs against PostgreSQL
// in contract-tests/workbench.contract.test.js.
import { describe, it, expect, vi } from 'vitest';
import {
  parseLink, addKnowledgeLink, peopleWithObject, KnowledgeError, ANALYST_NOTES,
  NOTES_SOURCE_SQL, INSERT_NOTES_SQL, INSERT_LINK_SQL, PEOPLE_WITH_OBJECT_SQL,
} from './manual.js';
import { FIND_OBJECT_SQL, FIND_ROOT_SQL, INSERT_OBJECT_SQL } from './objects.js';

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('parseLink', () => {
  it('takes a kind, a name, one person, an optional quote and a status (confirmed by default)', () => {
    expect(parseLink({ kind: 'duty', value: '  Works   council ', identityId: ANNA.toUpperCase() }))
      .toEqual({ kind: 'duty', value: 'Works council', holder: { col: 'identityId', id: ANNA }, quote: null, status: 'confirmed' });
    expect(parseLink({ kind: 'activity', value: 'X', principalId: ANNA, quote: ' said so ', status: 'proposed' }))
      .toMatchObject({ holder: { col: 'principalId', id: ANNA }, quote: 'said so', status: 'proposed' });
  });

  it.each([
    [{ kind: 'role', value: 'X', identityId: ANNA }, /kind must be one of activity, expertise, duty/],
    [{ kind: 'duty', value: '  ', identityId: ANNA }, /value must name/],
    [{ kind: 'duty', value: 'x'.repeat(201), identityId: ANNA }, /at most 200/],
    [{ kind: 'duty', value: 'X', identityId: ANNA, status: 'rejected' }, /status must be confirmed or proposed/],
    [{ kind: 'duty', value: 'X' }, /one of identityId or principalId/],
    [{ kind: 'duty', value: 'X', identityId: ANNA, principalId: ANNA }, /one of identityId or principalId/],
    [{ kind: 'duty', value: 'X', identityId: 'nope' }, /identityId must be a uuid/],
  ])('refuses %j', (body, message) => {
    expect(() => parseLink(body)).toThrow(message);
    try { parseLink(body); } catch (e) { expect(e).toBeInstanceOf(KnowledgeError); expect(e.status).toBe(400); }
  });
});

const rowsOf = (row) => ({ rows: row ? [row] : [] });

function fakeDb({ context = { id: CTX }, person = { displayName: 'Anna Vos' }, notes = null, object = null } = {}) {
  const calls = [];
  // Each statement the module runs and what it answers.
  const answers = [
    [(sql) => sql.startsWith('SELECT id FROM "Contexts"'), () => rowsOf(context)],
    [(sql) => sql.startsWith('SELECT "displayName" FROM'), () => rowsOf(person)],
    [(sql) => sql === NOTES_SOURCE_SQL, () => rowsOf(notes && { id: notes })],
    [(sql) => sql === INSERT_NOTES_SQL, () => rowsOf({ id: 'iv-new' })],
    [(sql) => sql === FIND_OBJECT_SQL, () => rowsOf(object && { id: object })],
    [(sql) => sql === FIND_ROOT_SQL, () => rowsOf({ id: 'root' })],
    [(sql) => sql === INSERT_OBJECT_SQL, () => rowsOf({ id: 'obj-new' })],
    [(sql) => sql === INSERT_LINK_SQL, () => rowsOf({ id: 'claim-1' })],
  ];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      const answer = answers.find(([match]) => match(sql));
      if (!answer) throw new Error(`unexpected SQL: ${sql}`);
      return answer[1]();
    }),
  };
  return { calls, tx: async (fn) => fn(client), queryOne: vi.fn(async () => ({ id: 'claim-1', claimKind: 'duty' })) };
}
describe('addKnowledgeLink', () => {
  it('adds a confirmed link on the unit’s existing notes, naming the object it found, decided by the analyst', async () => {
    const db = fakeDb({ notes: 'iv-1', object: 'obj-1' });
    const row = await addKnowledgeLink(db, CTX, { kind: 'duty', value: 'Works council member', identityId: ANNA }, 'ann@x');
    expect(row).toEqual({ id: 'claim-1', claimKind: 'duty' });
    const insert = db.calls.find(c => c.sql === INSERT_LINK_SQL);
    expect(insert.params).toEqual(['iv-1', CTX, 'duty', null, ANNA, 'Anna Vos', 'Works council member', null, 'confirmed', 'ann@x', 'obj-1']);
    expect(db.calls.some(c => c.sql === INSERT_NOTES_SQL)).toBe(false);
    expect(db.calls.find(c => c.sql === NOTES_SOURCE_SQL).params).toEqual([CTX, ANALYST_NOTES]);
  });

  it('creates the notes source on first use, and leaves a proposed link without object or decider', async () => {
    const db = fakeDb();
    await addKnowledgeLink(db, CTX, { kind: 'activity', value: 'Handle claims', principalId: ANNA, status: 'proposed' }, 'ann@x');
    expect(db.calls.find(c => c.sql === INSERT_NOTES_SQL).params).toEqual([CTX, 'ann@x', ANALYST_NOTES, 'ann@x']);
    const insert = db.calls.find(c => c.sql === INSERT_LINK_SQL);
    expect(insert.params).toEqual(['iv-new', CTX, 'activity', ANNA, null, 'Anna Vos', 'Handle claims', null, 'proposed', null, null]);
    expect(db.calls.some(c => c.sql === FIND_OBJECT_SQL)).toBe(false);
  });

  it('creates the object when no object has the name yet', async () => {
    const db = fakeDb({ notes: 'iv-1' });
    await addKnowledgeLink(db, CTX, { kind: 'expertise', value: 'Fraud', identityId: ANNA }, undefined);
    expect(db.calls.find(c => c.sql === INSERT_LINK_SQL).params.slice(-2)).toEqual([null, 'obj-new']);
  });

  it('refuses a missing context, a missing person and a malformed context id', async () => {
    await expect(addKnowledgeLink(fakeDb({ context: null }), CTX, { kind: 'duty', value: 'X', identityId: ANNA })).rejects.toMatchObject({ status: 404, message: 'Context not found' });
    await expect(addKnowledgeLink(fakeDb({ person: null }), CTX, { kind: 'duty', value: 'X', identityId: ANNA })).rejects.toMatchObject({ status: 404, message: 'Identity not found' });
    await expect(addKnowledgeLink(fakeDb({ person: null }), CTX, { kind: 'duty', value: 'X', principalId: ANNA })).rejects.toMatchObject({ message: 'Principal not found' });
    await expect(addKnowledgeLink(fakeDb(), 'x', { kind: 'duty', value: 'X', identityId: ANNA })).rejects.toMatchObject({ status: 400 });
  });

  it('stores a hand-made link as the analyst’s, about a person, of high relevance — never access', () => {
    expect(INSERT_LINK_SQL).toMatch(/'Person', \$4, \$5, \$6, 'key', \$7, \$8, 1, 'high', \$9, 'analyst'/);
    expect(INSERT_LINK_SQL + INSERT_NOTES_SQL).not.toMatch(/ResourceAssignments|ContextMembers/);
  });
});

describe('peopleWithObject', () => {
  it('reads the claims naming one object, and refuses a malformed id', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ displayName: 'Bram' }] })) };
    expect(await peopleWithObject(db, ANNA)).toEqual([{ displayName: 'Bram' }]);
    expect(db.query).toHaveBeenCalledWith(PEOPLE_WITH_OBJECT_SQL, [ANNA]);
    await expect(peopleWithObject(db, 'nope')).rejects.toMatchObject({ status: 400 });
  });
});
