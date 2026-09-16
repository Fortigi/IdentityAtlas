// Unit tests for the pure account-linking engine helpers (no DB).
//
// These cover the indexing / candidate-collection / aggregation building blocks
// factored out of engine.js, including branches the buildLinks/runLinking tests
// don't exercise directly (empty-key skipping, prefix-stripped candidate hits,
// and merging several links onto one identity).

import { describe, it, expect } from 'vitest';
import {
  norm,
  fullName,
  personName,
  prefixesFrom,
  suffixesFrom,
  nameSignalNames,
  indexIdentities,
  collectCandidates,
  aggregateByIdentity,
} from './engine.helpers.js';
import { DEFAULT_RULES } from './defaultRules.js';

describe('norm', () => {
  it('lower-cases and trims a scalar', () => {
    expect(norm('  ADM-JDoe  ')).toBe('adm-jdoe');
  });
  it('maps null/undefined to the empty string', () => {
    expect(norm(null)).toBe('');
    expect(norm(undefined)).toBe('');
  });
});

describe('fullName', () => {
  it('joins givenName + surname into a normalised token', () => {
    expect(fullName({ givenName: 'John', surname: 'Doe' })).toBe('johndoe');
  });
  it('skips missing parts', () => {
    expect(fullName({ surname: 'Doe' })).toBe('doe');
  });
});

describe('personName', () => {
  it('parses "Surname, Given" into a comparable key', () => {
    const a = personName({ displayName: 'Euson, Robin (OGD)' });
    const b = personName({ displayName: '(ADM-azure) Euson, Robin' });
    expect(a.key).toBe(b.key);
    expect(a.surname).toBe('euson');
    expect(a.given).toBe('robin');
  });
});

describe('signal extractors', () => {
  it('prefixesFrom pulls stripPrefixes from the prefix signal', () => {
    expect(prefixesFrom(DEFAULT_RULES)).toContain('adm-');
  });
  it('suffixesFrom returns [] when no fuzzy signal exists', () => {
    expect(suffixesFrom(DEFAULT_RULES)).toEqual([]);
  });
  it('nameSignalNames returns the set of name-signal names', () => {
    const set = nameSignalNames(DEFAULT_RULES);
    expect(set.has('fullName')).toBe(true);
    expect(set.has('surnameInitial')).toBe(true);
    expect(set.has('employeeId')).toBe(false);
  });
  it('all extractors tolerate rules without a signals array', () => {
    expect(prefixesFrom({})).toEqual([]);
    expect(suffixesFrom({})).toEqual([]);
    expect(nameSignalNames({}).size).toBe(0);
  });
});

describe('indexIdentities', () => {
  it('indexes by employeeId, email-local, name and name-key', () => {
    const idy = { id: 'i1', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };
    const { byEmployeeId, byEmailLocal, byName, byNameKey } = indexIdentities([idy]);
    expect(byEmployeeId.get('e1')).toEqual([idy]);
    expect(byEmailLocal.get('jdoe')).toEqual([idy]);
    expect(byName.get('doejohn')).toEqual([idy]);
    expect(byNameKey.get(personName(idy).key)).toEqual([idy]);
  });
  it('skips empty keys (no employeeId / no email)', () => {
    const idy = { id: 'i2', displayName: '', email: '', employeeId: '' };
    const { byEmployeeId, byEmailLocal } = indexIdentities([idy]);
    expect(byEmployeeId.size).toBe(0);
    expect(byEmailLocal.size).toBe(0);
  });
  it('groups multiple identities under a shared key', () => {
    const a = { id: 'a', displayName: 'Jansen, Jan', email: 'jan.jansen@x.com' };
    const b = { id: 'b', displayName: 'Jansen, Jan', email: 'j.jansen@y.com' };
    const { byNameKey } = indexIdentities([a, b]);
    expect(byNameKey.get(personName(a).key)).toEqual([a, b]);
  });
});

describe('collectCandidates', () => {
  const indexes = indexIdentities([
    { id: 'byId',   displayName: 'A A', email: 'aa@x.com', employeeId: 'E7' },
    { id: 'byMail', displayName: 'B B', email: 'jdoe@contoso.com' },
    { id: 'byName', displayName: 'Doe, John', email: 'zzz@nowhere.com' },
  ]);
  const opts = { prefixes: prefixesFrom(DEFAULT_RULES), suffixes: suffixesFrom(DEFAULT_RULES) };

  it('collects across employeeId, email and name indexes, deduped by id', () => {
    const orphan = { id: 'o', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E7' };
    const ids = [...collectCandidates(orphan, indexes, opts).keys()].sort();
    expect(ids).toEqual(['byId', 'byMail', 'byName']);
  });
  it('matches on the prefix-stripped email local part', () => {
    const orphan = { id: 'adm', displayName: 'X', email: 'adm-jdoe@contoso.com' };
    const ids = [...collectCandidates(orphan, indexes, opts).keys()];
    expect(ids).toContain('byMail'); // adm-jdoe → jdoe after stripping 'adm-'
  });
  it('returns an empty map when nothing matches', () => {
    const orphan = { id: 'none', displayName: 'Nobody Here', email: 'nobody@void.com' };
    expect(collectCandidates(orphan, indexes, opts).size).toBe(0);
  });
});

describe('aggregateByIdentity', () => {
  it('keeps the best confidence and the union of signals per identity', () => {
    const links = [
      { identityId: 'x', confidence: 60, signals: ['fullName'] },
      { identityId: 'x', confidence: 80, signals: ['emailPrefix', 'fullName'] },
      { identityId: 'y', confidence: 95, signals: ['employeeId'] },
    ];
    const agg = aggregateByIdentity(links);
    expect(agg.get('x').conf).toBe(80);
    expect([...agg.get('x').signals].sort()).toEqual(['emailPrefix', 'fullName']);
    expect(agg.get('y').conf).toBe(95);
  });
  it('returns an empty map for no links', () => {
    expect(aggregateByIdentity([]).size).toBe(0);
  });
});

// ── Candidate gathering and signal lookup ────────────────────────────────────
//
// collectCandidates decides which identities an orphan is even COMPARED against. A lookup
// that silently returns nothing is the quietest possible failure: the orphan is scored
// against fewer candidates, finds no match, and stays unlinked -- the person's accounts
// remain split with no error anywhere. Everything below survived mutation.

describe('collectCandidates - every index is actually consulted', () => {
  const idy = (id) => ({ id, displayName: `Identity ${id}` });
  const emptyIndexes = () => ({
    byEmployeeId: new Map(), byEmailLocal: new Map(), byName: new Map(), byNameKey: new Map(),
  });

  it('finds a candidate through the EMAIL LOCAL PART index', () => {
    const ix = emptyIndexes();
    ix.byEmailLocal.set('jsmith', [idy('i-email')]);
    const got = collectCandidates({ email: 'JSmith@corp.com' }, ix, { prefixes: [], suffixes: [] });
    expect([...got.keys()]).toEqual(['i-email']);
  });

  it('finds a candidate through the STRIPPED email local part', () => {
    // adm-jsmith@corp -> jsmith once the admin prefix is stripped. This is the whole point
    // of prefix rules: an admin account and its human owner share no literal address.
    const ix = emptyIndexes();
    ix.byEmailLocal.set('jsmith', [idy('i-stripped')]);
    const got = collectCandidates({ email: 'adm-jsmith@corp.com' }, ix, { prefixes: ['adm-'], suffixes: [] });
    expect([...got.keys()]).toEqual(['i-stripped']);
  });

  it('finds a candidate through the NAME index', () => {
    const ix = emptyIndexes();
    ix.byName.set('alicesmith', [idy('i-name')]);
    const got = collectCandidates({ displayName: 'Alice Smith' }, ix, { prefixes: [], suffixes: [] });
    expect([...got.keys()]).toEqual(['i-name']);
  });

  it('falls back to givenName + surname when there is no displayName', () => {
    // normalizeName(displayName) || fullName(o) -- the second half only ever runs for a
    // principal with no display name, which is ordinary for service-created accounts.
    const ix = emptyIndexes();
    ix.byName.set('alicesmith', [idy('i-parts')]);
    const got = collectCandidates({ givenName: 'Alice', surname: 'Smith' }, ix, { prefixes: [], suffixes: [] });
    expect([...got.keys()]).toEqual(['i-parts']);
  });

  it('collects from every index at once, de-duplicated by identity id', () => {
    const ix = emptyIndexes();
    const shared = idy('i-shared');
    ix.byEmployeeId.set('e1', [shared]);
    ix.byEmailLocal.set('jsmith', [shared, idy('i-other')]);
    const got = collectCandidates({ employeeId: 'E1', email: 'jsmith@corp.com' }, ix, { prefixes: [], suffixes: [] });
    expect([...got.keys()].sort()).toEqual(['i-other', 'i-shared']);
  });

  it('returns empty rather than throwing when nothing matches', () => {
    const got = collectCandidates({ email: 'nobody@corp.com' }, emptyIndexes(), { prefixes: [], suffixes: [] });
    expect(got.size).toBe(0);
  });
});

describe('signal lookup by type', () => {
  const rules = {
    signals: [
      { type: 'prefix', name: 'p', stripPrefixes: ['adm-'] },
      { type: 'fuzzy',  name: 'f', stripSuffixes: ['(admin)'] },
      { type: 'name',   name: 'displayName' },
      { type: 'name',   name: 'fullName' },
    ],
  };

  it('picks the prefix and fuzzy signals by their own type, not each others', () => {
    // Each finder matches on a different type string. Hard-coded true, `find` returns the
    // FIRST signal whatever it is -- so suffixesFrom would hand back the prefix rule's
    // (absent) stripSuffixes and quietly stop stripping suffixes at all.
    expect(prefixesFrom(rules)).toEqual(['adm-']);
    expect(suffixesFrom(rules)).toEqual(['(admin)']);
  });

  it('returns empty lists when the rule set has no such signal', () => {
    expect(prefixesFrom({ signals: [{ type: 'fuzzy', stripSuffixes: ['x'] }] })).toEqual([]);
    expect(suffixesFrom({ signals: [{ type: 'prefix', stripPrefixes: ['y'] }] })).toEqual([]);
  });

  it('returns empty lists for a rule set with no signals at all', () => {
    expect(prefixesFrom({})).toEqual([]);
    expect(suffixesFrom({})).toEqual([]);
    expect(nameSignalNames({}).size).toBe(0);
  });

  it('collects every name signal, and only name signals', () => {
    expect([...nameSignalNames(rules)].sort()).toEqual(['displayName', 'fullName']);
  });
});
