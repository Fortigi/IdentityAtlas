// The runner's one-root rule, end to end through enqueueRun → reconcile with the
// shared (SQL-blind) db mock: what is inserted, what is updated, and which
// parent each node is linked to.
//
// A run with several roots (department-from-principal: one context per
// department) gets one root named after the plugin; a re-run reuses that
// root's row; a tree a previous run left flat has its old roots moved under
// the new root, keeping their ids; a single-root plugin is left as it is.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';

const PLUGIN = {
  name: 'department-from-principal', displayName: 'Department from Principal', rootDisplayName: 'Departments',
  targetType: 'Principal', contextCategory: 'OrganizationalUnit', contextTypes: ['Department'], parametersSchema: {}, run: vi.fn(),
};
vi.mock('./registry.js', () => ({ getPlugin: () => PLUGIN }));

const { enqueueRun } = await import('./runner.js');

const DEPTS = [
  { externalId: 'dept:Sales', displayName: 'Sales', contextType: 'Department' },
  { externalId: 'dept:Ops', displayName: 'Ops', contextType: 'Department' },
];

// existing: the rows loadExistingContexts returns for this tree.
function wire({ contexts, existing = [] }) {
  PLUGIN.run.mockReset().mockResolvedValue({ contexts, members: [] });
  query.mockReset().mockImplementation(async (sql) => {
    if (/SELECT id, "externalId", "userReparented" FROM "Contexts"/.test(sql)) return { rows: existing };
    return { rows: [], rowCount: 0 };
  });
  queryOne.mockReset().mockResolvedValue({ id: 'algo-1' });
}

const run = () => enqueueRun('department-from-principal', { instanceKey: 'tree-1' }, 'test', { awaitCompletion: true });
const calls = re => query.mock.calls.filter(([sql]) => re.test(sql));
// INSERT params: [id, targetType, contextType, displayName, description, scope, algo, run, externalId, ext, ikey, category]
const inserted = () => calls(/INSERT INTO "Contexts"/).map(([, p]) => ({ id: p[0], type: p[2], name: p[3], description: p[4], externalId: p[8], ikey: p[10], category: p[11] }));
const updatedIds = () => calls(/UPDATE "Contexts"\s+SET "displayName"/).map(([, p]) => p[0]);
const parentLinks = () => Object.fromEntries(calls(/SET "parentContextId" = \$2 WHERE id = \$1/).map(([, p]) => [p[0], p[1]]));
const runStatus = () => calls(/UPDATE "ContextAlgorithmRuns"\s+SET status = '(succeeded|failed)'/).map(([sql]) => /succeeded/.test(sql) ? 'succeeded' : 'failed');

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('runner: one root per plugin run', () => {
  it('a fresh run with several roots inserts one plugin root and links every department under it', async () => {
    wire({ contexts: DEPTS });
    await run();
    expect(runStatus()).toEqual(['succeeded']);
    const rows = inserted();
    expect(rows.map(r => r.externalId)).toEqual(['__plugin-root__', 'dept:Sales', 'dept:Ops']);
    const root = rows[0];
    expect(root).toMatchObject({ name: 'Departments', type: 'Department', category: 'OrganizationalUnit', ikey: 'tree-1', description: 'Created by the Department from Principal rule.' });
    const links = parentLinks();
    expect(links[rows[1].id]).toBe(root.id);
    expect(links[rows[2].id]).toBe(root.id);
    expect(links[root.id]).toBeUndefined(); // the root itself stays a root
  });

  it('a re-run reuses the root row: updated in place, no new insert, same id as parent', async () => {
    wire({ contexts: DEPTS, existing: [
      { id: 'root-id', externalId: '__plugin-root__', userReparented: false },
      { id: 'sales-id', externalId: 'dept:Sales', userReparented: false },
      { id: 'ops-id', externalId: 'dept:Ops', userReparented: false },
    ] });
    await run();
    expect(inserted()).toEqual([]);
    expect(updatedIds()).toEqual(['root-id', 'sales-id', 'ops-id']);
    expect(parentLinks()).toEqual({ 'sales-id': 'root-id', 'ops-id': 'root-id' });
    expect(calls(/DELETE FROM "Contexts"/)).toEqual([]);
  });

  it('a tree a previous run left flat gets the new root, and its old roots move under it keeping their ids', async () => {
    wire({ contexts: DEPTS, existing: [
      { id: 'sales-id', externalId: 'dept:Sales', userReparented: false },
      { id: 'ops-id', externalId: 'dept:Ops', userReparented: false },
    ] });
    await run();
    const rows = inserted();
    expect(rows.map(r => r.externalId)).toEqual(['__plugin-root__']);
    expect(updatedIds()).toEqual(['sales-id', 'ops-id']);
    expect(parentLinks()).toEqual({ 'sales-id': rows[0].id, 'ops-id': rows[0].id });
    expect(calls(/DELETE FROM "Contexts"/)).toEqual([]);
  });

  it('leaves an analyst-moved department where the analyst put it', async () => {
    wire({ contexts: DEPTS, existing: [
      { id: 'root-id', externalId: '__plugin-root__', userReparented: false },
      { id: 'sales-id', externalId: 'dept:Sales', userReparented: true },
      { id: 'ops-id', externalId: 'dept:Ops', userReparented: false },
    ] });
    await run();
    expect(parentLinks()).toEqual({ 'ops-id': 'root-id' });
  });

  it('a single-root run gets no extra root', async () => {
    wire({ contexts: [
      { externalId: 'org', displayName: 'Organization', contextType: 'Department' },
      { externalId: 'm1', displayName: 'Bob', contextType: 'Department', parentExternalId: 'org' },
    ] });
    await run();
    const rows = inserted();
    expect(rows.map(r => r.externalId)).toEqual(['org', 'm1']);
    expect(parentLinks()).toEqual({ [rows[1].id]: rows[0].id });
  });

  it('an empty run removes the whole tree, root included', async () => {
    wire({ contexts: [], existing: [
      { id: 'root-id', externalId: '__plugin-root__', userReparented: false },
      { id: 'sales-id', externalId: 'dept:Sales', userReparented: false },
    ] });
    await run();
    const [del] = calls(/DELETE FROM "Contexts" WHERE id = ANY/);
    expect(del[1][0]).toEqual(['root-id', 'sales-id']);
  });
});
