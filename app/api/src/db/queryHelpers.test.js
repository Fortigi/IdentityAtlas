// Unit tests for db/queryHelpers.js — queryRiskScoresPage builds a paginated
// data + count query around a caller-supplied JOIN/WHERE whose $N placeholders
// are already bound in `params`. The data query appends LIMIT/OFFSET as the next
// two placeholders; the COUNT query takes just the filter params. DB mocked at
// the timedQuery boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = [];
vi.mock('../perf/sqlTimer.js', () => ({
  timedQuery: (_pool, label, _res, text, values) => {
    captured.push({ label, text, values });
    return Promise.resolve(
      label.endsWith('-count')
        ? { rows: [{ total: 7 }] }
        : { rows: [{ id: 1 }, { id: 2 }] },
    );
  },
}));

const { queryRiskScoresPage } = await import('./queryHelpers.js');

beforeEach(() => { captured.length = 0; });

describe('queryRiskScoresPage', () => {
  it('runs a data + count query and returns { data, total }', async () => {
    const result = await queryRiskScoresPage({}, {}, {
      label: 'risk-users',
      fromClause: 'INNER JOIN "Principals" p ON p.id = rs."entityId"::uuid',
      selectCols: 'p."displayName"',
      whereClause: `WHERE rs."entityType" = 'Principal' AND p."department" = $1`,
      params: ['HR'],
      limit: 25,
      offset: 50,
    });

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.total).toBe(7);

    const data = captured.find(c => c.label === 'risk-users-list');
    const count = captured.find(c => c.label === 'risk-users-count');
    // Data query carries the caller SQL + pagination as the next placeholders.
    expect(data.text).toContain('FROM "RiskScores" rs');
    expect(data.text).toContain('INNER JOIN "Principals" p');
    expect(data.text).toContain('p."displayName"');
    // One filter param ($1) → LIMIT/OFFSET take $2/$3.
    expect(data.text).toContain('LIMIT $2 OFFSET $3');
    expect(data.values).toEqual(['HR', 25, 50]);
    // Count query shares the WHERE + filter param but binds no limit/offset.
    expect(count.text).toContain('SELECT COUNT(*) AS total');
    expect(count.values).toEqual(['HR']);
  });

  it('appends the page window after every caller param', async () => {
    await queryRiskScoresPage({}, {}, {
      label: 'risk-resources',
      fromClause: '', selectCols: 'rs."riskTier"',
      whereClause: 'WHERE rs."riskScore" >= $1 AND rs."entityType" = $2',
      params: [80, 'Resource'],
      limit: 10, offset: 0,
    });
    const data = captured.find(c => c.label === 'risk-resources-list');
    const count = captured.find(c => c.label === 'risk-resources-count');
    // Two filters → LIMIT/OFFSET are $3/$4; count drops the window.
    expect(data.text).toContain('LIMIT $3 OFFSET $4');
    expect(data.values).toEqual([80, 'Resource', 10, 0]);
    expect(count.values).toEqual([80, 'Resource']);
  });
});
