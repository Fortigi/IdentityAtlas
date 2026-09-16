import { describe, it, expect } from 'vitest';
import {
  parseJSON,
  formatScoredAt,
  clampScore,
  signPrefix,
  classifierScoreClass,
  reasonText,
  humanizeLayerKey,
  adjustmentColorClass,
  overrideBadgeClass,
} from './RiskScoreSection.helpers';

describe('parseJSON', () => {
  it('returns null for empty / placeholder values', () => {
    expect(parseJSON('')).toBeNull();
    expect(parseJSON(null)).toBeNull();
    expect(parseJSON(undefined)).toBeNull();
    expect(parseJSON('—')).toBeNull();
  });

  it('parses a JSON string', () => {
    expect(parseJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it('passes through an already-parsed object', () => {
    const obj = { b: 2 };
    expect(parseJSON(obj)).toBe(obj);
  });

  it('returns null on invalid JSON', () => {
    expect(parseJSON('{not json')).toBeNull();
  });
});

describe('formatScoredAt', () => {
  it('returns null when absent', () => {
    expect(formatScoredAt(null)).toBeNull();
    expect(formatScoredAt('')).toBeNull();
  });

  it('returns the raw string when unparseable', () => {
    expect(formatScoredAt('not-a-date')).toBe('not-a-date');
  });

  it('formats a valid timestamp to a locale string', () => {
    const out = formatScoredAt('2026-06-01T10:00:00Z');
    expect(typeof out).toBe('string');
    expect(out).toMatch(/2026/);
  });
});

describe('clampScore', () => {
  it('clamps below 0 and above 100 and passes through the middle', () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(42)).toBe(42);
  });
});

describe('signPrefix', () => {
  it('adds a plus only for positive numbers', () => {
    expect(signPrefix(3)).toBe('+');
    expect(signPrefix(0)).toBe('');
    expect(signPrefix(-3)).toBe('');
  });
});

describe('classifierScoreClass', () => {
  it('bands the score into high / medium / low classes', () => {
    expect(classifierScoreClass(75)).toContain('bg-red-100');
    expect(classifierScoreClass(50)).toContain('bg-yellow-100');
    expect(classifierScoreClass(10)).toContain('bg-gray-100');
  });
});

describe('reasonText', () => {
  it('returns a string reason as-is', () => {
    expect(reasonText('plain reason')).toBe('plain reason');
  });

  it('reads .reason off an object', () => {
    expect(reasonText({ reason: 'object reason' })).toBe('object reason');
  });

  it('stringifies an object with no reason field', () => {
    expect(reasonText({ x: 1 })).toBe('{"x":1}');
  });
});

describe('humanizeLayerKey', () => {
  it('splits camelCase into spaced words', () => {
    expect(humanizeLayerKey('riskPropagation')).toBe('risk Propagation');
    expect(humanizeLayerKey('direct')).toBe('direct');
  });
});

describe('adjustmentColorClass', () => {
  it('colours by sign of the adjustment', () => {
    expect(adjustmentColorClass(5)).toContain('text-red-600');
    expect(adjustmentColorClass(-5)).toContain('text-green-600');
    expect(adjustmentColorClass(0)).toContain('text-gray-500');
  });
});

describe('overrideBadgeClass', () => {
  it('is red for positive overrides and green otherwise', () => {
    expect(overrideBadgeClass(10)).toBe('bg-red-50 text-red-700');
    expect(overrideBadgeClass(-10)).toBe('bg-green-50 text-green-700');
  });
});
