// Unit tests for db/queryHelpers.js — queryRiskScoresPage builds a paginated
// data + count query around a caller-supplied JOIN/WHERE and binds the params to
// both. DB mocked via the timedRequest boundary. (#666: 0 floor.)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = [];
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: (_pool, label) => {
    const req = {
      label,
      inputs: {},
      input(name, value) { this.inputs[name] = value; return this; },
      query(sql) {
        captured.push({ label, sql, inputs: { ...this.inputs } });
        return Promise.resolve(
          label.endsWith('-count')
            ? { recordset: [{ total: 7 }] }
            : { recordset: [{ id: 1 }, { id: 2 }] },
        );
      },
    };
    return req;
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
    // Data query carries the caller SQL + pagination.
    expect(data.sql).toContain('FROM "RiskScores" rs');
    expect(data.sql).toContain('INNER JOIN "Principals" p');
    expect(data.sql).toContain('p."displayName"');
    expect(data.sql).toContain('LIMIT @limit OFFSET @offset');
    expect(data.inputs).toMatchObject({ dept: 'HR', limit: 25, offset: 50 });
    // Count query shares the WHERE + param but takes no limit/offset.
    expect(count.sql).toContain('SELECT COUNT(*) AS total');
    expect(count.inputs).toMatchObject({ dept: 'HR' });
    expect(count.inputs.limit).toBeUndefined();
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
    expect(data.inputs).toMatchObject({ min: 80, type: 'Resource' });
    expect(count.inputs).toMatchObject({ min: 80, type: 'Resource' });
  });
});
