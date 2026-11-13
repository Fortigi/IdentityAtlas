// Matching a name to a context by its name or one of its aliases.
import { describe, it, expect } from 'vitest';
import { aliasesOf, mergeAliases, buildContextNameMatcher, MAX_ALIASES } from './contextNameMatch.js';

const HARBOUR = { id: 'c-1', displayName: 'Harbour Authority', extendedAttributes: { aliases: ['HA', 'Port Co'] } };
const PLANNER = { id: 'c-2', displayName: 'Planner', extendedAttributes: '{"aliases":["Rooster"]}' };
const DOCKS = { id: 'c-3', displayName: 'Docks Team', extendedAttributes: { aliases: 'Port Co' } };

describe('aliasesOf', () => {
  it('reads an array, a single string, and stored-as-text JSON; skips blanks and non-strings', () => {
    expect(aliasesOf({ aliases: [' HA ', '', 7, 'Port Co'] })).toEqual(['HA', 'Port Co']);
    expect(aliasesOf({ aliases: 'Port Co' })).toEqual(['Port Co']);
    expect(aliasesOf('{"aliases":["Rooster"]}')).toEqual(['Rooster']);
    expect(aliasesOf('not json')).toEqual([]);
    expect(aliasesOf(null)).toEqual([]);
    expect(aliasesOf({ aliases: { a: 1 } })).toEqual([]);
  });
});

describe('mergeAliases', () => {
  it('adds a new name at the end, folding its spaces', () => {
    expect(mergeAliases(['HA'], '  Port   Co ')).toEqual(['HA', 'Port Co']);
  });

  it('does not add a spelling already there (case, accents, dots)', () => {
    expect(mergeAliases(['Port Co'], 'port co')).toEqual(['Port Co']);
    expect(mergeAliases(['Rotterdam Haven'], 'Rotterdam-Haven')).toEqual(['Rotterdam Haven']);
    expect(mergeAliases(['Café'], 'cafe')).toEqual(['Café']);
  });

  it('adds nothing for an empty name, and keeps at most MAX_ALIASES', () => {
    expect(mergeAliases(['HA'], '   ')).toEqual(['HA']);
    const full = Array.from({ length: MAX_ALIASES }, (_, i) => `name ${i}`);
    expect(mergeAliases(full, 'one more')).toHaveLength(MAX_ALIASES);
    expect(mergeAliases(null, 'HA')).toEqual(['HA']);
  });
});

describe('buildContextNameMatcher', () => {
  const match = buildContextNameMatcher([HARBOUR, PLANNER, DOCKS]);

  it('a display name first, then an alias', () => {
    expect(match('harbour authority')).toEqual({ id: 'c-1', kind: 'name' });
    expect(match('ha')).toEqual({ id: 'c-1', kind: 'alias', matchedName: 'HA' });
    expect(match('rooster')).toEqual({ id: 'c-2', kind: 'alias', matchedName: 'Rooster' });
  });

  it('an alias two contexts share is ambiguous, never a guess', () => {
    expect(match('Port Co')).toEqual({ ambiguous: true });
  });

  it('a display name wins over another context\'s alias of the same spelling', () => {
    const m = buildContextNameMatcher([HARBOUR, { id: 'c-9', displayName: 'HA', extendedAttributes: null }]);
    expect(m('HA')).toEqual({ id: 'c-9', kind: 'name' });
  });

  it('a near miss of a display name is fuzzy; a near miss of an alias is nothing', () => {
    expect(match('Harbour Autority')).toMatchObject({ id: 'c-1', kind: 'fuzzy' });
    expect(match('Roostr')).toBeNull();
    expect(match('')).toBeNull();
  });
});
