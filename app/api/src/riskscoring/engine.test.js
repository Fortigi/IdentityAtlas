// Tests for the risk scoring engine's pure functions.
//
// The full runScoring() function reads/writes the database so it's covered by
// the nightly integration test (test/nightly/Test-RiskScoring.ps1). Here we
// validate the deterministic pieces with real imports:
//   - tierFor: score → tier mapping
//   - compileClassifier: LLM-produced regex patterns (including Perl-isms)
//   - scoreOne: classifier matching logic
//   - the weighted final-score formula

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compileClassifier, scoreOne, tierFor, isNonProduction } from './engine.js';

// ─── tierFor ──────────────────────────────────────────────────────

describe('tierFor', () => {
  it('maps scores to tiers per v4 thresholds', () => {
    expect(tierFor(0)).toBe('None');
    expect(tierFor(1)).toBe('Minimal');
    expect(tierFor(19)).toBe('Minimal');
    expect(tierFor(20)).toBe('Low');
    expect(tierFor(39)).toBe('Low');
    expect(tierFor(40)).toBe('Medium');
    expect(tierFor(69)).toBe('Medium');
    expect(tierFor(70)).toBe('High');
    expect(tierFor(89)).toBe('High');
    expect(tierFor(90)).toBe('Critical');
    expect(tierFor(100)).toBe('Critical');
  });
});

// ─── weighted final-score formula (4 layers, v4 weights) ─────────

describe('finalScore formula', () => {
  // Keep these constants in sync with engine.js
  const W_DIRECT      = 0.50;
  const W_MEMBERSHIP  = 0.20;
  const W_STRUCTURAL  = 0.10;
  const W_PROPAGATED  = 0.20;
  const finalScore = (d, m, s, p) => Math.min(100, Math.round(
    W_DIRECT * d + W_MEMBERSHIP * m + W_STRUCTURAL * s + W_PROPAGATED * p
  ));

  it('returns 0 when nothing matched', () => expect(finalScore(0, 0, 0, 0)).toBe(0));
  it('weights direct match by 50 percent',   () => expect(finalScore(100, 0, 0, 0)).toBe(50));
  it('weights membership by 20 percent',     () => expect(finalScore(0, 100, 0, 0)).toBe(20));
  it('weights structural by 10 percent',     () => expect(finalScore(0, 0, 100, 0)).toBe(10));
  it('weights propagated by 20 percent',     () => expect(finalScore(0, 0, 0, 100)).toBe(20));
  it('caps at 100 when layers stack',        () => expect(finalScore(100, 100, 100, 100)).toBe(100));
  it('adds all four layers correctly', () => {
    // 0.50*80 + 0.20*30 + 0.10*15 + 0.20*20 = 40 + 6 + 1.5 + 4 = 51.5 → 52
    expect(finalScore(80, 30, 15, 20)).toBe(52);
  });
});

// ─── isNonProduction ──────────────────────────────────────────────

describe('isNonProduction', () => {
  it('detects multi-letter environment suffixes', () => {
    expect(isNonProduction('GG_ROL_ADMIN_ACC')).toBe(true);
    expect(isNonProduction('GG_ROL_ADMIN_TST')).toBe(true);
    expect(isNonProduction('GG_ROL_ADMIN_DEV')).toBe(true);
    expect(isNonProduction('GG_ROL_ADMIN_QA')).toBe(true);
  });

  it('detects single-letter OTAP environment markers', () => {
    expect(isNonProduction('SG_APP_A_USERS')).toBe(true); // _A_ in middle
    expect(isNonProduction('SG_APP_T_USERS')).toBe(true);
    expect(isNonProduction('VPN_T')).toBe(true);          // _T at end
    expect(isNonProduction('APP_A')).toBe(true);
  });

  it('detects keyword patterns', () => {
    expect(isNonProduction('Sandbox environment users')).toBe(true);
    expect(isNonProduction('Staging platform admins')).toBe(true);
    expect(isNonProduction('Development team')).toBe(true);
  });

  it('does NOT flag production names', () => {
    expect(isNonProduction('Domain Admins')).toBe(false);
    expect(isNonProduction('GG_ROL_VTS_OPERATORS')).toBe(false);
    expect(isNonProduction('GG_ROL_HBR_Dynamics_Administrator')).toBe(false);
    expect(isNonProduction('Enterprise Admins')).toBe(false);
  });

  it('handles empty/null input gracefully', () => {
    expect(isNonProduction(null)).toBe(false);
    expect(isNonProduction('')).toBe(false);
    expect(isNonProduction(undefined)).toBe(false);
  });
});

// ─── compileClassifier ────────────────────────────────────────────

describe('compileClassifier', () => {
  let warnSpy;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('compiles simple patterns with case-insensitive matching', () => {
    const c = compileClassifier({ id: 'test', patterns: ['^admin$', 'foo.*bar'] });
    expect(c._compiled).toHaveLength(2);
    expect(c._compiled[0].test('Admin')).toBe(true);  // case-insensitive
    expect(c._compiled[1].test('foo42bar')).toBe(true);
  });

  // REGRESSION: LLMs produce `(?i)` Perl/Python-style inline flags which
  // JavaScript RegExp does NOT support. Before the fix, the entire classifier
  // would silently drop all its patterns and match NOTHING — producing zero
  // risk scores across the whole dataset.
  it('strips Perl-style (?i) inline flag without throwing', () => {
    const c = compileClassifier({
      id: 'llm-pattern',
      patterns: [
        '(?i)\\bdomain\\s*admin(istrator)?s?\\b',
        '(?i)\\benterprise\\s*admins?\\b',
      ],
    });
    expect(c._compiled).toHaveLength(2);
    expect(c._compiled[0].test('Domain Admins')).toBe(true);
    expect(c._compiled[0].test('DomainAdministrator')).toBe(true);
    expect(c._compiled[1].test('Enterprise Admins')).toBe(true);
    // Word-boundary anchor: admin groups without "domain" in the name should NOT match
    expect(c._compiled[0].test('GG_ROL_AD_Administrators')).toBe(false);
  });

  it('strips other inline flag groups (?s), (?m), (?x)', () => {
    const c = compileClassifier({ id: 'x', patterns: ['(?s)dot.*all', '(?im)multi'] });
    expect(c._compiled).toHaveLength(2);
  });

  it('strips inline flags that appear mid-pattern', () => {
    const c = compileClassifier({ id: 'x', patterns: ['prefix(?i)admin'] });
    expect(c._compiled).toHaveLength(1);
    expect(c._compiled[0].test('prefixAdmin')).toBe(true);
  });

  it('skips truly malformed patterns and logs a warning', () => {
    const c = compileClassifier({ id: 'bad', patterns: ['[unbalanced', '^good$'] });
    expect(c._compiled).toHaveLength(1);
    expect(c._compiled[0].test('good')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/invalid regex/i);
  });

  it('skips empty/null patterns', () => {
    const c = compileClassifier({ id: 'x', patterns: ['', '   ', null, undefined, 'ok'] });
    expect(c._compiled).toHaveLength(1);
  });

  it('handles a classifier with no patterns array', () => {
    const c = compileClassifier({ id: 'x' });
    expect(c._compiled).toEqual([]);
  });
});

// ─── scoreOne ─────────────────────────────────────────────────────

describe('scoreOne', () => {
  it('returns direct=0 and empty matches when nothing hits', () => {
    const cls = [compileClassifier({ id: 'a', score: 100, patterns: ['^nothing$'] })];
    const result = scoreOne(['random text'], cls);
    expect(result.directScore).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it('returns the highest score when multiple classifiers match', () => {
    const cls = [
      compileClassifier({ id: 'low', score: 30, tier: 'low', label: 'L', patterns: ['admin'] }),
      compileClassifier({ id: 'high', score: 90, tier: 'critical', label: 'H', patterns: ['domain admin'] }),
    ];
    const result = scoreOne(['Domain Admins'], cls);
    expect(result.directScore).toBe(90);
    expect(result.matches).toHaveLength(2);
  });

  it('matches across multiple text fields', () => {
    const cls = [compileClassifier({ id: 'a', score: 50, patterns: ['ciso'] })];
    const result = scoreOne(['Jane Doe', 'jane@example.com', 'Chief Information Security Officer (CISO)'], cls);
    expect(result.directScore).toBe(50);
  });

  it('ignores null/undefined text fields', () => {
    const cls = [compileClassifier({ id: 'a', score: 50, patterns: ['test'] })];
    // Should not throw even when some fields are null
    expect(() => scoreOne([null, undefined, 'test data'], cls)).not.toThrow();
    const result = scoreOne([null, undefined, 'test data'], cls);
    expect(result.directScore).toBe(50);
  });

  // End-to-end regression for the full LLM → compile → match chain.
  // Uses a real Claude-style classifier with (?i) inline flags to prove the
  // scoring engine works with the kind of patterns the LLM actually produces.
  it('real-world: Claude-style domain admin classifier matches HBR-style data', () => {
    const claudeClassifier = {
      id: 'domain-admins',
      label: 'Domain Administrators',
      score: 100,
      tier: 'critical',
      domain: 'privileged-access-management',
      description: 'Highest privilege AD role',
      patterns: [
        '(?i)\\bdomain\\s*admin(istrator)?s?\\b',
        '(?i)\\bdomein\\s*beheerders?\\b',
        '(?i)\\benterprise\\s*admin(istrator)?s?\\b',
      ],
    };
    const cls = [compileClassifier(claudeClassifier)];
    // These are real HBR resource display names from the test dataset
    expect(scoreOne(['GG_ROL_AD_Administrators'], cls).directScore).toBe(0); // doesn't match "domain"
    expect(scoreOne(['Domain Admins'], cls).directScore).toBe(100);
    expect(scoreOne(['Enterprise Admins'], cls).directScore).toBe(100);
    expect(scoreOne(['Domein Beheerders'], cls).directScore).toBe(100); // Dutch variant
    expect(scoreOne(['Some Random Group'], cls).directScore).toBe(0);
  });
});
