import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('./activityResolve.js', async (importOriginal) => ({ ...(await importOriginal()), loadRoleIndexes: vi.fn() }));

import { query, queryOne } from '../../db/connection.js';
import { buildRuleIndex } from '../linking/candidates.js';
import { normalizeRecipe } from '../contracts.js';
import { activityKeyRules } from '../referenceRules.js';
import { loadRoleIndexes } from './activityResolve.js';
import { activityDryRun, SAMPLE_LIMIT } from './activityDryRun.js';

const recipe = normalizeRecipe({
  version: 1, template: 'activity',
  activity: {
    type: 'Hours', actor: { column: 'c3', targetTypes: ['Principal'] },
    subject: { column: 'c4', targetType: 'OrgEntity' }, when: { yearColumn: 'c1', monthColumn: 'c2' },
    measure: { column: 'c5', unit: 'h' },
  },
});
const r = (c1, c2, c3, c4, c5) => ({ c1, c2, c3, c4, c5 });
const table = (rows) => ({ columns: ['c1', 'c2', 'c3', 'c4', 'c5'], rows });

beforeEach(() => {
  query.mockReset(); queryOne.mockReset(); loadRoleIndexes.mockReset();
  loadRoleIndexes.mockImplementation(async (rec, role) => activityKeyRules(rec, role).map(rule => buildRuleIndex(
    rule.targetType === 'Principal' ? [{ id: 'p-ann', displayName: 'Ann Example', principalType: 'User' }] : [{ id: 'o-c', displayName: 'Contoso', entityType: 'Customer' }],
    rule,
  )));
});

describe('activityDryRun', () => {
  const rows = [
    r('2026', 'maart', 'Ann Example', 'Contoso', '7,5'),
    r('2026', 'april', 'Zed Nobody', 'Contoso', '8'),
    r('2026', 'april', 'Ann Example', 'Fabrikam', 'x'),
  ];

  it('reports facts, skipped rows, the first parsed rows as raw values, and key counts as the run would decide them', async () => {
    const report = await activityDryRun({ table: table(rows), recipe, mode: 'delta' });
    expect(report).toMatchObject({ template: 'activity', rows: 3, activities: 2, skipped: 1, wouldReplace: 0, issueCount: 1 });
    expect(report.sample).toEqual([
      { actor: 'Ann Example', subject: 'Contoso', occurredOn: '2026-03-01', periodEnd: '2026-03-31', measure: 7.5, unit: 'h' },
      { actor: 'Zed Nobody', subject: 'Contoso', occurredOn: '2026-04-01', periodEnd: '2026-04-30', measure: 8, unit: 'h' },
    ]);
    expect(report.keys).toEqual({
      actor: { total: 2, accepted: 1, proposed: 0, unmatched: 1 },
      subject: { total: 1, accepted: 1, proposed: 0, unmatched: 0 },
    });
    expect(report.issues).toEqual([{ row: 3, reason: 'row 3: "x" is not a number' }]);
    expect(report.columns.map(c => c.name)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    // no profile name: nothing settled to read, nothing to replace
    expect(query).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('the sample is the first SAMPLE_LIMIT rows', async () => {
    const many = Array.from({ length: SAMPLE_LIMIT + 3 }, (_, i) => r('2026', '1', 'Ann Example', `C${i}`, '1'));
    const report = await activityDryRun({ table: table(many), recipe, mode: 'delta' });
    expect(SAMPLE_LIMIT).toBe(10);
    expect(report.sample.map(s => s.subject)).toEqual(many.slice(0, SAMPLE_LIMIT).map(x => x.c4));
  });

  it('with a known profile name: settled values count as they stand, and a full run counts what it would replace', async () => {
    query.mockResolvedValueOnce({ rows: [
      { role: 'actor', rawValue: 'Zed Nobody', status: 'accepted' },
      { role: 'subject', rawValue: 'Contoso', status: 'rejected' },
    ] });
    queryOne.mockResolvedValueOnce({ n: 41 });
    const report = await activityDryRun({ table: table(rows.slice(0, 2)), recipe, mode: 'full', profileName: 'Hours' });
    expect(report.keys).toEqual({
      actor: { total: 2, accepted: 2, proposed: 0, unmatched: 0 },
      subject: { total: 1, accepted: 0, proposed: 0, unmatched: 1 },
    });
    expect(report.wouldReplace).toBe(41);
    expect(query.mock.calls[0][0]).toMatch(/"analystOverride" OR "status" IN \('accepted', 'rejected'\)/);
    expect(query.mock.calls[0][1]).toEqual(['Hours']);
    // every subject value was settled: its targets were never loaded
    expect(loadRoleIndexes.mock.calls.map(c => c[1])).toEqual(['actor']);
  });

  it('a delta run with a profile name replaces nothing', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const report = await activityDryRun({ table: table(rows.slice(0, 1)), recipe, mode: 'delta', profileName: 'Hours' });
    expect(report.wouldReplace).toBe(0);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('no facts: zero key counts without loading any target', async () => {
    const report = await activityDryRun({ table: table([r('', '', '', '', '')]), recipe, mode: 'delta' });
    expect(report.keys.actor).toEqual({ total: 0, accepted: 0, proposed: 0, unmatched: 0 });
    expect(loadRoleIndexes).not.toHaveBeenCalled();
  });
});
