import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDate,
  formatDateOnly,
  formatDurationSeconds,
  formatDurationMs,
  formatRelativeTime,
  formatCompactNumber,
} from './formatters';

// ─── formatDate ────────────────────────────────────────────────────────────────
// Original: utils/formatters.js (unchanged — no migration, just verifying)

describe('formatDate', () => {
  it('returns empty string for falsy input', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  it('returns the original string for unparseable input', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });

  it('formats an ISO datetime string (includes time)', () => {
    const result = formatDate('2024-06-15T10:30:00Z');
    // dateStyle:medium + timeStyle:short — exact output is locale/timezone-dependent
    expect(result).toMatch(/2024/);
    expect(result).toMatch(/Jun|6/);  // month, locale-dependent
    expect(result).toMatch(/:/);      // time separator present
  });
});

// ─── formatDateOnly ─────────────────────────────────────────────────────────────
// Originally defined identically in:
//   - utils/excelHelpers.js
//   - components/AccessPackagesPage.jsx
// Both: toLocaleDateString with { day: 'numeric', month: 'short', year: 'numeric' }

describe('formatDateOnly', () => {
  it('returns empty string for falsy input', () => {
    expect(formatDateOnly('')).toBe('');
    expect(formatDateOnly(null)).toBe('');
    expect(formatDateOnly(undefined)).toBe('');
  });

  it('formats a date string without time component', () => {
    const result = formatDateOnly('2024-06-15');
    expect(result).toMatch(/2024/);
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    // Must NOT include a time portion
    expect(result).not.toMatch(/:/);
  });

  it('handles ISO datetime input, strips time', () => {
    const result = formatDateOnly('2024-06-15T10:30:00Z');
    expect(result).not.toMatch(/:/);
  });
});

// ─── formatDurationSeconds ─────────────────────────────────────────────────────
// Consolidated from CrawlersPage.formatDurationHMS and SyncLogPage.formatDuration.
// Both showed "1h 37m" at hour level (no seconds). Null guard added (old functions crashed).

describe('formatDurationSeconds — from CrawlersPage.formatDurationHMS (canonical)', () => {
  it('returns "—" for null', () => {
    expect(formatDurationSeconds(null)).toBe('—');
  });

  it('returns "—" for NaN', () => {
    expect(formatDurationSeconds(NaN)).toBe('—');
  });

  it('formats sub-minute as seconds', () => {
    expect(formatDurationSeconds(0)).toBe('0s');
    expect(formatDurationSeconds(45)).toBe('45s');
    expect(formatDurationSeconds(59)).toBe('59s');
  });

  it('formats minutes without remainder seconds', () => {
    expect(formatDurationSeconds(120)).toBe('2m');
    expect(formatDurationSeconds(3540)).toBe('59m');
  });

  it('promotes to hours at exactly 3600s', () => {
    expect(formatDurationSeconds(3600)).toBe('1h 0m');
  });

  it('formats minutes with remainder seconds', () => {
    expect(formatDurationSeconds(90)).toBe('1m 30s');
    expect(formatDurationSeconds(128)).toBe('2m 8s');
  });

  it('formats hours, dropping sub-minute seconds', () => {
    expect(formatDurationSeconds(3600 + 37 * 60)).toBe('1h 37m');
    expect(formatDurationSeconds(3600 + 37 * 60 + 17)).toBe('1h 37m');
    expect(formatDurationSeconds(3661)).toBe('1h 1m');
  });

  it('handles null without crashing', () => {
    expect(() => formatDurationSeconds(null)).not.toThrow();
    expect(formatDurationSeconds(null)).toBe('—');
  });
});

// ─── formatDurationMs ─────────────────────────────────────────────────────────
// Original: RunDetailPage.formatDuration(ms)
//   if (ms < 1000) return `${ms}ms`;
//   const s = Math.round(ms / 1000);
//   if (s < 60) return `${s}s`;
//   const m = Math.floor(s / 60); return `${m}m ${rem}s`
// New: adds null/NaN guard (old would crash or produce garbage)

describe('formatDurationMs — from RunDetailPage.formatDuration', () => {
  it('returns "—" for null (new behavior — old would crash)', () => {
    expect(formatDurationMs(null)).toBe('—');
    expect(formatDurationMs(NaN)).toBe('—');
  });

  it('formats sub-second as milliseconds', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(500)).toBe('500ms');
    expect(formatDurationMs(999)).toBe('999ms');
  });

  it('formats seconds', () => {
    expect(formatDurationMs(1000)).toBe('1s');
    expect(formatDurationMs(45000)).toBe('45s');
    expect(formatDurationMs(59000)).toBe('59s');
  });

  it('promotes to minutes when rounding reaches 60s, suppresses zero seconds', () => {
    // 59999ms rounds to 60s → 1m (fixed: original RunDetailPage returned "1m 0s")
    expect(formatDurationMs(59999)).toBe('1m');
    expect(formatDurationMs(60000)).toBe('1m');
  });

  it('formats minutes with remainder seconds', () => {
    expect(formatDurationMs(90000)).toBe('1m 30s');
    expect(formatDurationMs(225000)).toBe('3m 45s');
  });
});

// ─── formatRelativeTime ───────────────────────────────────────────────────────
// Consolidated from DashboardPage.formatRelativeTime and SyncLogPage.formatTimeAgo.
// Uses "m" suffix (not "min"), shows sub-hour minutes at hour level ("2h 35m ago"),
// and adds months/years support that SyncLogPage lacked.

// Pin the clock so relative-time tests are deterministic
const NOW = new Date('2024-06-15T12:00:00Z').getTime();
beforeEach(() => { vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('formatRelativeTime — from DashboardPage.formatRelativeTime (canonical)', () => {
  it('returns "never" for falsy input', () => {
    expect(formatRelativeTime(null)).toBe('never');
    expect(formatRelativeTime('')).toBe('never');
    expect(formatRelativeTime(undefined)).toBe('never');
  });

  it('returns "in the future" for future dates', () => {
    expect(formatRelativeTime('2024-06-15T13:00:00Z')).toBe('in the future');
  });

  it('returns "just now" for < 1 minute ago', () => {
    expect(formatRelativeTime('2024-06-15T11:59:30Z')).toBe('just now');
  });

  it('formats minutes ago', () => {
    expect(formatRelativeTime('2024-06-15T11:55:00Z')).toBe('5m ago');
    expect(formatRelativeTime('2024-06-15T11:01:00Z')).toBe('59m ago');
  });

  it('formats hours ago, including sub-hour minutes', () => {
    expect(formatRelativeTime('2024-06-15T11:00:00Z')).toBe('1h ago');
    expect(formatRelativeTime('2024-06-15T09:25:00Z')).toBe('2h 35m ago');
    expect(formatRelativeTime('2024-06-15T10:00:00Z')).toBe('2h ago');  // exactly on the hour
  });

  it('formats days ago', () => {
    expect(formatRelativeTime('2024-06-12T12:00:00Z')).toBe('3d ago');
  });

  it('formats months ago', () => {
    expect(formatRelativeTime('2024-03-15T12:00:00Z')).toBe('3mo ago');
  });

  it('formats years ago', () => {
    expect(formatRelativeTime('2022-06-15T12:00:00Z')).toBe('2y ago');
  });
});


describe('formatRelativeTime — new capabilities vs SyncLogPage.formatTimeAgo', () => {
  it('supports months and years (SyncLogPage had no months/years)', () => {
    expect(formatRelativeTime('2024-03-15T12:00:00Z')).toBe('3mo ago');
    expect(formatRelativeTime('2022-06-15T12:00:00Z')).toBe('2y ago');
  });
});

// ─── formatCompactNumber ──────────────────────────────────────────────────────
// Original: DashboardPage.formatNumber — identical to new function

describe('formatCompactNumber — from DashboardPage.formatNumber (unchanged)', () => {
  it('returns "—" for null/undefined', () => {
    expect(formatCompactNumber(null)).toBe('—');
    expect(formatCompactNumber(undefined)).toBe('—');
  });

  it('returns plain string for numbers below 1k', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });

  it('formats thousands with one decimal', () => {
    expect(formatCompactNumber(1000)).toBe('1.0k');
    expect(formatCompactNumber(1500)).toBe('1.5k');
    expect(formatCompactNumber(9999)).toBe('10.0k');
  });

  it('formats 10k+ without decimal', () => {
    expect(formatCompactNumber(10000)).toBe('10k');
    expect(formatCompactNumber(15000)).toBe('15k');
    expect(formatCompactNumber(999999)).toBe('1000k');
  });

  it('formats millions with one decimal', () => {
    expect(formatCompactNumber(1_000_000)).toBe('1.0M');
    expect(formatCompactNumber(2_500_000)).toBe('2.5M');
  });
});
