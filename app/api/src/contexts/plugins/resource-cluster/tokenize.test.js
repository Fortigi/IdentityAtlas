import { describe, it, expect } from 'vitest';
import { tokenize, DEFAULT_STOPWORDS, buildStopwords, prettifyToken } from './tokenize.js';

describe('tokenize', () => {
  it('splits on hyphen / underscore / dot / slash / backslash / whitespace', () => {
    expect(tokenize('app_axiom-admins.tst\\grp/prod uat'))
      .toEqual(['axiom']);
  });

  it('lowercases tokens', () => {
    expect(tokenize('APP_AXIOM_ADMINS')).toEqual(['axiom']);
    // "readers" is a stopword, but "mixedcase" and "axiom" both survive.
    expect(tokenize('MixedCase_AXIOM_Readers')).toEqual(['mixedcase', 'axiom']);
  });

  it('drops short tokens', () => {
    expect(tokenize('a_bc_de_axiom')).toEqual(['axiom']);
    expect(tokenize('axiom_bi', { minTokenLength: 3 })).toEqual(['axiom']);
  });

  it('drops numeric tokens', () => {
    expect(tokenize('app_axiom_2024_v2')).toEqual(['axiom']);
  });

  it('drops default stopwords (role / env / type / filler)', () => {
    expect(tokenize('SG_APP_AXIOM_Admins_P')).toEqual(['axiom']);
    expect(tokenize('GRP-AXIOM-ReadOnly-TST')).toEqual(['axiom']);
    expect(tokenize('M365_AXIOM_Owners')).toEqual(['axiom']);
    expect(tokenize('App AXIOM Administrators ACC')).toEqual(['axiom']);
  });

  it('dedupes tokens within a name', () => {
    expect(tokenize('axiom_axiom_axiom')).toEqual(['axiom']);
  });

  it('preserves non-stopword tokens in occurrence order', () => {
    // minTokenLength 3 keeps "hcc"; "editors" is a stopword so it's dropped.
    expect(tokenize('sg_axiom_hcc_editors')).toEqual(['axiom', 'hcc']);
  });

  it('returns [] for empty / null input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it('groups name variants onto the same significant token', () => {
    const variants = [
      'SG_APP_AXIOM_Admins_P',
      'GRP-AXIOM-Readers-TST',
      'M365 AXIOM Owners',
      'app_axiom_fullaccess',
      'AXIOM BI',  // "bi" is 2 chars, filtered by minTokenLength=3
    ];
    const allTokens = variants.map(v => tokenize(v));
    for (const tokens of allTokens) {
      expect(tokens).toContain('axiom');
    }
  });

  it('honours an additional stopword list', () => {
    const sw = buildStopwords(['axiom']);
    expect(tokenize('SG_AXIOM_Finance_Admins', { stopwords: sw })).toEqual(['finance']);
  });
});

describe('DEFAULT_STOPWORDS', () => {
  it('covers common role, env, AD prefix, and filler words', () => {
    for (const w of ['admin', 'users', 'prod', 'tst', 'sg', 'm365', 'app', 'none']) {
      expect(DEFAULT_STOPWORDS.has(w)).toBe(true);
    }
  });
});

describe('prettifyToken', () => {
  it('uppercases short tokens (acronyms)', () => {
    expect(prettifyToken('axiom')).toBe('AXIOM');
    expect(prettifyToken('hr')).toBe('HR');
  });
  it('title-cases longer multi-word tokens', () => {
    expect(prettifyToken('procurement')).toBe('Procurement');
    expect(prettifyToken('fleet-ops')).toBe('Fleet Ops');
  });
  it('returns empty string for falsy input', () => {
    expect(prettifyToken('')).toBe('');
    expect(prettifyToken(null)).toBe('');
  });
});
