import { describe, it, expect } from 'vitest';
import {
  normValue, tokensOf, prefixKey, orgValueOf, signalKeys, evaluateSignal,
  DEFAULT_PREFIXES, SURNAME_INITIAL_FACTOR, MIN_TOKEN_LENGTH,
  fuzzyWords, fuzzySimilarity, FUZZY_FLOOR, DICE_MIN, SHARED_WORD,
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
    expect(signalKeys('soundex', 'Jane Doe')).toEqual([]);
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
    for (const type of ['exact', 'prefix', 'name', 'token', 'fuzzy']) {
      expect(evaluateSignal(sig(type), '', 'x')).toBe(0);
      expect(evaluateSignal(sig(type), 'x', null)).toBe(0);
    }
  });
  it('an unknown signal type never fires', () => {
    expect(evaluateSignal(sig('soundex'), 'same', 'same')).toBe(0);
  });
});

describe('fuzzyWords', () => {
  it('splits camelCase, lowercases and drops legal forms and noise words', () => {
    expect(fuzzyWords('PortOfRotterdam')).toEqual(['port', 'rotterdam']);
    expect(fuzzyWords('The Contoso Group B.V.')).toEqual(['contoso']);
    expect(fuzzyWords('Fabrikam Holding SE')).toEqual(['fabrikam']);
  });
  it('folds accents', () => {
    expect(fuzzyWords('Café Zürich')).toEqual(['cafe', 'zurich']);
  });
  it('keeps the words when a name is nothing but noise', () => {
    expect(fuzzyWords('B.V.')).toEqual(['b', 'v']);
  });
  it('gives nothing for an empty value', () => {
    expect(fuzzyWords('')).toEqual([]);
    expect(fuzzyWords(null)).toEqual([]);
  });
});

describe('fuzzySimilarity', () => {
  it('pins its thresholds', () => {
    expect([FUZZY_FLOOR, DICE_MIN, SHARED_WORD]).toEqual([0.5, 0.7, 0.5]);
  });
  it('is 1 for names equal once noise, case, accents and camelCase are gone', () => {
    expect(fuzzySimilarity('Hello Fresh SE', 'HelloFresh')).toBe(1);
    expect(fuzzySimilarity('Café Contoso', 'CAFE CONTOSO B.V.')).toBe(1);
  });
  it('letter overlap counts only from 0.7: a typo yes, shared letters no', () => {
    expect(fuzzySimilarity('Fabrikam', 'Fabricam')).toBeCloseTo(10 / 14, 5); // 0.714
    expect(fuzzySimilarity('_Intern', 'Interxion')).toBe(0); // dice 0.615
    expect(fuzzySimilarity('ASML', 'Alfam')).toBe(0);
  });
  it('contained words: 0.9 less 0.05 per extra word, never under 0.6', () => {
    expect(fuzzySimilarity('Verne Business Excellence', 'Verne')).toBe(0.8);
    expect(fuzzySimilarity('Nexxbiz', 'Nexxbiz Operations B.V.')).toBe(0.85);
    expect(fuzzySimilarity('Contoso', 'Contoso North East West South Central Hub Ops')).toBe(0.6); // 7 extra: 0.55 → 0.6
  });
  it('a shared word of at least five letters is 0.5; a four-letter one is nothing', () => {
    expect(fuzzySimilarity('Havenbedrijf Rotterdam N.V.', 'PortOfRotterdam')).toBe(0.5);
    expect(fuzzySimilarity('Adatum Trade', 'Wingtip Trade')).toBe(0.5);
    expect(fuzzySimilarity('Adatum Toys', 'Wingtip Toys')).toBe(0);
  });
  it('is 0 when either side has no words', () => {
    expect(fuzzySimilarity('', 'Contoso')).toBe(0);
    expect(fuzzySimilarity('Contoso', '  ')).toBe(0);
  });
});

describe('fuzzy signal', () => {
  it('index keys: every word of two letters or more, and the first three letters of a longer one', () => {
    expect(signalKeys('fuzzy', 'Jane Doe')).toEqual(['jane', 'jan', 'doe']);
    expect(signalKeys('fuzzy', 'Contoso B.V.')).toEqual(['contoso', 'con']);
    expect(signalKeys('fuzzy', 'X Ray')).toEqual(['ray']);
  });
  it('earns round(weight × similarity) from 0.5 up, nothing below', () => {
    expect(evaluateSignal(sig('fuzzy', 100), 'Hello Fresh SE', 'HelloFresh')).toBe(100);
    expect(evaluateSignal(sig('fuzzy', 90), 'Nexxbiz Operations B.V.', 'Nexxbiz')).toBe(77); // 76.5
    expect(evaluateSignal(sig('fuzzy', 80), 'Havenbedrijf Rotterdam N.V.', 'PortOfRotterdam')).toBe(40);
    expect(evaluateSignal(sig('fuzzy', 100), '_Intern', 'Interxion')).toBe(0);
  });
});

describe('fuzzy signal on the raw values (camelCase survives)', () => {
  const fuzzy = { type: 'fuzzy', weight: 100 };
  it('splits a camelCase target before comparing, so a shared word proposes the pair', () => {
    expect(evaluateSignal(fuzzy, 'Havenbedrijf Rotterdam N.V.', 'PortOfRotterdam')).toBe(50);
    expect(evaluateSignal(fuzzy, 'Hello Fresh SE', 'HelloFresh')).toBe(100);
    expect(evaluateSignal(fuzzy, '_Intern', 'Interxion')).toBe(0);
  });
});
