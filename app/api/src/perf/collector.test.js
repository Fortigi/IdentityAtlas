// Unit tests for the perf collector ring buffer and its aggregation
// helpers (groupEntriesByRoute / aggregateSqlLabels / summarizeGroup),
// exercised through the public API. State is module-level, so each test
// clears and re-enables the collector first.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isEnabled, enable, disable, record, summarize, recent, slowest, clear,
} from './collector.js';

function entry(over = {}) {
  return {
    route: '/a', method: 'GET', statusCode: 200, totalMs: 10,
    sqlQueries: [], responseBytes: 100, timestamp: 1, ...over,
  };
}

beforeEach(() => {
  clear();
  disable();
});

describe('enable/disable/isEnabled', () => {
  it('reflects the toggled state', () => {
    expect(isEnabled()).toBe(false);
    enable();
    expect(isEnabled()).toBe(true);
    disable();
    expect(isEnabled()).toBe(false);
  });
});

describe('record', () => {
  it('is a no-op while disabled', () => {
    record(entry());
    expect(summarize().totalRecorded).toBe(0);
    expect(summarize().bufferSize).toBe(0);
  });

  it('stores entries while enabled', () => {
    enable();
    record(entry());
    record(entry());
    const s = summarize();
    expect(s.totalRecorded).toBe(2);
    expect(s.bufferSize).toBe(2);
  });

  it('overwrites the oldest slot once the buffer is full', () => {
    enable();
    for (let i = 0; i < 1002; i++) record(entry({ totalMs: i }));
    const s = summarize();
    expect(s.bufferSize).toBe(1000); // capped
    expect(s.totalRecorded).toBe(1002); // keeps counting
  });
});

describe('summarize', () => {
  beforeEach(() => {
    enable();
    // Route /a: three requests, two with SQL breakdowns.
    record(entry({ route: '/a', totalMs: 10, sqlQueries: [{ label: 'q1', ms: 5 }, { label: 'q2', ms: 3 }] }));
    record(entry({ route: '/a', totalMs: 20, sqlQueries: [{ label: 'q1', ms: 15 }] }));
    record(entry({ route: '/a', totalMs: 30, sqlQueries: undefined }));
    // Route /b: a single, slower request.
    record(entry({ route: '/b', totalMs: 100 }));
  });

  it('sorts endpoints by p95 descending', () => {
    const { endpoints } = summarize();
    expect(endpoints.map((e) => e.route)).toEqual(['/b', '/a']);
  });

  it('aggregates duration percentiles per endpoint', () => {
    const a = summarize().endpoints.find((e) => e.route === '/a');
    expect(a).toMatchObject({
      method: 'GET', route: '/a', count: 3,
      avg: 20, min: 10, max: 30, p50: 20, p95: 30, p99: 30,
    });
  });

  it('aggregates SQL label stats across requests', () => {
    const a = summarize().endpoints.find((e) => e.route === '/a');
    expect(a.sqlBreakdown).toEqual([
      { label: 'q1', count: 2, avg: 10, p50: 5, p95: 15, max: 15 },
      { label: 'q2', count: 1, avg: 3, p50: 3, p95: 3, max: 3 },
    ]);
  });

  it('yields no sqlBreakdown for an endpoint without SQL queries', () => {
    const b = summarize().endpoints.find((e) => e.route === '/b');
    expect(b.sqlBreakdown).toEqual([]);
  });
});

describe('recent', () => {
  it('returns entries newest-first, clamped to n', () => {
    enable();
    record(entry({ route: '/old', timestamp: 1 }));
    record(entry({ route: '/mid', timestamp: 2 }));
    record(entry({ route: '/new', timestamp: 3 }));
    expect(recent().map((e) => e.route)).toEqual(['/new', '/mid', '/old']);
    expect(recent(1).map((e) => e.route)).toEqual(['/new']);
  });
});

describe('slowest', () => {
  it('returns entries by descending totalMs, clamped to n', () => {
    enable();
    record(entry({ route: '/fast', totalMs: 5 }));
    record(entry({ route: '/slow', totalMs: 500 }));
    record(entry({ route: '/mid', totalMs: 50 }));
    expect(slowest().map((e) => e.route)).toEqual(['/slow', '/mid', '/fast']);
    expect(slowest(2).map((e) => e.route)).toEqual(['/slow', '/mid']);
  });
});

describe('clear', () => {
  it('resets the buffer and counters', () => {
    enable();
    record(entry());
    clear();
    const s = summarize();
    expect(s.totalRecorded).toBe(0);
    expect(s.bufferSize).toBe(0);
    expect(s.endpoints).toEqual([]);
  });
});
