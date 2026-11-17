// The risk score a user / resource detail page carries (mergeUserRiskScore,
// mergeResourceRiskScore). Risk scoring is experimental: while its flag is off
// the detail answer carries no risk fields at all — the stored score is not
// even read — so the page has nothing risk-related to show.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const flags = vi.hoisted(() => ({ riskScoring: true }));
vi.mock('../../featureFlags.js', async (orig) =>
  (await import('../../../test-utils/featureFlagMock.js')).steeredFeatureFlags(await orig(), flags));
vi.mock('../../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query } from '../../db/connection.js';

const { mergeUserRiskScore } = await import('./userDetail.js');
const { mergeResourceRiskScore } = await import('../resources/detail.js');

const SCORE = { riskScore: 72, riskTier: 'High', riskOverride: null };
const ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { query.mockReset(); flags.riskScoring = true; });

describe.each([
  ['mergeUserRiskScore', mergeUserRiskScore, 'Principal'],
  ['mergeResourceRiskScore', mergeResourceRiskScore, 'Resource'],
])('%s', (_name, merge, entityType) => {
  it('merges the stored score onto the attributes while the flag is on', async () => {
    query.mockResolvedValueOnce({ rows: [SCORE] });
    const attributes = { displayName: 'Ann' };
    await merge(attributes, ID);
    expect(attributes).toEqual({ displayName: 'Ann', ...SCORE });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`"entityType" = '${entityType}'`);
    expect(params).toEqual([ID]);
  });

  it('adds nothing, and reads nothing, while the flag is off', async () => {
    flags.riskScoring = false;
    query.mockResolvedValueOnce({ rows: [SCORE] });
    const attributes = { displayName: 'Ann' };
    await merge(attributes, ID);
    expect(attributes).toEqual({ displayName: 'Ann' });
    expect(query).not.toHaveBeenCalled();
  });

  it('leaves the attributes alone when the entity has no score', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const attributes = { displayName: 'Ann' };
    await merge(attributes, ID);
    expect(attributes).toEqual({ displayName: 'Ann' });
  });

  it('tolerates a missing RiskScores table, but not any other error', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('no table'), { code: '42P01' }));
    await expect(merge({}, ID)).resolves.toBeUndefined();
    query.mockRejectedValueOnce(Object.assign(new Error('syntax'), { code: '42601' }));
    await expect(merge({}, ID)).rejects.toThrow('syntax');
  });
});
