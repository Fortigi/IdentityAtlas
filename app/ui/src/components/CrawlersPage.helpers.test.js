import { describe, it, expect } from 'vitest';
import {
  JOB_PROGRESS_TERMINAL,
  parseProgress,
  computeStaleness,
  deriveJobProgressDisplay,
} from './CrawlersPage.helpers.js';

describe('JOB_PROGRESS_TERMINAL', () => {
  it('lists the statuses that stop the progress clock', () => {
    expect(JOB_PROGRESS_TERMINAL).toEqual(['completed', 'failed', 'cancelled']);
  });
});

describe('parseProgress', () => {
  it('returns an empty object for null/undefined/empty', () => {
    expect(parseProgress(null)).toEqual({});
    expect(parseProgress(undefined)).toEqual({});
    expect(parseProgress('')).toEqual({});
  });
  it('parses a JSON string', () => {
    expect(parseProgress('{"pct":42,"step":"Sync"}')).toEqual({ pct: 42, step: 'Sync' });
  });
  it('passes an already-parsed object through unchanged', () => {
    const obj = { pct: 10 };
    expect(parseProgress(obj)).toBe(obj);
  });
});

describe('computeStaleness', () => {
  it('is unknown when we have never seen an update', () => {
    expect(computeStaleness(null)).toBeNull();
  });
  it('buckets fresh, normal and stale by seconds elapsed', () => {
    expect(computeStaleness(0)).toBe('fresh');
    expect(computeStaleness(9)).toBe('fresh');
    expect(computeStaleness(10)).toBe('normal');
    expect(computeStaleness(59)).toBe('normal');
    expect(computeStaleness(60)).toBe('stale');
    expect(computeStaleness(600)).toBe('stale');
  });
});

describe('deriveJobProgressDisplay', () => {
  it('returns null when there is no job', () => {
    expect(deriveJobProgressDisplay(null, 'Label', 0)).toBeNull();
  });

  it('falls back to the job type when no config label is given', () => {
    const view = deriveJobProgressDisplay({ status: 'running', jobType: 'EntraID' }, null, 0);
    expect(view.header).toBe('EntraID');
  });

  it('prefers the config label for the header', () => {
    const view = deriveJobProgressDisplay({ status: 'running', jobType: 'EntraID' }, 'My Tenant', 0);
    expect(view.header).toBe('My Tenant');
  });

  it('supplies defaults for an empty progress payload', () => {
    const view = deriveJobProgressDisplay({ status: 'queued', jobType: 'x' }, null, 0);
    expect(view.pct).toBe(0);
    expect(view.step).toBe('Waiting...');
    expect(view.detail).toBe('');
    expect(view.errorMessage).toBe('Unknown error');
    expect(view.updatedAt).toBeNull();
    expect(view.secondsSince).toBeNull();
    expect(view.staleness).toBeNull();
    expect(view.stalenessColor).toBe('text-blue-700');
  });

  it('derives progress fields and freshness from a JSON progress string', () => {
    const updatedAt = new Date('2026-01-01T00:00:00Z');
    const now = updatedAt.getTime() + 5000;
    const job = {
      status: 'running',
      jobType: 'x',
      progress: JSON.stringify({ pct: 55, step: 'Fetching', detail: 'page 3', updatedAt: updatedAt.toISOString() }),
    };
    const view = deriveJobProgressDisplay(job, null, now);
    expect(view.pct).toBe(55);
    expect(view.step).toBe('Fetching');
    expect(view.detail).toBe('page 3');
    expect(view.secondsSince).toBe(5);
    expect(view.staleness).toBe('fresh');
    expect(view.stalenessColor).toBe('text-blue-700');
    expect(view.updatedAt.getTime()).toBe(updatedAt.getTime());
  });

  it('flags a stale run in amber once updates stop for over a minute', () => {
    const updatedAt = new Date('2026-01-01T00:00:00Z');
    const now = updatedAt.getTime() + 90_000;
    const job = { status: 'running', jobType: 'x', progress: { updatedAt: updatedAt.toISOString() } };
    const view = deriveJobProgressDisplay(job, null, now);
    expect(view.staleness).toBe('stale');
    expect(view.stalenessColor).toBe('text-amber-700');
  });

  it('never reports negative elapsed seconds when the clock is behind', () => {
    const updatedAt = new Date('2026-01-01T00:00:10Z');
    const now = new Date('2026-01-01T00:00:00Z').getTime();
    const job = { status: 'running', jobType: 'x', progress: { updatedAt: updatedAt.toISOString() } };
    const view = deriveJobProgressDisplay(job, null, now);
    expect(view.secondsSince).toBe(0);
  });

  it('surfaces the job error message on the derived view', () => {
    const view = deriveJobProgressDisplay({ status: 'failed', jobType: 'x', errorMessage: 'boom' }, null, 0);
    expect(view.errorMessage).toBe('boom');
  });
});
