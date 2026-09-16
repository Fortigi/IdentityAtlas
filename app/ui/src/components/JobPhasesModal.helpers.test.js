import { describe, it, expect } from 'vitest';
import {
  fmtMs,
  fmtBytes,
  statusTextClass,
  SYNC_MODE_BADGES,
  PHASE_DOTS,
  DEFAULT_DOT,
} from './JobPhasesModal.helpers.js';

describe('fmtMs', () => {
  it('renders an em-dash for null/undefined', () => {
    expect(fmtMs(null)).toBe('—');
    expect(fmtMs(undefined)).toBe('—');
  });
  it('renders sub-second durations in milliseconds', () => {
    expect(fmtMs(0)).toBe('0 ms');
    expect(fmtMs(300)).toBe('300 ms');
    expect(fmtMs(999)).toBe('999 ms');
  });
  it('renders seconds up to a minute', () => {
    expect(fmtMs(1000)).toBe('1s');
    expect(fmtMs(1200)).toBe('1.2s');
    expect(fmtMs(59000)).toBe('59s');
  });
  it('renders minutes and seconds past a minute', () => {
    expect(fmtMs(60000)).toBe('1m 0s');
    expect(fmtMs(65000)).toBe('1m 5s');
    expect(fmtMs(125000)).toBe('2m 5s');
  });
});

describe('fmtBytes', () => {
  it('renders bytes under a kilobyte', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1023)).toBe('1023 B');
  });
  it('renders kilobytes under a megabyte', () => {
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(2048)).toBe('2.0 KB');
  });
  it('renders megabytes at and above a megabyte', () => {
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('statusTextClass', () => {
  it('gives failed a red tone', () => {
    expect(statusTextClass('failed')).toContain('text-red-600');
    expect(statusTextClass('failed')).toContain('dark:text-red-400');
  });
  it('gives completed a green tone', () => {
    expect(statusTextClass('completed')).toContain('text-green-600');
    expect(statusTextClass('completed')).toContain('dark:text-green-400');
  });
  it('falls back to a neutral tone for any other status', () => {
    expect(statusTextClass('running')).toContain('text-gray-600');
    expect(statusTextClass(undefined)).toContain('text-gray-600');
  });
});

describe('display config tables', () => {
  it('exposes full and delta sync-mode badges with dark-mode classes', () => {
    expect(SYNC_MODE_BADGES.full.label).toBe('full');
    expect(SYNC_MODE_BADGES.full.className).toContain('dark:bg-amber-900/30');
    expect(SYNC_MODE_BADGES.delta.className).toContain('dark:bg-slate-700');
    expect(SYNC_MODE_BADGES.unknown).toBeUndefined();
  });
  it('maps phase statuses to dot colours and falls back to a neutral dot', () => {
    expect(PHASE_DOTS.ok.cls).toContain('bg-green-500');
    expect(PHASE_DOTS.failed.cls).toContain('bg-red-500');
    expect(PHASE_DOTS.skipped.cls).toContain('bg-gray-400');
    expect(PHASE_DOTS.pending).toBeUndefined();
    expect(DEFAULT_DOT.cls).toContain('bg-gray-300');
    expect(DEFAULT_DOT.title).toBeUndefined();
  });
});
