import { describe, it, expect } from 'vitest';
import {
  normalizeName, normalizedNameSql, jaroWinkler, buildNameMatcher, FOLD_FROM, FOLD_TO, FUZZY_THRESHOLD, FUZZY_MARGIN,
} from './nameMatch.js';

describe('normalizeName', () => {
  it.each([
    ['  Jan   Jansen ', 'jan jansen'],
    ['JAN JANSEN', 'jan jansen'],
    ['Gerda Brümmel', 'gerda brummel'],
    ['Søren Łukasz', 'soren lukasz'],
    ['Tom Example | Example Org', 'tom example'],
    ['Tom Example (Contractor)', 'tom example'],
    ['Tom Example|Org', 'tom example'],
    ['Jansen, Jan', 'jan jansen'],
    ['Jansen,Jan | Example Org', 'jan jansen'],
    ['Jan-Peter J. de Vries', 'jan peter j de vries'],
    ['jan_peter', 'jan peter'],
    // only ONE suffix, and only at the end
    ['Org (A) Person', 'org (a) person'],
    // two commas are not "Last, First"
    ['A, B, C', 'a, b, c'],
    ['', ''],
    [null, ''],
  ])('%j → %j', (value, expected) => {
    expect(normalizeName(value)).toBe(expected);
  });

  it('folds every letter of the SQL translate table to the same letter as the SQL does', () => {
    const from = [...FOLD_FROM];
    const to = [...FOLD_TO];
    expect(from).toHaveLength(to.length);
    for (let i = 0; i < from.length; i++) expect(`${from[i]}=${normalizeName(from[i])}`).toBe(`${from[i]}=${to[i]}`);
  });
});

describe('normalizedNameSql', () => {
  const sql = normalizedNameSql('c.owner');

  it('applies the same steps in the same order as the JS normaliser', () => {
    const steps = ['translate(lower(btrim(c.owner))', `'\\s*(\\|[^|]*|\\([^()]*\\))\\s*$', ''`, `'^([^,]+),\\s*([^,]+)$', '\\2 \\1'`,
      `'[._-]+', ' ', 'g'`, `'\\s+', ' ', 'g'`];
    const at = steps.map(s => sql.indexOf(s));
    expect(at.every(i => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(sql.startsWith('btrim(')).toBe(true);
    expect(sql).toContain(`'${FOLD_FROM}', '${FOLD_TO}'`);
  });

  // The SQL's own literals — the translate table and each regexp_replace's
  // pattern, replacement and flag — run in order with JS semantics (the subset
  // used means the same in PostgreSQL's ARE) give what normalizeName gives.
  function runSql(value) {
    const literals = [...sql.matchAll(/, '((?:[^']|'')*)', '((?:[^']|'')*)'(?:, '(g)')?\)/g)];
    expect(literals).toHaveLength(5);
    const [[, from, to], ...replaces] = literals;
    let s = [...value.trim().toLowerCase()].map(ch => (from.includes(ch) ? [...to][[...from].indexOf(ch)] : ch)).join('');
    for (const [, pattern, replacement, g] of replaces) {
      s = s.replace(new RegExp(pattern, g ? 'g' : ''), replacement.replace(/\\(\d)/g, '$$$1'));
    }
    return s.trim();
  }

  it.each(['Jansen,  Jan | Example Org', 'Tom Example (Contractor)', 'Jan-Peter J. de Vries', 'A, B, C', 'Gerda Brümmel', 'Org (A) Person'])(
    '%j: the SQL gives what normalizeName gives', (value) => {
      expect(runSql(value)).toBe(normalizeName(value));
    });
});

describe('jaroWinkler', () => {
  it.each([
    ['martha', 'marhta', 0.961],
    ['dwayne', 'duane', 0.84],
    ['dixon', 'dicksonx', 0.813],
    ['jon smith', 'john smith', 0.973],
  ])('%s ~ %s = %f', (a, b, expected) => {
    expect(jaroWinkler(a, b)).toBeCloseTo(expected, 3);
  });

  it('is 1 for equal strings and 0 against an empty one or with no common letter', () => {
    expect(jaroWinkler('abc', 'abc')).toBe(1);
    expect(jaroWinkler('abc', '')).toBe(0);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('counts the common prefix up to four letters only', () => {
    const four = jaroWinkler('abcdxxxx', 'abcdyyyy');
    expect(jaroWinkler('abcdexxx', 'abcdeyyy')).toBeGreaterThan(four);
    // with the prefix capped at four, a fifth common letter adds only its Jaro share
    expect(jaroWinkler('abcdexxx', 'abcdeyyy') - four).toBeLessThan(0.1);
  });
});

const C = (id, name, preferred = true) => ({ id, name, preferred });

describe('buildNameMatcher — normalised equal', () => {
  it('the one candidate with that name matches by name', () => {
    const match = buildNameMatcher([C('a', 'Gerda Brümmel | Example Org'), C('b', 'Jan Jansen')]);
    expect(match('Brummel, Gerda')).toEqual({ id: 'a', kind: 'name' });
    expect(match('JAN  JANSEN')).toEqual({ id: 'b', kind: 'name' });
  });

  it('two preferred candidates with the name are ambiguous; a preferred one beats others', () => {
    expect(buildNameMatcher([C('a', 'Jan Jansen'), C('b', 'jan jansen')])('Jan Jansen')).toEqual({ ambiguous: true });
    expect(buildNameMatcher([C('sp', 'Jan Jansen', false), C('u', 'Jan Jansen')])('Jan Jansen')).toEqual({ id: 'u', kind: 'name' });
    expect(buildNameMatcher([C('sp1', 'Jan Jansen', false), C('sp2', 'Jan Jansen', false)])('Jan Jansen')).toEqual({ ambiguous: true });
    expect(buildNameMatcher([C('sp', 'Jan Jansen', false)])('Jan Jansen')).toEqual({ id: 'sp', kind: 'name' });
  });

  it('a candidate listed twice is one candidate; nameless ones and empty values match nothing', () => {
    expect(buildNameMatcher([C('a', 'Jan Jansen'), C('a', 'Jan Jansen')])('Jan Jansen')).toEqual({ id: 'a', kind: 'name' });
    const match = buildNameMatcher([C('a', null), C('b', '')]);
    expect(match('')).toBeNull();
    expect(match('anything')).toBeNull();
  });
});

describe('buildNameMatcher — near misses', () => {
  it('accepts one clearly closest candidate above the threshold, flagged fuzzy', () => {
    const match = buildNameMatcher([C('a', 'John Smith'), C('b', 'Piet Jansen')]);
    expect(match('Jon Smith')).toEqual({ id: 'a', kind: 'fuzzy', matchedName: 'John Smith', score: 0.973 });
  });

  it('rejects a candidate below the threshold', () => {
    // "ann lee" ~ "anne lee" is 0.921: close, but not close enough.
    expect(jaroWinkler('ann lee', 'anne lee')).toBeLessThan(FUZZY_THRESHOLD);
    expect(buildNameMatcher([C('a', 'Anne Lee')])('Ann Lee')).toBeNull();
  });

  it('a runner-up too close makes it ambiguous, never a guess', () => {
    // "jan janssen" is 0.982 from "jan jansen" and 0.980 from "jan janse".
    const match = buildNameMatcher([C('a', 'Jan Jansen'), C('b', 'Jan Janse')]);
    expect(match('Jan Janssen')).toEqual({ ambiguous: true });
    // a runner-up above the threshold but a margin behind is no obstacle
    expect(buildNameMatcher([C('a', 'Jan Jansen'), C('b', 'Jan Hansen')])('Jan Janssen')).toMatchObject({ id: 'a', kind: 'fuzzy' });
    expect(jaroWinkler('jan janssen', 'jan jansen') - jaroWinkler('jan janssen', 'jan hansen')).toBeGreaterThanOrEqual(FUZZY_MARGIN);
    expect(jaroWinkler('jan janssen', 'jan hansen')).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
  });

  it('prefers user accounts: a close user wins over a closer service principal, and its runner-up is a user', () => {
    const match = buildNameMatcher([C('sp', 'Jon Smith', false), C('u', 'John Smith')]);
    // one letter off both; the user is chosen because user accounts go first
    expect(match('Jonn Smith')).toMatchObject({ id: 'u', kind: 'fuzzy' });
    expect(buildNameMatcher([C('sp', 'John Smith', false)])('Jon Smith')).toMatchObject({ id: 'sp', kind: 'fuzzy' });
  });
});
