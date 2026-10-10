import { describe, it, expect } from 'vitest';
import {
  isNotAvailable, fetchBlocked, rowsOf, totalOf, pageParam, buildQuery, splitSignals,
  statusPillClass, pillColorClass, targetDetailKind, targetTypeLabel, runStatsSummary, runsForSource,
  lastProfileId, attributeEntries,
} from './orgFormat';

describe('isNotAvailable', () => {
  it('is true only for the 501 the router answers for an unbuilt route', () => {
    expect(isNotAvailable(new Error('HTTP 501'))).toBe(true);
    expect(isNotAvailable(new Error('HTTP 500'))).toBe(false);
    expect(isNotAvailable(new Error('HTTP 5010'))).toBe(false);
    expect(isNotAvailable(null)).toBe(false);
  });
});

describe('fetchBlocked', () => {
  it('blocks on an error, and on a first load without data', () => {
    expect(fetchBlocked({ error: new Error('x'), loading: false, data: [1] })).toBe(true);
    expect(fetchBlocked({ error: null, loading: true, data: null })).toBe(true);
  });
  it('keeps old data on screen during a reload, and passes loaded data', () => {
    expect(fetchBlocked({ error: null, loading: true, data: [] })).toBe(false);
    expect(fetchBlocked({ error: null, loading: false, data: null })).toBe(false);
    expect(fetchBlocked(undefined)).toBe(false);
  });
});

describe('rowsOf / totalOf', () => {
  it('reads a bare array, { data }, and { rows }', () => {
    expect(rowsOf([1, 2])).toEqual([1, 2]);
    expect(rowsOf({ data: [3] })).toEqual([3]);
    expect(rowsOf({ rows: [4] })).toEqual([4]);
    expect(rowsOf({ data: 'nope' })).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
  });
  it('prefers the server total over the page length', () => {
    expect(totalOf({ data: [1, 2], total: 120 })).toBe(120);
    expect(totalOf({ data: [1, 2], total: 0 })).toBe(0);
    expect(totalOf([1, 2, 3])).toBe(3);
  });
});

describe('pageParam / buildQuery', () => {
  it('sends the 0-based UI page as a 1-based wire page', () => {
    expect(pageParam(0)).toBe('1');
    expect(pageParam(4)).toBe('5');
  });
  it('drops empty values and encodes true as 1', () => {
    expect(buildQuery({ type: '', q: 'a b', status: null, includeClosed: true, x: false, n: 0 }))
      .toBe('?q=a+b&includeClosed=1&n=0');
    expect(buildQuery({ type: '' })).toBe('');
    expect(buildQuery(undefined)).toBe('');
  });
});

describe('splitSignals', () => {
  it('splits the stored CSV and trims, keeping an array as is', () => {
    expect(splitSignals('email, name,,')).toEqual(['email', 'name']);
    expect(splitSignals(['prefix', ''])).toEqual(['prefix']);
    expect(splitSignals(null)).toEqual([]);
    expect(splitSignals(42)).toEqual([]);
  });
});

describe('statusPillClass', () => {
  it('colours by status family, unknown is gray', () => {
    expect(statusPillClass('accepted')).toContain('green');
    expect(statusPillClass('completed')).toContain('green');
    expect(statusPillClass('proposed')).toContain('amber');
    expect(statusPillClass('running')).toContain('blue');
    expect(statusPillClass('failed')).toContain('red');
    expect(statusPillClass('rejected')).toContain('red');
    expect(statusPillClass('whatever')).toContain('gray');
    expect(statusPillClass('accepted')).toContain('dark:');
  });

  it('gives a colour family its own fill, an unknown one gray', () => {
    expect(pillColorClass('amber')).toBe(statusPillClass('proposed'));
    expect(pillColorClass('gray')).toBe(statusPillClass('closed'));
    expect(pillColorClass('purple')).toBe(statusPillClass('closed'));
    expect(pillColorClass(undefined)).toContain('bg-gray-100');
  });
});

describe('target helpers', () => {
  it('maps a link target type to its detail-tab kind', () => {
    expect(targetDetailKind('Principal')).toBe('user');
    expect(targetDetailKind('Resource')).toBe('resource');
    expect(targetDetailKind('Identity')).toBe('identity');
    expect(targetDetailKind('Context')).toBe('context');
    expect(targetDetailKind('Other')).toBeNull();
  });
  it('names the target types for people', () => {
    expect(targetTypeLabel('Principal')).toBe('Account');
    expect(targetTypeLabel('Resource')).toBe('Resource');
    expect(targetTypeLabel('Mystery')).toBe('Mystery');
    expect(targetTypeLabel(undefined)).toBe('');
  });
});

describe('runStatsSummary', () => {
  it('sums the per-type and per-predicate counts and the link outcome', () => {
    const stats = {
      entities: { byType: { Project: 87, Person: 61 } },
      relations: { byPredicate: { owner: 85 } },
      links: { linked: 51, proposed: 9 },
    };
    expect(runStatsSummary(stats)).toBe('148 entities · 85 relations · 51 linked · 9 proposed');
  });
  it('reads accepted when there is no linked, and leaves out zero parts', () => {
    expect(runStatsSummary({ links: { accepted: 3 } })).toBe('3 linked · 0 proposed');
    expect(runStatsSummary({ entities: { byType: { A: 2 } } })).toBe('2 entities');
    expect(runStatsSummary({})).toBe('');
    expect(runStatsSummary(null)).toBe('');
  });
});

describe('runsForSource / lastProfileId', () => {
  const runs = [
    { id: 'r1', sourceId: 's1', createdAt: '2026-10-01T10:00:00Z', profileId: 'p-old' },
    { id: 'r2', sourceId: 's2', createdAt: '2026-10-05T10:00:00Z', profileId: 'p-other' },
    { id: 'r3', sourceId: 's1', createdAt: '2026-10-03T10:00:00Z', profileId: null },
    { id: 'r4', sourceId: 's1', startedAt: '2026-10-02T10:00:00Z', profileId: 'p-mid' },
  ];
  it('keeps the runs of one source, newest first', () => {
    expect(runsForSource(runs, 's1').map(r => r.id)).toEqual(['r3', 'r4', 'r1']);
    expect(runsForSource(null, 's1')).toEqual([]);
  });
  it('takes the profile of the newest run that has one', () => {
    expect(lastProfileId(runsForSource(runs, 's1'))).toBe('p-mid');
    expect(lastProfileId([{ profileId: null }])).toBeNull();
    expect(lastProfileId(undefined)).toBeNull();
  });
});

describe('attributeEntries', () => {
  it('lists the core fields, then the imported attributes as extended', () => {
    const rows = attributeEntries({
      canonicalKey: 'p-100', origin: 'import', confidence: 90, validFrom: null, validTo: null,
      attributes: { budget: '1200', costCenter: 'CC-7' },
    });
    expect(rows.slice(0, 3)).toEqual([['canonicalKey', 'p-100'], ['origin', 'import'], ['confidence', 90]]);
    expect(rows.slice(5)).toEqual([['budget', '1200', { extended: true }], ['costCenter', 'CC-7', { extended: true }]]);
    expect(attributeEntries({})).toHaveLength(5);
  });
});

describe('isCollectionTemplate / isMissingRoute / readErrorDetail', () => {
  it('treats a missing template as a collection and every other template as not one', async () => {
    const { isCollectionTemplate } = await import('./orgFormat');
    expect(isCollectionTemplate(undefined)).toBe(true);
    expect(isCollectionTemplate(null)).toBe(true);
    expect(isCollectionTemplate('collection')).toBe(true);
    for (const t of ['enrichment', 'activity', 'relation', '']) expect(isCollectionTemplate(t)).toBe(false);
  });

  it('calls a 404 or 501 a missing route, and no other failure', async () => {
    const { isMissingRoute } = await import('./orgFormat');
    expect(isMissingRoute(new Error('HTTP 404'))).toBe(true);
    expect(isMissingRoute(new Error('HTTP 501'))).toBe(true);
    expect(isMissingRoute(new Error('HTTP 500'))).toBe(false);
    expect(isMissingRoute(null)).toBe(false);
  });

  it('reads the error sentence of a refusal, and nothing from a body without one or that is not JSON', async () => {
    const { readErrorDetail } = await import('./orgFormat');
    expect(await readErrorDetail({ json: async () => ({ error: 'bad target' }) })).toBe('bad target');
    expect(await readErrorDetail({ json: async () => ({}) })).toBe('');
    expect(await readErrorDetail({ json: async () => { throw new Error('not json'); } })).toBe('');
  });
});
