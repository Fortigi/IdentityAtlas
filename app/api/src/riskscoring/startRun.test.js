// startRiskScoringRun — the start shared by the post-crawl pipeline. Risk
// scoring is experimental: while its flag is off nothing starts, not even after
// a crawl, and the database is not touched.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const flags = vi.hoisted(() => ({ riskScoring: true }));
vi.mock('../featureFlags.js', async (orig) =>
  (await import('../../test-utils/featureFlagMock.js')).steeredFeatureFlags(await orig(), flags));
vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';

const { startRiskScoringRun } = await import('./engine.js');

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  flags.riskScoring = true;
});

describe('startRiskScoringRun', () => {
  it('starts nothing while the flag is off — even with an active classifier', async () => {
    flags.riskScoring = false;
    queryOne.mockResolvedValue({ id: 7 });
    await expect(startRiskScoringRun('crawl-complete', { onlyIfConfigured: true })).resolves.toBeNull();
    // Off is not "not configured": a caller that demands a run is not told to configure one.
    await expect(startRiskScoringRun('admin')).resolves.toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('queues a run for the active classifier while the flag is on', async () => {
    // The run itself fails fast against the empty mock; that is the engine's
    // business (it records the failure on the run row), not this start's.
    query.mockRejectedValue(new Error('engine not under test'));
    queryOne
      .mockResolvedValueOnce({ id: 7 })                     // active classifier
      .mockResolvedValueOnce({ id: 31, status: 'pending' }) // INSERT … RETURNING *
      .mockResolvedValue(null);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await startRiskScoringRun('crawl-complete', { onlyIfConfigured: true, awaitCompletion: true });
    err.mockRestore();
    expect(run).toEqual({ id: 31, status: 'pending' });
    const [insertSql, insertParams] = queryOne.mock.calls[1];
    expect(insertSql).toContain('INSERT INTO "ScoringRuns"');
    expect(insertParams).toEqual([7, 'crawl-complete']);
  });

  it('skips quietly when nothing is configured and the caller allows it', async () => {
    queryOne.mockResolvedValueOnce(null);
    await expect(startRiskScoringRun('crawl-complete', { onlyIfConfigured: true })).resolves.toBeNull();
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('refuses when nothing is configured and the caller needs a run', async () => {
    queryOne.mockResolvedValueOnce(null);
    await expect(startRiskScoringRun('admin')).rejects.toThrow('No active classifier set');
  });
});
