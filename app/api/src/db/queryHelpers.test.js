// Unit tests for db/queryHelpers.js — queryRiskScoresPage builds a paginated
// data + count query around a caller-supplied JOIN/WHERE and binds the @name
// params to both via bindNamedParams. DB mocked at the timedQuery boundary.

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
      whereClause: `WHERE rs."entityType" = 'Principal' AND p."department" = @dept`,
      params: [{ name: 'dept', value: 'HR' }],
      limit: 25,
      offset: 50,
    });

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.total).toBe(7);

    const data = captured.find(c => c.label === 'risk-users-list');
    const count = captured.find(c => c.label === 'risk-users-count');
    // Data query carries the caller SQL + pagination, with @names rewritten to $N.
    expect(data.text).toContain('FROM "RiskScores" rs');
    expect(data.text).toContain('INNER JOIN "Principals" p');
    expect(data.text).toContain('p."displayName"');
    expect(data.text).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    // @dept, @limit, @offset appear in that order → $1, $2, $3.
    expect(data.values).toEqual(['HR', 25, 50]);
    // Count query shares the WHERE + param but binds no limit/offset.
    expect(count.text).toContain('SELECT COUNT(*) AS total');
    expect(count.values).toEqual(['HR']);
  });

  it('binds every caller param to both requests', async () => {
    await queryRiskScoresPage({}, {}, {
      label: 'risk-resources',
      fromClause: '', selectCols: 'rs."riskTier"',
      whereClause: 'WHERE rs."riskScore" >= @min AND rs."entityType" = @type',
      params: [{ name: 'min', value: 80 }, { name: 'type', value: 'Resource' }],
      limit: 10, offset: 0,
    });
    const data = captured.find(c => c.label === 'risk-resources-list');
    const count = captured.find(c => c.label === 'risk-resources-count');
    // Data: @min,@type,@limit,@offset → [80,'Resource',10,0]; count drops the window.
    expect(data.values).toEqual([80, 'Resource', 10, 0]);
    expect(count.values).toEqual([80, 'Resource']);
  });
});
