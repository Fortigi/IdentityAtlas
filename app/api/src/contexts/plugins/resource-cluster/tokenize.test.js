import { describe, it, expect } from 'vitest';
import { tokenize, DEFAULT_STOPWORDS, buildStopwords, prettifyToken } from './tokenize.js';

describe('tokenize', () => {
  it('splits on hyphen / underscore / dot / slash / backslash / whitespace', () => {
    expect(tokenize('app_hamis-admins.tst\\grp/prod uat'))
      .toEqual(['hamis']);
  });

  it('treats parens / brackets / punctuation as separators', () => {
    expect(tokenize('Eigenaren van Smart-Infra (INKOOP EN CONTRACTMANAGEMENT)'))
      .toEqual(['smart', 'infra', 'inkoop', 'contractmanagement']);
    expect(tokenize('Role: Procurement+Invoicing; Team=A&B'))
      .toEqual(['procurement', 'invoicing']);
  });

  it('strips Dutch connective tokens like "van"', () => {
    expect(tokenize('AG_ROL_DMS_EIGENAREN VAN FINANCE (INKOOP)'))
      .toEqual(['dms', 'finance', 'inkoop']);
  });

  it('lowercases tokens', () => {
    expect(tokenize('APP_HAMIS_ADMINS')).toEqual(['hamis']);
    // "readers" is a stopword, but "mixedcase" and "hamis" both survive.
    expect(tokenize('MixedCase_HAMIS_Readers')).toEqual(['mixedcase', 'hamis']);
  });

  it('drops short tokens', () => {
    expect(tokenize('a_bc_de_hamis')).toEqual(['hamis']);
    expect(tokenize('hamis_bi', { minTokenLength: 3 })).toEqual(['hamis']);
  });

  it('drops numeric tokens', () => {
    expect(tokenize('app_hamis_2024_v2')).toEqual(['hamis']);
  });

  it('drops default stopwords (role / env / type / filler)', () => {
    expect(tokenize('SG_APP_HAMIS_Admins_P')).toEqual(['hamis']);
    expect(tokenize('GRP-HAMIS-ReadOnly-TST')).toEqual(['hamis']);
    expect(tokenize('M365_HAMIS_Owners')).toEqual(['hamis']);
    expect(tokenize('App HAMIS Administrators ACC')).toEqual(['hamis']);
  });

  it('dedupes tokens within a name', () => {
    expect(tokenize('hamis_hamis_hamis')).toEqual(['hamis']);
  });

  it('preserves non-stopword tokens in occurrence order', () => {
    // minTokenLength 3 keeps "hcc"; "editors" is a stopword so it's dropped.
    expect(tokenize('sg_hamis_hcc_editors')).toEqual(['hamis', 'hcc']);
  });

  it('returns [] for empty / null input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it('groups name variants onto the same significant token', () => {
    const variants = [
      'SG_APP_HAMIS_Admins_P',
      'GRP-HAMIS-Readers-TST',
      'M365 HAMIS Owners',
      'app_hamis_fullaccess',
      'HAMIS BI',  // "bi" is 2 chars, filtered by minTokenLength=3
    ];
    const allTokens = variants.map(v => tokenize(v));
    for (const tokens of allTokens) {
      expect(tokens).toContain('hamis');
    }
  });

  it('honours an additional stopword list', () => {
    const sw = buildStopwords(['hamis']);
    expect(tokenize('SG_HAMIS_Finance_Admins', { stopwords: sw })).toEqual(['finance']);
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
    expect(prettifyToken('hamis')).toBe('HAMIS');
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
