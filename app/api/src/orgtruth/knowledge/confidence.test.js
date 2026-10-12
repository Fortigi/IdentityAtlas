import { describe, it, expect } from 'vitest';
import { scoreStatement, bandOf, HIGH, MEDIUM, CONTRADICTED_CAP } from './confidence.js';

describe('scoreStatement', () => {
  it('a stated, supported statement whose sides are only clear candidates is medium — not high', () => {
    const s = scoreStatement({ support: 'supported', modality: 'stated', sides: ['clear', 'clear'] });
    expect(s).toEqual({ confidence: 70, parts: { transcript: 60, matching: 10, data: 0 } });
    expect(bandOf(s.confidence)).toBe('medium');
  });

  it('corroboration by the existing data makes it high, even when the verifier doubted it', () => {
    const s = scoreStatement({ support: 'unsupported', modality: 'stated', sides: ['clear', 'clear'], corroboration: { verdict: 'corroborated' } });
    expect(s.confidence).toBe(70);
    const strong = scoreStatement({ support: 'unclear', modality: 'stated', sides: ['confirmed', 'clear'], corroboration: { verdict: 'corroborated' } });
    expect(strong.confidence).toBe(90);
    expect(bandOf(strong.confidence)).toBe('high');
  });

  it('two sides confirmed by a reviewer and a supported quote reach high without data', () => {
    expect(scoreStatement({ support: 'supported', modality: 'stated', sides: ['confirmed', 'confirmed'] }).confidence).toBe(HIGH);
  });

  it('the data saying the opposite caps it, whatever else', () => {
    const s = scoreStatement({ support: 'supported', modality: 'stated', sides: ['confirmed', 'confirmed'], corroboration: { verdict: 'contradicted' } });
    expect(s.confidence).toBe(CONTRADICTED_CAP);
    expect(bandOf(s.confidence)).toBe('low');
  });

  it('hedging and ambiguity lower it; it never leaves 0–100', () => {
    expect(scoreStatement({ support: 'supported', modality: 'uncertain', sides: ['ambiguous', 'unmatched'] }).confidence).toBe(40);
    expect(scoreStatement({ support: 'unsupported', modality: 'question', sides: ['ambiguous', 'ambiguous'] }).confidence).toBe(0);
    expect(scoreStatement({ support: 'supported', modality: 'stated', sides: ['confirmed', 'confirmed'], corroboration: { verdict: 'corroborated' } }).confidence).toBe(100);
    expect(scoreStatement({ sides: [] }).confidence).toBe(40);
  });
});

it('bands', () => {
  expect([HIGH, HIGH - 1, MEDIUM, MEDIUM - 1].map(bandOf)).toEqual(['high', 'medium', 'medium', 'low']);
});
