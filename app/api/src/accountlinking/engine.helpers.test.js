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
  personNames,
  nameKeys,
  prefixesFrom,
  suffixesFrom,
  nameSignalNames,
  indexIdentities,
  collectCandidates,
  resolveNameTie,
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

describe('personNames', () => {
  it('parses "Surname, Given" into a comparable key', () => {
    const [a] = personNames({ displayName: 'Euson, Robin (OGD)' });
    const [b] = personNames({ displayName: '(ADM-azure) Euson, Robin' });
    expect(a.key).toBe(b.key);
    expect(a.surname).toBe('euson');
    expect(a.given).toBe('robin');
  });
  it('returns the name in use AND the birth name when they differ', () => {
    // HR holds the birth surname in the column and the display name the name in
    // use; the person is known by both and must be comparable under both (#1439).
    const names = personNames({ displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' });
    expect(names.map(v => v.surname).sort()).toEqual(['bakkerdewit', 'dewit']);
  });
});

describe('nameKeys', () => {
  it('lists one index key per name the person is known by', () => {
    expect(nameKeys({ displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' }).sort())
      .toEqual(['anna|bakkerdewit', 'anna|dewit']);
  });
  it('lists a key once even when two of the person’s names collapse onto it', () => {
    // A key sorts its two halves, so a display name written "Bakker Anna" — the
    // reversed pair — produces the SAME key as the clean columns.
    expect(nameKeys({ displayName: 'Bakker Anna', givenName: 'Anna', surname: 'Bakker' }))
      .toEqual(['anna|bakker']);
  });
  it('drops the empty key of a name with no surname', () => {
    // A given name on its own indexes nothing -- indexed under '', every
    // surname-less person in the tenant would collect every other one.
    expect(nameKeys({ givenName: 'Anna' })).toEqual([]);
    expect(nameKeys({})).toEqual([]);
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
    expect(byNameKey.get(nameKeys(idy)[0])).toEqual([idy]);
  });
  it('skips empty keys (no employeeId / no email)', () => {
    const idy = { id: 'i2', displayName: '', email: '', employeeId: '' };
    const { byEmployeeId, byEmailLocal } = indexIdentities([idy]);
    expect(byEmployeeId.size).toBe(0);
    expect(byEmailLocal.size).toBe(0);
  });
  it('indexes an identity once per key, not once per name that maps to it', () => {
    // Indexed twice, one person looks like two under that name: the tie-break
    // below can then never see them as its sole match, and their own account
    // goes to review instead of to them.
    const idy = { id: 'rev', displayName: 'Bakker Anna', givenName: 'Anna', surname: 'Bakker' };
    const { byNameKey } = indexIdentities([idy]);
    expect(byNameKey.get('anna|bakker')).toEqual([idy]);
  });
  it('groups multiple identities under a shared key', () => {
    const a = { id: 'a', displayName: 'Jansen, Jan', email: 'jan.jansen@x.com' };
    const b = { id: 'b', displayName: 'Jansen, Jan', email: 'j.jansen@y.com' };
    const { byNameKey } = indexIdentities([a, b]);
    expect(byNameKey.get(nameKeys(a)[0])).toEqual([a, b]);
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

describe('candidate gathering for titled and particle names (#1439)', () => {
  const opts = { prefixes: prefixesFrom(DEFAULT_RULES), suffixes: suffixesFrom(DEFAULT_RULES) };

  it('indexes a titled identity so her own untitled account still finds her', () => {
    // Indexing and scoring both go through personNames, so a scoring-only fix would leave
    // the owner out of the candidate set entirely and she would stay accountless.
    const owner = { id: 'owner', displayName: 'Jan de Vries MSc', givenName: 'Jan', surname: 'de Vries' };
    const indexes = indexIdentities([owner]);
    const orphan = { id: 'o', displayName: 'Jan de Vries' };
    expect([...collectCandidates(orphan, indexes, opts).keys()]).toEqual(['owner']);
  });

  it('gathers every namesake, titled or not, as a candidate', () => {
    const titled = { id: 'titled', displayName: 'Jan de Vries MSc', givenName: 'Jan', surname: 'de Vries' };
    const plain = { id: 'plain', displayName: 'Jan de Vries', givenName: 'Jan', surname: 'de Vries' };
    const indexes = indexIdentities([titled, plain]);
    const got = collectCandidates({ id: 'o', displayName: 'Jan de Vries' }, indexes, opts);
    expect([...got.keys()].sort()).toEqual(['plain', 'titled']);
  });

  it('does not gather a different family that shares the particle tail', () => {
    const indexes = indexIdentities([
      { id: 'schilder', displayName: 'Lisa Schilder-van der Steen', givenName: 'Lisa', surname: 'Schilder-van der Steen' },
    ]);
    expect(collectCandidates({ id: 'o', displayName: 'Lisa van der Steen' }, indexes, opts).size).toBe(0);
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

// ── Birth surname vs name in use (#1439) ─────────────────────────────────────
//
// A person is indexed under every name they are known by, so the candidate set
// and the tie both have to work per name rather than per person: the HR record
// holds the birth surname, the accounts carry the name in use, and a namesake on
// one of those names must not decide what happens to the other.

describe('collectCandidates - both of a person’s names find her', () => {
  const opts = { prefixes: prefixesFrom(DEFAULT_RULES), suffixes: suffixesFrom(DEFAULT_RULES) };
  // Born "de Wit", known as "Bakker-de Wit"; HR writes the birth name in the column.
  const owner = { id: 'owner', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' };
  const indexes = indexIdentities([owner]);

  it('finds her from an account spelled with the NAME IN USE', () => {
    // Indexing her under the column alone is the regression: this account — the
    // one the directory actually holds — matches nothing and stays orphaned.
    expect([...collectCandidates({ id: 'o', displayName: 'Anna Bakker-de Wit' }, indexes, opts).keys()])
      .toEqual(['owner']);
  });

  it('finds her from an account spelled with the BIRTH surname', () => {
    expect([...collectCandidates({ id: 'o', displayName: 'Anna de Wit' }, indexes, opts).keys()])
      .toEqual(['owner']);
  });

  it('does not find her from a name she is not known by at all', () => {
    expect(collectCandidates({ id: 'o', displayName: 'Anna Bakker' }, indexes, opts).size).toBe(0);
  });
});

describe('resolveNameTie', () => {
  // The owner is known by two names; a different person shares only her birth name.
  const owner = { id: 'owner', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' };
  const stranger = { id: 'stranger', displayName: 'Anna de Wit', givenName: 'Anna', surname: 'de Wit' };
  const { byNameKey } = indexIdentities([owner, stranger]);
  // An HR-provisioned account carries both spellings, so it matches both people.
  const orphan = { id: 'o', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' };
  const onOwner = { identityId: 'owner', confidence: 60, signals: ['fullName'] };
  const onStranger = { identityId: 'stranger', confidence: 60, signals: ['fullName'] };

  it('picks the identity that is the SOLE match on one of the account’s names', () => {
    // Read across the whole candidate set this is a 2-way tie and the account
    // goes to review, even though only one person is called "Bakker-de Wit".
    expect(resolveNameTie(orphan, [onOwner, onStranger], byNameKey)).toBe(onOwner);
  });

  it('picks the same winner whichever order the candidates were scored in', () => {
    // pickBest keeps the FIRST top-scoring candidate, which is index order and
    // says nothing about who the account belongs to. Resolved from `best` alone
    // the outcome would flip with the order identities happen to arrive in.
    expect(resolveNameTie(orphan, [onStranger, onOwner], byNameKey)).toBe(onOwner);
  });

  it('declines when the account only carries the name the two people share', () => {
    // The guard that has to survive per-name resolution: this account really
    // could be either person's, so there is nothing to pick.
    const shared = { id: 'o2', displayName: 'Anna de Wit' };
    expect(resolveNameTie(shared, [onOwner, onStranger], byNameKey)).toBeNull();
  });

  it('declines when different names single out different people', () => {
    // Her birth name points at the stranger, her name in use at the owner: two
    // sole matches, no answer. Taking the first key's winner would hand the
    // account to whichever name happened to be parsed first.
    const otherOwner = { id: 'owner', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'Jansen' };
    const ix = indexIdentities([otherOwner, stranger]);
    expect(resolveNameTie(orphan, [onOwner, onStranger], ix.byNameKey)).toBeNull();
  });

  it('declines for an account with no name at all', () => {
    // Two identities tied on a strong signal and nothing to tell them apart by
    // name — the engine only asks this for name-only matches, but a 'yes' here
    // would be a guess.
    expect(resolveNameTie({ id: 'o3', employeeId: 'E1' }, [onOwner, onStranger], byNameKey)).toBeNull();
  });

  it('tolerates one of the account’s names matching no identity at all', () => {
    // Half-populated sources are ordinary: this account's surname column names a
    // family nobody in the tenant has, so that key's bucket is missing entirely.
    // Read as a one-element bucket it would invent a winner out of nothing.
    const half = { id: 'o4', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'Jansen' };
    expect(resolveNameTie(half, [onOwner, onStranger], byNameKey)).toBe(onOwner);
  });

  it('weighs only the candidates it was handed', () => {
    // The buckets hold every identity under a name, not just the tied ones. Left
    // unfiltered, the owner would count as a second match under the birth name
    // and the stranger's own unique claim to it would disappear.
    expect(resolveNameTie(orphan, [onStranger], byNameKey)).toBe(onStranger);
  });
});
