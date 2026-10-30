import { describe, it, expect } from 'vitest';
import { applyKnownGaps } from './knownGaps.js';

const f = (code, subject) => ({ code, subject, message: 'm' });
const REASON = 'a written reason that is long enough';

describe('applyKnownGaps', () => {
  it('accepts a finding that matches code AND subject, and keeps the rest', () => {
    const findings = [f('a', 'x'), f('a', 'y'), f('b', 'x')];
    const { errors, accepted } = applyKnownGaps(findings, [{ code: 'a', subject: 'x', reason: REASON }]);
    expect(accepted).toEqual([f('a', 'x')]);
    expect(errors).toEqual([f('a', 'y'), f('b', 'x')]);
  });

  it('fails a gap that no longer matches anything (the list only shrinks)', () => {
    const { errors, accepted } = applyKnownGaps([], [{ code: 'a', subject: 'x', reason: REASON }]);
    expect(accepted).toEqual([]);
    expect(errors.map(e => `${e.code} ${e.subject}`)).toEqual(['stale-known-gap a x']);
  });

  it('judges a gap only in its own scope', () => {
    const gaps = [{ code: 'db', subject: 'T.c', reason: REASON, scope: 'database' }];
    expect(applyKnownGaps([], gaps, 'static').errors).toEqual([]);
    expect(applyKnownGaps([], gaps, 'database').errors.map(e => e.code)).toEqual(['stale-known-gap']);
    const { accepted } = applyKnownGaps([f('db', 'T.c')], gaps, 'database');
    expect(accepted).toEqual([f('db', 'T.c')]);
  });

  it('requires a real reason', () => {
    const { errors } = applyKnownGaps([f('a', 'x')], [{ code: 'a', subject: 'x', reason: 'short' }]);
    expect(errors.map(e => `${e.code} ${e.subject}`)).toEqual(['known-gap-without-reason a x']);
  });

  it('treats a missing gap list as empty', () => {
    expect(applyKnownGaps([f('a', 'x')]).errors).toEqual([f('a', 'x')]);
  });
});
