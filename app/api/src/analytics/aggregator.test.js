// runDataset wiring with a scripted database: suppression, the row guard,
// coverage of unavailable months and the response contract. The SQL itself is
// exercised against PostgreSQL in contract-tests/analyticsDatasets.contract.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { runDataset, resolveDims } from './aggregator.js';
import { validateDefinition } from './profileSchema.js';
import { AnalyticsError } from './shaping.js';

const NOW = new Date('2026-03-15T10:00:00Z');

function profileWith(datasets, extra = {}) {
  const { definition, errors } = validateDefinition({
    dimensions: [{ field: 'Principal.accountEnabled' }, { field: 'Identity.department', label: 'Dept' }],
    datasets,
    ...extra,
  });
  expect(errors).toEqual([]);
  return { id: 'p1', name: 'Workforce', version: 3, status: 'active', definition };
}

// Route each statement to a scripted answer by what it reads.
function script(handlers) {
  query.mockImplementation(async (sql) => {
    for (const [match, rows] of handlers) if (sql.includes(match)) return { rows: typeof rows === 'function' ? rows(sql) : rows };
    return { rows: [] };
  });
}

// Braces matter: a function returned from beforeEach is run as a cleanup hook.
beforeEach(() => { query.mockReset(); });

describe('runDataset - snapshot metrics', () => {
  it('returns named joint rows, suppresses small cells and carries versions and freshness', async () => {
    script([
      ['FROM "Systems"', [{ lastSyncAt: '2026-03-14T02:00:00Z', systems: 2, neverSynced: 0 }]],
      ['FROM "Principals" p', [
        { d0: 'true', d1: 'Finance', accounts: 12 },
        { d0: 'false', d1: 'Finance', accounts: 2 },
      ]],
    ]);
    const out = await runDataset(profileWith([{ id: 'a', metric: 'principals.count', dimensions: ['Principal.accountEnabled', 'Identity.department'] }]), 'a', { now: NOW });
    expect(out.rows).toEqual([
      { 'Principal.accountEnabled': 'true', 'Identity.department': 'Finance', accounts: 12, suppressed: false },
      { 'Principal.accountEnabled': 'false', 'Identity.department': 'Finance', accounts: null, suppressed: true },
    ]);
    expect(out.suppression).toEqual({ minGroupSize: 5, suppressedCells: 1 });
    expect(out.profile).toEqual({ id: 'p1', name: 'Workforce', version: 3 });
    expect(out.dataset).toMatchObject({ id: 'a', metric: 'principals.count', metricVersion: 1, historyMethod: 'current' });
    expect(out.freshness).toMatchObject({ lastSyncAt: '2026-03-14T02:00:00.000Z', systemsInScope: 2, systemsNeverSynced: 0 });
    expect(out.columns.find(c => c.name === 'Identity.department')).toMatchObject({ label: 'Dept', iri: 'https://identityatlas.io/ontology#department' });
    expect(out.generatedAt).toBe(NOW.toISOString());
    expect(out.coverage).toBeNull();
  });

  it('sets a statement timeout inside the transaction before any query', async () => {
    script([]);
    await runDataset(profileWith([{ id: 'a', metric: 'principals.count', dimensions: [] }]), 'a', { now: NOW });
    expect(query.mock.calls[0][0]).toBe('SET LOCAL statement_timeout = 120000');
  });

  it('derives the governed measures and returns the exclusions', async () => {
    script([
      ['"hiddenResourceTypePairs"', [{ hiddenResourceTypePairs: 4, groupHolderPairs: 1 }]],
      ['FROM pairs pr', [{ d0: 'true', pairs: 20, governedPairs: 5, holders: 9 }]],
    ]);
    const out = await runDataset(profileWith([{ id: 'g', metric: 'assignments.governedShare', dimensions: ['Principal.accountEnabled'] }]), 'g', { now: NOW });
    expect(out.rows).toEqual([{ 'Principal.accountEnabled': 'true', pairs: 20, governedPairs: 5, ungovernedPairs: 15, unknownPairs: 0, governedShare: 0.25, holders: 9, suppressed: false }]);
    expect(out.excluded).toEqual({ hiddenResourceTypePairs: 4, groupHolderPairs: 1 });
  });

  it('refuses - never truncates - a result over limits.maxRows', async () => {
    script([['FROM "Principals" p', [{ d0: 'a', accounts: 9 }, { d0: 'b', accounts: 9 }, { d0: 'c', accounts: 9 }]]]);
    const profile = profileWith([{ id: 'a', metric: 'principals.count', dimensions: ['Principal.accountEnabled'] }], { limits: { maxRows: 2 } });
    await expect(runDataset(profile, 'a', { now: NOW })).rejects.toMatchObject({ status: 422, code: 'dataset_too_large' });
  });
});

describe('runDataset - reconstructed history', () => {
  it('labels each month, skips months before historyStart and reports them as unavailable', async () => {
    const asofCalls = [];
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('MIN("changedAt")')) return { rows: [{ start: '2026-02-10T00:00:00Z' }] };
      if (sql.includes('asof_principals')) {
        asofCalls.push(params.at(-1));
        return { rows: [{ d0: 'true', accounts: 7 }] };
      }
      return { rows: [] };
    });
    const profile = profileWith([{ id: 't', metric: 'principals.countAsOf', dimensions: ['Principal.accountEnabled'], periods: 3 }]);
    const out = await runDataset(profile, 't', { now: NOW });
    // January ends before history starts: not queried, not zero, listed.
    expect(asofCalls).toEqual(['2026-02-28T23:59:59.999Z', '2026-03-15T10:00:00.000Z']);
    expect(out.rows.map(r => [r.period, r.historyMethod, r.periodComplete, r.accounts])).toEqual([
      ['2026-02', 'reconstructed', true, 7],
      ['2026-03', 'current', false, 7],
    ]);
    expect(out.coverage).toMatchObject({ historyStart: '2026-02-10T00:00:00.000Z', periods: ['2026-02', '2026-03'], unavailablePeriods: ['2026-01'] });
    expect(out.coverage.reason).toMatch(/not estimated/);
    expect(out.columns.slice(0, 4).map(c => c.name)).toEqual(['period', 'periodEnd', 'periodComplete', 'historyMethod']);
  });

  it('counts the row limit across all months together', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('MIN("changedAt")')) return { rows: [{ start: '2020-01-01T00:00:00Z' }] };
      if (sql.includes('asof_principals')) return { rows: [{ d0: 'true', accounts: 7 }] };
      return { rows: [] };
    });
    const profile = profileWith([{ id: 't', metric: 'principals.countAsOf', dimensions: ['Principal.accountEnabled'], periods: 3 }], { limits: { maxRows: 2 } });
    await expect(runDataset(profile, 't', { now: NOW })).rejects.toMatchObject({ code: 'dataset_too_large' });
  });
});

describe('runDataset - refusals', () => {
  const profile = profileWith([{ id: 'a', metric: 'principals.count', dimensions: [] }]);

  it('refuses a retired profile and an unknown dataset', async () => {
    await expect(runDataset({ ...profile, status: 'retired' }, 'a')).rejects.toMatchObject({ status: 409, code: 'profile_retired' });
    await expect(runDataset(profile, 'nope')).rejects.toMatchObject({ status: 404 });
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a stored profile whose field no longer exists', () => {
    const broken = { ...profile.definition, dimensions: [] };
    expect(() => resolveDims(broken, { dimensions: ['Principal.accountEnabled'] })).toThrow(AnalyticsError);
  });
});
