// Unit tests for lib/crawlerJobQueue.js — the "one job per crawler configuration"
// rule. The claim statement's semantics (NOT EXISTS against a running job, SKIP
// LOCKED) are proven against real PostgreSQL in
// contract-tests/crawlerJobQueue.contract.test.js; mocks here are SQL-blind.
import { describe, it, expect, vi } from 'vitest';
import { findActiveConfigJob, CLAIM_NEXT_JOB_SQL } from './crawlerJobQueue.js';

const answering = (rows) => vi.fn(async () => ({ rows }));

describe('findActiveConfigJob', () => {
  it('returns the job that is in the way, with its status', async () => {
    const query = answering([{ id: 41, status: 'running' }]);
    expect(await findActiveConfigJob(query, 3)).toEqual({ id: 41, status: 'running' });
  });

  it('returns null when the configuration has nothing queued or running', async () => {
    expect(await findActiveConfigJob(answering([]), 3)).toBeNull();
  });

  it('asks about exactly this configuration, and only queued or running jobs', async () => {
    const query = answering([]);
    await findActiveConfigJob(query, 17);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([17]);
    expect(sql).toContain('"configId" = $1');
    expect(sql).toContain("status IN ('queued', 'running')");
  });

  it('never queries for a job with no configuration — an inline config is never held back', async () => {
    const query = answering([{ id: 1, status: 'running' }]);
    expect(await findActiveConfigJob(query, null)).toBeNull();
    expect(await findActiveConfigJob(query, undefined)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('treats configuration id 0 as a configuration, not as "none"', async () => {
    const query = answering([{ id: 2, status: 'queued' }]);
    expect(await findActiveConfigJob(query, 0)).toEqual({ id: 2, status: 'queued' });
    expect(query).toHaveBeenCalledWith(expect.any(String), [0]);
  });
});

describe('CLAIM_NEXT_JOB_SQL', () => {
  it('holds back a queued job whose configuration has one running, but not an inline job', () => {
    expect(CLAIM_NEXT_JOB_SQL).toMatch(/q\."configId" IS NULL OR NOT EXISTS/);
    expect(CLAIM_NEXT_JOB_SQL).toMatch(/r\."configId" = q\."configId" AND r\."status" = 'running'/);
  });

  it('still claims atomically and returns the configId the credential lookup needs', () => {
    expect(CLAIM_NEXT_JOB_SQL).toContain('FOR UPDATE SKIP LOCKED');
    expect(CLAIM_NEXT_JOB_SQL).toContain('cj."configId"');
  });
});
