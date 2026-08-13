// Unit tests for the pure risk-summary builders (#1035). The DB-bound
// fetchRiskOverview is covered end-to-end by the risk-scores route tests.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js'); // manual mock — summary.js pulls in db via shared.js

const { buildTiersByEntityType, indexTotalsByType, buildRiskSummary } = await import('./summary.js');

describe('buildTiersByEntityType', () => {
  it('nests tier counts by entity type and defaults a null tier to None', () => {
    const out = buildTiersByEntityType([
      { entityType: 'Principal', riskTier: 'High', count: 3 },
      { entityType: 'Principal', riskTier: null, count: 2 },
      { entityType: 'Resource', riskTier: 'Low', count: 5 },
    ]);
    expect(out).toEqual({
      Principal: { High: 3, None: 2 },
      Resource: { Low: 5 },
    });
  });
});

describe('indexTotalsByType', () => {
  it('keys totals rows by entity type', () => {
    expect(indexTotalsByType([{ entityType: 'Resource', total: 9, overrides: 1 }]))
      .toEqual({ Resource: { entityType: 'Resource', total: 9, overrides: 1 } });
  });
});

describe('buildRiskSummary', () => {
  it('maps per-type totals/overrides/tiers and defaults missing types to 0/{}', () => {
    const s = buildRiskSummary({
      tierRows: [{ entityType: 'Principal', riskTier: 'High', count: 4 }],
      totalsRows: [{ entityType: 'Principal', total: 10, overrides: 2 }],
      topUsers: [{ entityId: 'u1' }],
      topResources: [{ entityId: 'r1' }],
      resourceTypeBreakdown: [{ resourceType: 'Group', count: 3 }],
    });
    expect(s.totalUsers).toBe(10);
    expect(s.userOverrides).toBe(2);
    expect(s.usersByTier).toEqual({ High: 4 });
    // A type with no rows falls back cleanly.
    expect(s.totalGroups).toBe(0);
    expect(s.groupsByTier).toEqual({});
    expect(s.topUsers).toHaveLength(1);
    expect(s.topGroups).toHaveLength(1);
    expect(s.resourceTypeBreakdown).toEqual([{ resourceType: 'Group', count: 3 }]);
  });
});
