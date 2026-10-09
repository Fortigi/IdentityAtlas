import { describe, it, expect } from 'vitest';
import {
  normValue, tokensOf, prefixKey, orgValueOf, signalKeys, evaluateSignal,
  DEFAULT_PREFIXES, SURNAME_INITIAL_FACTOR, MIN_TOKEN_LENGTH,
} from './signals.js';

const sig = (type, weight = 80) => ({ type, weight, name: type });

describe('normValue', () => {
  it('trims, casefolds and collapses inner whitespace', () => {
    expect(normValue('  Jane   DOE\t Smith ')).toBe('jane doe smith');
  });
  it('turns null and undefined into the empty string, keeps 0', () => {
    expect(normValue(null)).toBe('');
    expect(normValue(undefined)).toBe('');
    expect(normValue(0)).toBe('0');
  });
});

describe('tokensOf', () => {
  it('splits on separators and drops one-letter tokens', () => {
    expect(tokensOf('SG_SAP_PROD-Users x')).toEqual(['sg', 'sap', 'prod', 'users']);
    expect(MIN_TOKEN_LENGTH).toBe(2);
  });
  it('keeps two-letter tokens and accented letters', () => {
    expect(tokensOf('HR Café')).toEqual(['hr', 'café']);
  });
  it('gives nothing for an empty value', () => {
    expect(tokensOf('')).toEqual([]);
    expect(tokensOf(null)).toEqual([]);
  });
});

describe('prefixKey', () => {
  it('reads the local part and strips a known prefix', () => {
    expect(prefixKey('ADM-jdoe@contoso.com')).toBe('jdoe');
    expect(prefixKey('jdoe@contoso.com')).toBe('jdoe');
  });
  it('uses the account-linking default prefixes', () => {
    expect(DEFAULT_PREFIXES).toContain('adm-');
    expect(DEFAULT_PREFIXES).toContain('ext_');
  });
  it('accepts an explicit prefix list', () => {
    expect(prefixKey('x-jdoe@contoso.com', ['x-'])).toBe('jdoe');
    expect(prefixKey('adm-jdoe@contoso.com', ['x-'])).toBe('adm-jdoe');
  });
});

describe('orgValueOf', () => {
  const e = { displayName: '  Project Atlas ', attributes: { email: ' ann@contoso.com ', budget: 0, blank: '', none: null } };
  it('reads displayName for the name attribute', () => {
    expect(orgValueOf(e, 'displayName')).toBe('Project Atlas');
  });
  it('reads and trims a mapped attribute, stringifying numbers', () => {
    expect(orgValueOf(e, 'email')).toBe('ann@contoso.com');
    expect(orgValueOf(e, 'budget')).toBe('0');
  });
  it('gives the empty string for missing, null or blank attributes', () => {
    expect(orgValueOf(e, 'blank')).toBe('');
    expect(orgValueOf(e, 'none')).toBe('');
    expect(orgValueOf(e, 'missing')).toBe('');
    expect(orgValueOf({ displayName: 'x' }, 'email')).toBe('');
    expect(orgValueOf(null, 'displayName')).toBe('');
  });
});

describe('signalKeys', () => {
  it('exact: the normalised value', () => {
    expect(signalKeys('exact', ' Ann@Contoso.com ')).toEqual(['ann@contoso.com']);
  });
  it('prefix: the stripped local part', () => {
    expect(signalKeys('prefix', 'adm-ann@contoso.com')).toEqual(['ann']);
  });
  it('prefix: nothing when the local part is only a prefix', () => {
    expect(signalKeys('prefix', 'adm-@contoso.com')).toEqual([]);
  });
  it('name: the parsed surname, either name order', () => {
    expect(signalKeys('name', 'Jane Doe')).toEqual(['doe']);
    expect(signalKeys('name', 'Doe, Jane')).toEqual(['doe']);
  });
  it('token: the distinct tokens', () => {
    expect(signalKeys('token', 'SAP sap PROD')).toEqual(['sap', 'prod']);
  });
  it('nothing for an empty value or an unknown type', () => {
    expect(signalKeys('exact', '   ')).toEqual([]);
    expect(signalKeys('fuzzy', 'Jane Doe')).toEqual([]);
  });
});

describe('evaluateSignal', () => {
  it('exact: full weight on case/space-insensitive equality, nothing otherwise', () => {
    expect(evaluateSignal(sig('exact', 90), 'Ann@Contoso.com ', 'ann@contoso.com')).toBe(90);
    expect(evaluateSignal(sig('exact', 90), 'ann@contoso.com', 'ann@contoso.co')).toBe(0);
  });

  it('prefix: an admin account matches the plain account, both ways', () => {
    expect(evaluateSignal(sig('prefix', 80), 'adm-jdoe@contoso.com', 'jdoe@contoso.com')).toBe(80);
    expect(evaluateSignal(sig('prefix', 80), 'jdoe@contoso.com', 'adm-jdoe@northwind.com')).toBe(80);
  });
  it('prefix: different local parts never match', () => {
    expect(evaluateSignal(sig('prefix', 80), 'adm-jdoe@contoso.com', 'jdoes@contoso.com')).toBe(0);
  });

  it('name: full name earns the whole weight, in either order', () => {
    expect(evaluateSignal(sig('name', 60), 'Jane Doe', 'Doe, Jane')).toBe(60);
  });
  it('name: surname + initial earns 75 %, rounded', () => {
    expect(SURNAME_INITIAL_FACTOR).toBe(0.75);
    expect(evaluateSignal(sig('name', 60), 'J. Doe', 'Jane Doe')).toBe(45);
    expect(evaluateSignal(sig('name', 50), 'J Doe', 'Jane Doe')).toBe(38); // 37.5 rounds up
  });
  it('name: same surname with a different initial, or surname only, is no match', () => {
    expect(evaluateSignal(sig('name', 60), 'Kim Doe', 'Jane Doe')).toBe(0);
    expect(evaluateSignal(sig('name', 60), 'Doe', 'Jane Doe')).toBe(0);
  });

  it('token: every org token must be a target token', () => {
    expect(evaluateSignal(sig('token', 50), 'SAP PROD', 'SG_SAP_PROD_Users')).toBe(50);
    expect(evaluateSignal(sig('token', 50), 'SAP PROD', 'SG_SAP_TEST_Users')).toBe(0);
  });
  it('token: a token must match whole, not as a substring', () => {
    expect(evaluateSignal(sig('token', 50), 'SAP', 'SG_SAPPHIRE')).toBe(0);
  });
  it('token: an org value with only one-letter tokens never fires', () => {
    expect(evaluateSignal(sig('token', 50), 'A B', 'A B C')).toBe(0);
  });

  it('an empty org or target value never fires', () => {
    for (const type of ['exact', 'prefix', 'name', 'token']) {
      expect(evaluateSignal(sig(type), '', 'x')).toBe(0);
      expect(evaluateSignal(sig(type), 'x', null)).toBe(0);
    }
  });
  it('an unknown signal type never fires', () => {
    expect(evaluateSignal(sig('fuzzy'), 'same', 'same')).toBe(0);
  });
});
