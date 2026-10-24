// The survey SQL module's own decisions — what it sends, not whether the SQL
// is right (that is contract-tests/surveyTemplates.contract.test.js).
import { describe, it, expect, vi } from 'vitest';
import * as store from './store.js';

const db = (rows = [], rowCount = rows.length) => ({
  query: vi.fn(async () => ({ rows, rowCount })),
  queryOne: vi.fn(async () => rows[0] ?? null),
});

describe('templates', () => {
  it('listTemplates: one category or all, archived only when asked', async () => {
    const d = db([{ id: 't' }]);
    await store.listTemplates(d, { category: 'LogicalApplication' });
    await store.listTemplates(d, { includeArchived: true });
    expect(d.query.mock.calls[0][1]).toEqual(['LogicalApplication', false]);
    expect(d.query.mock.calls[1][1]).toEqual([null, true]);
  });

  it('updateTemplate: a field not given keeps its value; null clears a description and a scope', async () => {
    const d = db();
    await store.updateTemplate(d, 'id', { name: 'N' });
    expect(d.query.mock.calls[0][1]).toEqual(['id', 'N', false, null, null, false, null, null, false, null]);
    await store.updateTemplate(d, 'id', { description: null, scopeRootContextId: null, currentVersion: 4, archivedAt: null });
    expect(d.query.mock.calls[1][1]).toEqual(['id', null, true, null, null, true, null, 4, true, null]);
  });

  it('insertVersion stores the definition as JSON', async () => {
    const d = db();
    await store.insertVersion(d, 't', 2, { a: 1 }, 'me');
    expect(d.query.mock.calls[0][1]).toEqual(['t', 2, '{"a":1}', 'me']);
  });

  it('accountablesOf is a map by context, and asks nothing for no contexts', async () => {
    const d = db([{ contextId: 'c1', principalId: 'p' }]);
    expect(await store.accountablesOf(d, [])).toEqual(new Map());
    expect(d.query).not.toHaveBeenCalled();
    expect((await store.accountablesOf(d, ['c1'])).get('c1')).toEqual({ contextId: 'c1', principalId: 'p' });
  });

  it('personName reads the right table, and the id when there is no name', async () => {
    const d = db([{ displayName: null }]);
    expect(await store.personName(d, 'identityId', 'i1')).toBe('i1');
    expect(d.queryOne.mock.calls[0][0]).toMatch(/FROM "Identities"/);
    expect(await store.personName(db([]), 'principalId', 'p1')).toBeNull();
  });
});

describe('requests', () => {
  it('insertRequests sends one statement for all, nothing for none', async () => {
    const d = db([{ id: 'r1', contextId: 'c' }]);
    expect(await store.insertRequests(d, [])).toEqual([]);
    expect(d.query).not.toHaveBeenCalled();
    await store.insertRequests(d, [{ contextId: 'c' }]);
    expect(d.query.mock.calls[0][0]).toMatch(/jsonb_to_recordset\(\$1::jsonb\)/);
  });

  it('a person\'s surveys count their account, their person and their person\'s other accounts', async () => {
    const d = db([{ x: 1 }]);
    expect(await store.hasSurvey(d, 'p', 'i')).toBe(true);
    expect(d.queryOne.mock.calls[0][0]).toMatch(/"IdentityMembers" m WHERE m."identityId" = \$2::uuid/);
    expect(d.queryOne.mock.calls[0][0]).toMatch(/status <> 'cancelled'/);
    expect(await store.isRecipient(db([]), 'r', 'p', null)).toBe(false);
  });

  it('getRequest locks only when asked', async () => {
    const d = db([{ id: 'r' }]);
    await store.getRequest(d, 'r');
    await store.getRequest(d, 'r', { lock: true });
    expect(d.queryOne.mock.calls[0][0]).not.toMatch(/FOR UPDATE/);
    expect(d.queryOne.mock.calls[1][0]).toMatch(/FOR UPDATE OF q$/);
  });

  it('saveAnswers only writes an unanswered request; cancelRequest says how many it withdrew', async () => {
    const d = db([], 0);
    await store.saveAnswers(d, 'r', { a: 'yes' });
    expect(d.query.mock.calls[0]).toEqual([expect.stringMatching(/WHERE id = \$1 AND status = 'sent'/), ['r', '{"a":"yes"}']]);
    expect(await store.cancelRequest(d, 'r')).toBe(0);
  });

  it('markSubmitted keeps the request\'s language when none is given', async () => {
    const d = db();
    await store.markSubmitted(d, 'r', { answers: {}, interviewId: 'iv', user: 'u', onBehalf: 1 });
    expect(d.query.mock.calls[0][1]).toEqual(['r', '{}', 'iv', 'u', true, null]);
  });
});

describe('searchPeople', () => {
  it('matches name or e-mail as a substring, with the LIKE wildcards in the term taken literally', async () => {
    const d = db([]);
    await store.searchPeople(d, '50%_a\\b');
    expect(d.query.mock.calls[0][1]).toEqual(['%50\\%\\_a\\\\b%', 10]);
    expect(d.query.mock.calls[0][0]).toMatch(/"deletedAt" IS NULL AND "principalType" = 'User'/);
  });
});

describe('rows', () => {
  it('row statements read a list of contexts and are capped', async () => {
    for (const sql of [store.MEMBER_ROWS_SQL, store.RESOURCE_ROWS_SQL, store.CHILD_ROWS_SQL]) {
      expect(sql).toMatch(/= ANY\(\$1::uuid\[\]\)/);
      expect(sql).toMatch(new RegExp(`LIMIT ${store.MAX_ROWS}$`));
    }
    const d = db([{ id: 'r' }]);
    expect(await store.rowsFrom(d, store.CHILD_ROWS_SQL, ['c'])).toEqual([{ id: 'r' }]);
    expect(d.query.mock.calls[0][1]).toEqual([['c']]);
  });

  it('a resource\'s owner is who holds its ownership resource, else its source\'s owner attribute', () => {
    expect(store.RESOURCE_ROWS_SQL).toMatch(/"relationshipType" IN \('HasOwnership', 'HasAppOwnership'\)\),\s+r\."extendedAttributes"->>'owner'\) AS owner/);
  });
});
