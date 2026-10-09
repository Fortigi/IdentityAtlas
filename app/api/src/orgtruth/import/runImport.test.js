import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('../linking/run.js', () => ({ linkRun: vi.fn(async ({ runId }) => ({ runId, linked: 3, proposed: 1, ambiguous: 0, none: 2 })) }));
vi.mock('../../contexts/plugins/runner.js', () => ({ enqueueRun: vi.fn(async () => ({ id: 'ctx-run' })) }));

import { query, queryOne } from '../../db/connection.js';
import { linkRun } from '../linking/run.js';
import { enqueueRun } from '../../contexts/plugins/runner.js';
import { normalizeRecipe } from '../contracts.js';
import {
  executeImportRun, startImportRun, createImportRun, findActiveRun, ISSUE_SAMPLE_LIMIT,
} from './runImport.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';
const PROF = '33333333-3333-4333-8333-333333333333';

const recipe = normalizeRecipe({
  version: 1,
  entities: [{ type: 'Project', keyColumn: 'Code', nameColumn: 'Project' }, { type: 'Person', nameColumn: 'Owner' }],
  relations: [{ predicate: 'owner', from: 'Project', to: 'Person' }],
});
const profile = { id: PROF, name: 'Projects', version: 2, recipe, linkRules: [] };
const source = { id: SRC, observedAt: '2026-10-01T00:00:00.000Z', fileName: 'p.csv', content: Buffer.from('Code,Project,Owner\nP-1,Atlas,Ann\nP-2,Beacon,\n') };

function stage(opts = {}) {
  const { run, src, prof } = { run: { id: RUN, sourceId: SRC, profileId: PROF, mode: 'full' }, src: source, prof: profile, ...opts };
  queryOne.mockImplementation(async (sql) => {
    if (sql.includes('FROM "OrgImportRuns" WHERE')) return run;
    if (sql.includes('FROM "OrgSources"')) return src;
    if (sql.includes('FROM "OrgImportProfiles"')) return prof;
    return undefined;
  });
  query.mockImplementation(async (sql) => {
    if (sql.includes('SELECT')) return { rows: [] };
    return { rowCount: 0, rows: [] };
  });
}

// The UPDATE "OrgImportRuns" calls, as { field: value } objects in order.
const runUpdates = () => query.mock.calls
  .filter(([sql]) => sql.startsWith('UPDATE "OrgImportRuns"'))
  .map(([sql, params]) => {
    const names = [...sql.matchAll(/"(\w+)" = \$\d+/g)].map(m => m[1]);
    expect(params[0]).toBe(RUN);
    return Object.fromEntries(names.map((n, i) => [n, params[i + 1]]));
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('executeImportRun', () => {
  it('walks parse → apply → write → link → project and completes with stats', async () => {
    stage();
    await executeImportRun(RUN);
    const updates = runUpdates();
    expect(updates.map(u => [u.step, u.pct])).toEqual([
      ['parse', 10], ['apply', 30], ['write', 50], ['link', 70], ['project', 90], ['completed', 100],
    ]);
    expect(updates[0]).toMatchObject({ status: 'running' });
    expect(updates[0].startedAt).toMatch(/^\d{4}-/);
    const done = updates.at(-1);
    expect(done.status).toBe('completed');
    expect(done.finishedAt).toMatch(/^\d{4}-/);
    const stats = JSON.parse(done.stats);
    expect(stats).toEqual({
      rows: 2,
      entities: { byType: { Project: { total: 2, duplicateKeys: 0, emptyKeys: 0 }, Person: { total: 1, duplicateKeys: 0, emptyKeys: 0 } } },
      relations: { byPredicate: { owner: 1 } },
      write: { entitiesInserted: 3, entitiesUpdated: 0, entitiesClosed: 0, relationsInserted: 1, relationsUpdated: 0, relationsClosed: 0 },
      links: { runId: RUN, linked: 3, proposed: 1, ambiguous: 0, none: 2 },
      issues: { count: 1, samples: [expect.objectContaining({ kind: 'missingSide', entityType: 'Person', row: 2 })] },
    });

    expect(linkRun).toHaveBeenCalledWith({ runId: RUN, profile, log: expect.any(Function) });
    expect(enqueueRun.mock.calls).toEqual([
      ['org-truth', { instanceKey: 'org-truth' }, 'org-import', { awaitCompletion: true }],
      ['org-truth-principals', { instanceKey: 'org-truth-principals' }, 'org-import', { awaitCompletion: true }],
    ]);
    // full mode: the write step closed what this source no longer has
    expect(query.mock.calls.some(([sql]) => sql.includes('SET "validTo" = $2'))).toBe(true);
  });

  it('keeps going when one projection fails, still runs the other, and logs why', async () => {
    stage();
    enqueueRun.mockRejectedValueOnce(new Error('Unknown plugin: org-truth'));
    await executeImportRun(RUN);
    expect(runUpdates().at(-1).status).toBe('completed');
    expect(console.log).toHaveBeenCalledWith(`[org-import ${RUN}] projection org-truth not run: Unknown plugin: org-truth`);
    expect(enqueueRun).toHaveBeenCalledTimes(2);
  });

  it('caps the stored issue samples', async () => {
    const rows = Array.from({ length: ISSUE_SAMPLE_LIMIT + 3 }, (_, i) => `,Nameless ${i},`).join('\n');
    stage({ src: { ...source, content: Buffer.from(`Code,Project,Owner\n${rows}`) } });
    await executeImportRun(RUN);
    const stats = JSON.parse(runUpdates().at(-1).stats);
    expect(stats.issues.count).toBe(ISSUE_SAMPLE_LIMIT + 3);
    expect(stats.issues.samples).toHaveLength(ISSUE_SAMPLE_LIMIT);
  });

  it.each([
    ['the run is unknown', { run: undefined }, `Import run ${RUN} does not exist.`],
    ['the source is gone', { src: undefined }, 'The run\'s source no longer exists.'],
    ['the profile is gone', { prof: undefined }, 'The run\'s profile no longer exists.'],
    ['the source lacks a recipe column', { src: { ...source, content: Buffer.from('Code,Name\n1,2') } },
      expect.stringMatching(/^The source does not fit profile "Projects" version 2: Entity "Project" nameColumn refers to column "Project", which the source does not have. /)],
    ['the source no longer parses', { src: { ...source, content: Buffer.alloc(0) } }, 'The file is empty.'],
  ])('fails with a sentence when %s, and links nothing', async (_label, opts, message) => {
    stage(opts);
    await executeImportRun(RUN);
    const last = runUpdates().at(-1);
    expect(last).toMatchObject({ status: 'failed', error: message });
    expect(last.finishedAt).toMatch(/^\d{4}-/);
    expect(linkRun).not.toHaveBeenCalled();
  });

  it('fails the run when linking throws', async () => {
    stage();
    linkRun.mockRejectedValueOnce(new Error('linking broke'));
    await executeImportRun(RUN);
    expect(runUpdates().at(-1)).toMatchObject({ status: 'failed', error: 'linking broke' });
    expect(enqueueRun).not.toHaveBeenCalled();
  });
});

describe('startImportRun', () => {
  it('returns at once and reports a crash of the background run instead of throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(new Error('db gone'));
    expect(startImportRun(RUN)).toBeUndefined();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(`Background org-import run ${RUN} crashed:`, expect.any(Error)));
    spy.mockRestore();
  });
});

describe('createImportRun / findActiveRun', () => {
  it('queues a run that records the profile version and who started it', async () => {
    queryOne.mockResolvedValue({ id: 'r', status: 'queued' });
    const out = await createImportRun({ source: { id: SRC }, profile, mode: 'delta', triggeredBy: 'ann' });
    expect(out).toEqual({ id: 'r', status: 'queued' });
    const params = queryOne.mock.calls[0][1];
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params.slice(1)).toEqual([PROF, 2, SRC, 'delta', 'ann']);
  });

  it('finds an active run by profile name across versions, or null', async () => {
    queryOne.mockResolvedValueOnce({ id: 'busy' }).mockResolvedValueOnce(undefined);
    expect(await findActiveRun('Projects')).toEqual({ id: 'busy' });
    expect(queryOne.mock.calls[0][1]).toEqual(['Projects']);
    expect(queryOne.mock.calls[0][0]).toMatch(/'queued', 'running'/);
    expect(await findActiveRun('Projects')).toBeNull();
  });
});
