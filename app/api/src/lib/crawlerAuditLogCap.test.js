// Unit tests for the CrawlerAuditLog cap. The SQL itself is exercised against a
// real database in contract-tests/crawlerAuditLogCap.contract.test.js.

import { describe, it, expect, vi } from 'vitest';
import { capCrawlerAuditLog, resolveAuditLogCap, DEFAULT_MAX_ROWS_PER_CRAWLER } from './crawlerAuditLogCap.js';

describe('resolveAuditLogCap', () => {
  it('defaults when unset or blank', () => {
    expect(resolveAuditLogCap({})).toBe(DEFAULT_MAX_ROWS_PER_CRAWLER);
    expect(resolveAuditLogCap({ CRAWLER_AUDIT_LOG_MAX_ROWS: ' ' })).toBe(DEFAULT_MAX_ROWS_PER_CRAWLER);
  });

  it('honours an explicit integer, including 0 to disable', () => {
    expect(resolveAuditLogCap({ CRAWLER_AUDIT_LOG_MAX_ROWS: '250' })).toBe(250);
    expect(resolveAuditLogCap({ CRAWLER_AUDIT_LOG_MAX_ROWS: '0' })).toBe(0);
  });

  it('falls back to the default for garbage, fractions and negatives', () => {
    expect(resolveAuditLogCap({ CRAWLER_AUDIT_LOG_MAX_ROWS: 'lots' })).toBe(DEFAULT_MAX_ROWS_PER_CRAWLER);
    expect(resolveAuditLogCap({ CRAWLER_AUDIT_LOG_MAX_ROWS: '2.5' })).toBe(DEFAULT_MAX_ROWS_PER_CRAWLER);
    expect(resolveAuditLogCap({ CRAWLER_AUDIT_LOG_MAX_ROWS: '-1' })).toBe(DEFAULT_MAX_ROWS_PER_CRAWLER);
  });
});

describe('capCrawlerAuditLog', () => {
  it('passes the cap as a bound parameter and returns the deleted row count', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 42 }) };
    expect(await capCrawlerAuditLog(db, 1000)).toBe(42);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM "CrawlerAuditLog"/);
    expect(sql).toMatch(/PARTITION BY "crawlerId"/);
    expect(params).toEqual([1000]);
  });

  it('reports 0 when the driver returns no rowCount', async () => {
    const db = { query: vi.fn().mockResolvedValue({}) };
    expect(await capCrawlerAuditLog(db, 1)).toBe(0);
  });

  it('never queries for a disabled or invalid cap', async () => {
    const db = { query: vi.fn() };
    for (const cap of [0, -5, 1.5, '100', undefined]) {
      expect(await capCrawlerAuditLog(db, cap)).toBe(0);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
});
