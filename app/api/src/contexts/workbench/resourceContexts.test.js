import { describe, it, expect, vi } from 'vitest';
import { attachContexts, withContexts, COLUMN_CONTEXTS_SQL, CONTEXT_ANCESTRY_SQL } from './resourceContexts.js';

const cols = [{ id: 'R1' }, { id: 'r2' }];

describe('attachContexts', () => {
  it('gives each column the ids of its contexts, matching ids in any case, and none when it has none', () => {
    const out = attachContexts(cols, [{ resourceId: 'r1', id: 'tag' }, { resourceId: 'r1', id: 'app' }]);
    expect(out).toEqual([{ id: 'R1', contexts: ['tag', 'app'] }, { id: 'r2', contexts: [] }]);
    expect(cols[0]).not.toHaveProperty('contexts');
  });
});

describe('withContexts', () => {
  it('reads the columns\' contexts, then those contexts and their parents', async () => {
    const tree = [{ id: 'sub', displayName: 'Sub', contextType: 'App', parentId: 'app' }, { id: 'app', displayName: 'App', contextType: 'App', parentId: null }];
    const db = { query: vi.fn(async (sql) => ({ rows: sql === COLUMN_CONTEXTS_SQL ? [{ resourceId: 'r2', id: 'sub' }, { resourceId: 'R1', id: 'sub' }] : tree })) };
    const out = await withContexts(db, cols);
    expect(db.query.mock.calls).toEqual([[COLUMN_CONTEXTS_SQL, [['R1', 'r2']]], [CONTEXT_ANCESTRY_SQL, [['sub']]]]);
    expect(out.columns.map(c => c.contexts)).toEqual([['sub'], ['sub']]);
    expect(out.contexts).toBe(tree);
  });

  it('asks for no parents when no column is in a context, and nothing without columns', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await withContexts(db, cols)).toEqual({ columns: [{ id: 'R1', contexts: [] }, { id: 'r2', contexts: [] }], contexts: [] });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(await withContexts(db, [])).toEqual({ columns: [], contexts: [] });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('answers no contexts rather than failing when the context tables are not there', async () => {
    const db = { query: vi.fn(async () => { throw new Error('relation "ContextMembers" does not exist'); }) };
    expect(await withContexts(db, cols)).toEqual({ columns: [{ id: 'R1', contexts: [] }, { id: 'r2', contexts: [] }], contexts: [] });
  });

  it('walks up the parents, each context once', () => {
    expect(CONTEXT_ANCESTRY_SQL).toMatch(/WITH RECURSIVE up/);
    expect(CONTEXT_ANCESTRY_SQL).toMatch(/UNION\s+SELECT/);
    expect(CONTEXT_ANCESTRY_SQL).not.toMatch(/UNION ALL/);
  });
});
