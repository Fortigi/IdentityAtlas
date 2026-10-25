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
  nameKeyVariants,
  nameInitialVariants,
  prefixesFrom,
  suffixesFrom,
  loginPrefixesFrom,
  strongestNameRung,
  nameSignalNames,
  nameSignalLevels,
  matchLevelOf,
  isNameOnly,
  parseLinkSignals,
  indexIdentities,
  collectCandidates,
  nameClaim,
  sharedAtWeakerLevel,
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
  it('indexes by employeeId, email-local, name, name-key and surname+initial', () => {
    const idy = { id: 'i1', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };
    const { byEmployeeId, byEmailLocal, byName, byNameKey, bySurnameInitial } = indexIdentities([idy]);
    expect(byEmployeeId.get('e1')).toEqual([idy]);
    expect(byEmailLocal.get('jdoe')).toEqual([idy]);
    expect(byName.get('doejohn')).toEqual([idy]);
    expect(byNameKey.get(nameKeys(idy)[0])).toEqual([idy]);
    expect(bySurnameInitial.get('doe|j')).toEqual([idy]);
  });

  it('groups two near-identical names under one surname+initial key', () => {
    // 'doe|j' is what lets the guard see Johanna standing behind an account named
    // after John. Keyed per full name instead, the two never meet.
    const john = { id: 'john', displayName: 'John Doe' };
    const johanna = { id: 'johanna', displayName: 'Johanna Doe' };
    const { bySurnameInitial, byNameKey } = indexIdentities([john, johanna]);
    expect(bySurnameInitial.get('doe|j')).toEqual([john, johanna]);
    expect(byNameKey.get('doe|john')).toEqual([john]);
  });

  it('indexes no surname+initial key for a name that cannot match', () => {
    // A bare surname never fires a name signal, so it must not fill a bucket
    // either -- every surname-less person would otherwise claim every other.
    const { bySurnameInitial } = indexIdentities([
      { id: 'sur', displayName: 'Jansen' },
      { id: 'given', givenName: 'Anna' },
    ]);
    expect(bySurnameInitial.size).toBe(0);
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
    // 'f' is the fuzzy signal: the legacy single-signal name comparison, which is a name
    // match by definition. Leaving it out would let a fuzzy-only match read as corroborated
    // and link to a namesake unguarded -- the exact case the guard exists for.
    expect([...nameSignalNames(rules)].sort()).toEqual(['displayName', 'f', 'fullName']);
    expect(nameSignalNames({ signals: [{ type: 'exact', name: 'email' }] }).size).toBe(0);
  });
});

// ── Which level a name signal fires at ───────────────────────────────────────
//
// The held-for-review card explains an ambiguous hold by naming what the rivals share,
// and that is a different name at each level. The level comes off the signal that fired.

describe('nameSignalLevels / matchLevelOf', () => {
  const rules = {
    signals: [
      { type: 'exact', name: 'email', field: 'email' },
      { type: 'name',  name: 'fullName',       level: 'full' },
      { type: 'name',  name: 'surnameInitial', level: 'surnameInitial' },
      { type: 'fuzzy', name: 'legacyName' },
    ],
  };
  const levels = nameSignalLevels(rules);

  it('maps each name signal to the level it fires at, and skips the rest', () => {
    expect(Object.fromEntries(levels)).toEqual({
      fullName: 'full', surnameInitial: 'surnameInitial', legacyName: 'full',
    });
  });

  it('calls the legacy fuzzy signal a full-name match', () => {
    // It compares whole names, so a hold resting on it has rivals spelled the account's
    // name -- reading it as a surname+initial hold would describe the hold wrongly.
    expect(levels.get('legacyName')).toBe('full');
  });

  it('reads the level off the name signal among the ones that fired', () => {
    // A match can fire a non-name signal alongside (an above-threshold name-only match is
    // the guard's subject, but the level is a property of the name evidence either way).
    expect(matchLevelOf(['surnameInitial'], levels)).toBe('surnameInitial');
    expect(matchLevelOf(['email', 'fullName'], levels)).toBe('full');
  });

  it('reports no level for a match that fired no name signal at all', () => {
    expect(matchLevelOf(['email'], levels)).toBeNull();
    expect(matchLevelOf([], levels)).toBeNull();
  });
});

// ── A rival one level down (#1460) ───────────────────────────────────────────
//
// What the level-scoped claim deliberately ignores, and what a run counts so the
// one-off re-link of that whole class on upgrade is visible instead of silent.

describe('sharedAtWeakerLevel', () => {
  const youssef = { id: 'youssef', displayName: 'Youssef El Mahdi' };
  const yasmina = { id: 'yasmina', displayName: 'Yasmina El Mahdi' };

  it('is true when somebody shares the surname and initial of a name spelled by one person', () => {
    expect(sharedAtWeakerLevel({ id: 'o', displayName: 'Youssef El Mahdi' },
      indexIdentities([youssef, yasmina]))).toBe(true);
  });

  it('is false when the only other claimant is spelled the name too', () => {
    // A rival at the SAME level is not one level down -- that match is still held, so
    // counting it as restored would report a re-link that did not happen.
    const twin = { id: 'twin', displayName: 'Youssef El Mahdi' };
    expect(sharedAtWeakerLevel({ id: 'o', displayName: 'Youssef El Mahdi' },
      indexIdentities([youssef, twin]))).toBe(false);
  });

  it('is false when nobody is spelled the name, so the claim already rests at that level', () => {
    expect(sharedAtWeakerLevel({ id: 'o', displayName: 'Youri El Mahdi' },
      indexIdentities([youssef, yasmina]))).toBe(false);
  });

  it('is false for a name nobody is anywhere near', () => {
    expect(sharedAtWeakerLevel({ id: 'o', displayName: 'Youssef El Mahdi' },
      indexIdentities([youssef]))).toBe(false);
  });

  it('ignores a name that could never fire a name signal', () => {
    // A single-token display name parses to a bare surname with no initial key, so it has
    // no weaker level to be shared at -- counted, every surname-less account would report
    // as restored.
    expect(sharedAtWeakerLevel({ id: 'o', displayName: 'Mahdi' },
      indexIdentities([youssef, yasmina, { id: 'bare', displayName: 'Mahdi' }]))).toBe(false);
  });
});

// ── isNameOnly / parseLinkSignals ────────────────────────────────────────────
//
// The two predicates behind the name-only guard. isNameOnly decides whether a match is
// subject to it at all; parseLinkSignals reads the signals back off a stored member row so
// the retroactive cleanup can recognise the links the guard would no longer make.

describe('isNameOnly', () => {
  const nameSigs = new Set(['fullName', 'surnameInitial']);

  it('is true when every fired signal is a name signal', () => {
    expect(isNameOnly(['fullName'], nameSigs)).toBe(true);
    expect(isNameOnly(['fullName', 'surnameInitial'], nameSigs)).toBe(true);
  });

  it('is false as soon as one signal is not a name signal', () => {
    expect(isNameOnly(['fullName', 'email'], nameSigs)).toBe(false);
    expect(isNameOnly(['employeeId'], nameSigs)).toBe(false);
  });

  it('is false for a match that fired nothing at all', () => {
    // `signals.length > 0 &&` -- without it, [].every() is vacuously true and a match
    // that matched NOTHING would be classified as name-only.
    expect(isNameOnly([], nameSigs)).toBe(false);
  });
});

describe('parseLinkSignals', () => {
  it('reads the CSV node-postgres hands back from the JSONB string', () => {
    // The column holds a JSON *string* of CSV, so the driver returns the bare CSV --
    // which is not itself valid JSON. Mis-handling this returns [], the cleanup then
    // recognises nothing, and every pre-existing name-only link stays attached.
    expect(parseLinkSignals('fullName')).toEqual(['fullName']);
    expect(parseLinkSignals('email,fullName')).toEqual(['email', 'fullName']);
    expect(parseLinkSignals('email, fullName ')).toEqual(['email', 'fullName']);
  });

  it('reads a double-encoded legacy value', () => {
    expect(parseLinkSignals('"fullName"')).toEqual(['fullName']);
  });

  it('reads an array, however it was stored', () => {
    expect(parseLinkSignals(['email', 'fullName'])).toEqual(['email', 'fullName']);
    expect(parseLinkSignals('["email","fullName"]')).toEqual(['email', 'fullName']);
  });

  it('returns an empty list for nothing recorded', () => {
    expect(parseLinkSignals(null)).toEqual([]);
    expect(parseLinkSignals(undefined)).toEqual([]);
    expect(parseLinkSignals('')).toEqual([]);
    expect(parseLinkSignals(',, ,')).toEqual([]);
    expect(parseLinkSignals(42)).toEqual([]);
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

describe('nameClaim', () => {
  // The owner is known by two names; a different person shares only her birth name.
  const owner = { id: 'owner', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' };
  const stranger = { id: 'stranger', displayName: 'Anna de Wit', givenName: 'Anna', surname: 'de Wit' };
  const indexes = indexIdentities([owner, stranger]);
  // An HR-provisioned account carries both spellings, so it matches both people.
  const orphan = { id: 'o', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' };

  it('points at the identity that is the SOLE claimant of one of the account’s names', () => {
    // Read as one question across both names this is a 2-way tie and the account
    // goes to review, even though only one person is called "Bakker-de Wit".
    expect(nameClaim(orphan, indexes).sole).toBe(owner);
  });

  it('lists everyone the name could belong to, whoever it points at', () => {
    // The rival list is what makes a held-back match reviewable, and it is also
    // what the analyst needs when the name DOES point at someone.
    expect(nameClaim(orphan, indexes).claimants).toEqual([owner, stranger]);
  });

  it('points at the same identity whichever order they were indexed in', () => {
    // Nothing about who an account belongs to may depend on index order.
    expect(nameClaim(orphan, indexIdentities([stranger, owner])).sole).toBe(owner);
  });

  it('gives the shared name to the person who is actually called it', () => {
    // This account is spelled with the name the stranger goes by and the owner
    // only *was* born with. Counting the two claims as equal sends it to review;
    // it belongs to the person the directory would have named it after.
    expect(nameClaim({ id: 'o2', displayName: 'Anna de Wit' }, indexes).sole).toBe(stranger);
  });

  it('points at nobody when different names single out different people', () => {
    // Her birth name points at the stranger, her name in use at the owner: two
    // sole claimants, no answer. Taking the first key's winner would hand the
    // account to whichever name happened to be parsed first.
    const otherOwner = { id: 'owner', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'Jansen' };
    expect(nameClaim(orphan, indexIdentities([otherOwner, stranger])).sole).toBeNull();
  });

  it('points at nobody for an account with no name at all', () => {
    const claim = nameClaim({ id: 'o3', employeeId: 'E1' }, indexes);
    expect(claim.sole).toBeNull();
    expect(claim.claimants).toEqual([]);
  });

  it('tolerates one of the account’s names matching no identity at all', () => {
    // Half-populated sources are ordinary: this account's surname column names a
    // family nobody in the tenant has, so that key's bucket is missing entirely.
    // Read as a one-element bucket it would invent a claimant out of nothing.
    const half = { id: 'o4', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'Jansen' };
    expect(nameClaim(half, indexes).sole).toBe(owner);
  });

  it('ignores a name that could never fire a name signal', () => {
    // A single-token display name parses to a bare surname. It matches nobody by
    // design, so it must claim nobody either -- counted, every surname-less
    // person in the tenant would be a rival for this account.
    const surnameOnly = { id: 'o5', displayName: 'Jansen' };
    expect(nameClaim(surnameOnly, indexIdentities([owner, stranger, { id: 'bare', displayName: 'Jansen' }])))
      .toEqual({ sole: null, claimants: [] });
  });
});

// ── A near-identical name is a rival where nobody is spelled it (#1440) ──────
//
// The tie between top-scoring candidates cannot see the case that actually went
// wrong: the real owner is spelled a little differently, so she scores BELOW the
// candidate who matches cleanly and never ties with her. Reading the surname +
// given initial level is what makes her visible -- and #1460 scoped that reading
// to the names nobody is spelled exactly, where it is the only reading there is.

describe('nameClaim - a namesake behind a near-identical spelling (#1440)', () => {
  const jan = { id: 'jan', displayName: 'Jan Jansen' };
  const johannes = { id: 'johannes', displayName: 'Johannes Jansen' };
  const account = { id: 'o', displayName: 'Jan Jansen' };

  it('points at the exact match even when a second person shares the initial', () => {
    // "Jan Jansen" is an exact match for one of them and a plausible spelling of
    // the other -- but only one of them is called it, and that settles it (#1460).
    const claim = nameClaim(account, indexIdentities([jan, johannes]));
    expect(claim.sole).toBe(jan);
    expect(claim.claimants).toEqual([jan]);
  });

  it('points at the exact match when the tenant holds nobody near it', () => {
    // The paired case, and the common one: a source carrying nothing but display
    // names (a badge system, many ERPs) links on exactly this.
    expect(nameClaim(account, indexIdentities([jan])).sole).toBe(jan);
  });

  it('is not blocked by a different given initial', () => {
    // 'Sara' is not a spelling of 'Jan'. Treating any shared surname as a rival
    // would stop a display-name-only source linking anything at all.
    const sara = { id: 'sara', displayName: 'Sara Jansen' };
    expect(nameClaim(account, indexIdentities([jan, sara])).sole).toBe(jan);
  });

  it('is not blocked by a rival who only CARRIES the name as a birth surname', () => {
    // She goes by de Boer-Jansen; her HR record still says Jansen. The account is
    // spelled with the name in use, so it is the other one's -- at both levels.
    const deBoer = { id: 'deboer', displayName: 'Anna de Boer-Jansen', givenName: 'Anna', surname: 'Jansen' };
    const anna = { id: 'anna', displayName: 'Anna Jansen', givenName: 'Anna', surname: 'Jansen' };
    expect(nameClaim({ id: 'o2', displayName: 'Anna Jansen' }, indexIdentities([anna, deBoer])).sole).toBe(anna);
  });

  it('points at nobody when the near-identical rival is the only exact match too', () => {
    // Her own account, spelled the way the directory has her, against a tenant
    // holding only the other spelling: an above-threshold full-name match never
    // happens here, so the claim is what decides, and it declines.
    const claim = nameClaim({ id: 'o3', displayName: 'Johan Jansen' }, indexIdentities([jan, johannes]));
    expect(claim.sole).toBeNull();
    expect(claim.claimants).toEqual([jan, johannes]);
  });
});

// ── The name in use outranks a birth surname under one key (#1439) ───────────
//
// Indexing the birth-name variant puts a second person under a key that used to
// hold one, which turns matches that were unique into ties and sends accounts to
// review that were linked correctly before. Those two claims to the key are not
// equal: accounts are provisioned from the name in use, so the person actually
// called that wins and the one who only carries it in an HR column does not
// block her. Two claims of the SAME kind still tie.

describe('nameClaim - name in use vs birth surname under one key (#1439)', () => {
  // Called Jansen, and her accounts say so.
  const jansen = { id: 'jansen', displayName: 'Anna Jansen', givenName: 'Anna', surname: 'Jansen' };
  // A different person, known as "de Boer-Jansen"; HR still holds "Jansen" as
  // her birth surname, so she is indexed under 'jansen|anna' too.
  const deBoer = { id: 'deboer', displayName: 'Anna de Boer-Jansen', givenName: 'Anna', surname: 'Jansen' };
  // A directory account with nothing but the name, which is the whole case.
  const account = { id: 'o', displayName: 'Anna Jansen' };

  it('points at the identity whose NAME IN USE the account carries', () => {
    expect(nameClaim(account, indexIdentities([jansen, deBoer])).sole).toBe(jansen);
  });

  it('points there whichever order the two were indexed in', () => {
    expect(nameClaim(account, indexIdentities([deBoer, jansen])).sole).toBe(jansen);
  });

  it('still declines when both people are really called that', () => {
    // Two claims of the same kind, which is the namesake case the guard exists
    // for: preferring the name in use must not reduce to "pick the first one".
    const twin = { id: 'twin', displayName: 'Anna Jansen', givenName: 'Anna', surname: 'Jansen' };
    expect(nameClaim(account, indexIdentities([jansen, twin])).sole).toBeNull();
  });

  it('still declines when the name is a birth surname for BOTH of them', () => {
    // Neither is called Jansen any more, so neither has the stronger claim and
    // this old-name account could be either one's.
    const a = { id: 'a', displayName: 'Anna Bakker-Jansen', givenName: 'Anna', surname: 'Jansen' };
    const b = { id: 'b', displayName: 'Anna de Boer-Jansen', givenName: 'Anna', surname: 'Jansen' };
    expect(nameClaim(account, indexIdentities([a, b])).sole).toBeNull();
  });

  it('keeps a lone birth-name claim as a claim', () => {
    // This account says "Jansen" in the directory and "de Wit" in its HR column.
    // One person was born Jansen, another goes by de Wit: each is the only
    // claimant of one of the two names, which contradict, so it goes to review.
    // Dropping the unranked claim instead would silently hand it to de Wit.
    const twoNames = { id: 'o3', displayName: 'Anna Jansen', givenName: 'Anna', surname: 'de Wit' };
    const bornJansen = { id: 'born', displayName: 'Anna Bakker-Jansen', givenName: 'Anna', surname: 'Jansen' };
    const deWit = { id: 'dewit', displayName: 'Anna de Wit', givenName: 'Anna', surname: 'de Wit' };
    expect(nameClaim(twoNames, indexIdentities([bornJansen, deWit])).sole).toBeNull();
  });

  it('does not rank the claims when the ACCOUNT itself only carries a birth surname', () => {
    // The account is spelled "de Boer-Jansen" in the directory and "Jansen" in
    // its HR column, so the column key is an old name on both sides and ranking
    // it would hand the account to a stranger over its own name in use.
    const fromHr = { id: 'o2', displayName: 'Anna de Boer-Jansen', givenName: 'Anna', surname: 'Jansen' };
    expect(nameClaim(fromHr, indexIdentities([jansen, deBoer])).sole).toBe(deBoer);
  });
});

// ── Rivalry is scoped to the matched level (#1460) ───────────────────────────
//
// A claim is weighed at the level the name's own evidence rests on. Read across
// both levels at once, every identity sharing a surname and first initial votes
// against a spelling only one of them answers to: "Youssef El Mahdi" is held
// because Yasmina and Yassin exist, though neither is called that. The exact
// level therefore decides whenever anybody is spelled the name, and the initial
// level only steps in when nobody is — which is the level an account that shows
// no full name (#1455) rests on, and where the near-identical rival of #1440 is
// still counted.

describe('nameClaim - rivalry is scoped to the level the name matches at (#1460)', () => {
  const youssef = { id: 'youssef', displayName: 'Youssef El Mahdi' };
  const yasmina = { id: 'yasmina', displayName: 'Yasmina El Mahdi' };
  const yassin = { id: 'yassin', displayName: 'Yassin El Mahdi' };
  const account = { id: 'o', displayName: 'Youssef El Mahdi' };

  it('points at the one person spelled exactly this name, despite initial-level rivals', () => {
    expect(nameClaim(account, indexIdentities([youssef, yasmina, yassin])).sole).toBe(youssef);
  });

  it('names only the matched level’s rivals as claimants', () => {
    // The claimant list is what a held match shows the analyst as "who else
    // answers to this name". Yasmina and Yassin do not answer to it, so listing
    // them describes the hold wrongly as well as causing it.
    expect(nameClaim(account, indexIdentities([youssef, yasmina, yassin])).claimants).toEqual([youssef]);
  });

  it('points at nobody when a second person is spelled exactly the same', () => {
    // Two real namesakes tie at the exact level, which is the case the guard
    // exists for: scoping rivalry to the matched level must not reduce to
    // "whoever matches best wins".
    const twin = { id: 'twin', displayName: 'Youssef El Mahdi' };
    const claim = nameClaim(account, indexIdentities([youssef, twin, yasmina]));
    expect(claim.sole).toBeNull();
    expect(claim.claimants).toEqual([youssef, twin]);
  });

  it('points at nobody when the namesake’s spelling differs only by a title', () => {
    // #1443's measured wrong-link class: a title is stripped before keying, so
    // "drs. Youssef El Mahdi" is the same name and shares the exact key.
    const titled = { id: 'titled', displayName: 'drs. Youssef El Mahdi' };
    expect(nameClaim(account, indexIdentities([youssef, titled])).sole).toBeNull();
  });

  it('weighs a name nobody is spelled exactly at the initial level instead', () => {
    // "Youri" is nobody's name here, so this account's evidence sits at the
    // initial level — where two people stand, and it still points at neither.
    const claim = nameClaim({ id: 'o2', displayName: 'Youri El Mahdi' }, indexIdentities([youssef, yassin]));
    expect(claim.sole).toBeNull();
    expect(claim.claimants).toEqual([youssef, yassin]);
  });

  it('points at the only person sharing the surname and initial when nobody is spelled it', () => {
    // The paired case, and what #1455 rests on: the initial level is load-bearing
    // precisely where the exact level has nothing to say.
    expect(nameClaim({ id: 'o3', displayName: 'Youri El Mahdi' }, indexIdentities([youssef])).sole).toBe(youssef);
  });
});

describe('nameKeyVariants', () => {
  it('says which of the person’s names each index key is', () => {
    expect([...nameKeyVariants({ displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' })])
      .toEqual([['anna|dewit', 'birth'], ['anna|bakkerdewit', 'inUse']]);
  });

  it('reads a column the display name agrees with as the name in use', () => {
    expect([...nameKeyVariants({ displayName: 'Anna de Wit', givenName: 'Anna', surname: 'de Wit' })])
      .toEqual([['anna|dewit', 'inUse']]);
  });

  it('reads the columns as the name in use when there is no display name', () => {
    // Nothing contradicts them, so they are the only name she is known by —
    // read as a birth name she would lose every tie to anyone else.
    expect([...nameKeyVariants({ givenName: 'Anna', surname: 'de Wit' })])
      .toEqual([['anna|dewit', 'inUse']]);
  });

  it('keeps the stronger variant when two of her names collapse onto one key', () => {
    // "Bakker Anna" is the reversed pair: the key sorts its halves, so the
    // display name and the column produce the same one. Read from the column
    // half alone that key looks like a birth name, and she would lose a tie
    // under the name she is plainly called by.
    expect([...nameKeyVariants({ displayName: 'Bakker Anna', givenName: 'Anna', surname: 'Bakker' })])
      .toEqual([['anna|bakker', 'inUse']]);
  });
});

describe('nameInitialVariants', () => {
  it('keys a name by surname + given initial, and says which name it is', () => {
    expect([...nameInitialVariants({ displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' })])
      .toEqual([['dewit|a', 'birth'], ['bakkerdewit|a', 'inUse']]);
  });

  it('keys two given names sharing an initial onto one key, keeping the stronger', () => {
    // 'Anna' in the column and 'Annemarie' in the display name are the same key
    // at this level. Read from the column half alone it would look like a birth
    // name and she would lose the key she is plainly called by.
    expect([...nameInitialVariants({ displayName: 'Annemarie Bakker', givenName: 'Anna', surname: 'Bakker' })])
      .toEqual([['bakker|a', 'inUse']]);
  });

  it('keys nothing for a name that has no surname or no given name', () => {
    expect(nameInitialVariants({ displayName: 'Jansen' }).size).toBe(0);
    expect(nameInitialVariants({ givenName: 'Anna' }).size).toBe(0);
    expect(nameInitialVariants({}).size).toBe(0);
  });
});

// ── Reading the account's LOGIN as one of its names (#1454) ──────────────────
//
// An admin login carries its owner's name in whatever form the provisioning
// convention writes it, and the dictionary's only login-reading rule demanded the
// prefix-stripped login equal the owner's address exactly. On the reporting tenant
// that recognised one convention: 30 of 64 admin accounts linked, every one of them
// on its display name, none on its login. The helpers below are what make the login
// a name the engine indexes, scores and weighs rivals on, like any other.

describe('loginPrefixesFrom', () => {
  it('reads the prefixes off the login signals, not off the address rule', () => {
    // The two rules are independent: a tenant may strip 'adm-' for one and not the
    // other. Taken from the prefix rule, a dictionary that drops it stops stripping
    // logins too and every admin account silently stops matching.
    const rules = {
      signals: [
        { type: 'prefix', name: 'emailPrefix', stripPrefixes: ['x-'] },
        { type: 'loginName', name: 'loginNameForm', stripPrefixes: ['adm-', 'a-'] },
      ],
    };
    expect(loginPrefixesFrom(rules)).toEqual(['adm-', 'a-']);
    expect(prefixesFrom(rules)).toEqual(['x-']);
  });

  it('is empty for a dictionary with no login rule at all', () => {
    expect(loginPrefixesFrom({ signals: [{ type: 'prefix', stripPrefixes: ['adm-'] }] })).toEqual([]);
    expect(loginPrefixesFrom({})).toEqual([]);
  });

  it('collects the prefixes of every login rule', () => {
    expect(loginPrefixesFrom({
      signals: [
        { type: 'loginName', stripPrefixes: ['adm-'] },
        { type: 'loginName', stripPrefixes: ['ext-'] },
        { type: 'loginName' },
      ],
    })).toEqual(['adm-', 'ext-']);
  });
});

describe('nameSignalLevels - the login rung', () => {
  const levels = nameSignalLevels(DEFAULT_RULES);

  it('counts the login signal as a name signal with a level of its own', () => {
    // Name-class is what routes it through the uniqueness guard and the retroactive
    // cleanup; left out, an admin login would auto-link to whoever it half fits.
    expect(nameSignalNames(DEFAULT_RULES).has('loginNameForm')).toBe(true);
    expect(levels.get('loginNameForm')).toBe('loginName');
    // ...and it is NOT reported as a full-name or surname+initial hold: the rivals of
    // such a match share a login form, not a spelled-out name, and the card's wording
    // for those two would send the analyst after a namesake who does not exist.
    expect(matchLevelOf(['loginNameForm'], levels)).toBe('loginName');
  });

  it('still maps the parsed-name signals to their own levels', () => {
    expect(levels.get('fullName')).toBe('full');
    expect(levels.get('surnameInitial')).toBe('surnameInitial');
    expect(levels.get('email')).toBeUndefined();
  });
});

describe('strongestNameRung', () => {
  const fay = {
    id: 'fay', displayName: 'Fay Hogenbirk', givenName: 'Fay', surname: 'Hogenbirk',
    email: 'f.h.hogenbirk@fortigidemo.com',
  };

  it('fires the login rung when the account’s own name says nothing', () => {
    // The reported case: the display name is an asset tag, so the login is the only
    // evidence there is.
    expect(strongestNameRung(
      { displayName: 'Admin account 042', email: 'adm-fhogenbirk@fortigidemo.com' }, fay, DEFAULT_RULES,
    )).toBe('loginName');
  });

  it('fires the heavier parsed-name rung instead of stacking the two', () => {
    // Her display name AND her login spell her, which is one name read twice. Summed,
    // 60 + 55 caps at 100 — the confidence of an exact employeeId match — for evidence
    // a namesake's account carries just as well.
    expect(strongestNameRung(
      { displayName: 'Hogenbirk, Fay', email: 'adm-fayhogenbirk@fortigidemo.com' }, fay, DEFAULT_RULES,
    )).toBe('full');
  });

  it('prefers the login rung over the lighter surname+initial one', () => {
    // 'F. Hogenbirk' is a 45-weight read of the name and the login is a 55-weight one,
    // so the ladder has to rank by weight rather than by which field it came from:
    // reporting 'surnameInitial' here leaves the account under the threshold.
    expect(strongestNameRung(
      { displayName: 'F. Hogenbirk', email: 'adm-fayhogenbirk@fortigidemo.com' }, fay, DEFAULT_RULES,
    )).toBe('loginName');
  });

  it('reorders with the dictionary rather than hard-coding the order', () => {
    // A tenant that makes the login the lighter signal gets the lighter answer.
    const reweighted = {
      signals: DEFAULT_RULES.signals.map(s => (s.type === 'loginName' ? { ...s, weight: 20 } : s)),
    };
    expect(strongestNameRung(
      { displayName: 'F. Hogenbirk', email: 'adm-fayhogenbirk@fortigidemo.com' }, fay, reweighted,
    )).toBe('surnameInitial');
  });

  it('is null when neither the name nor the login says anything', () => {
    expect(strongestNameRung(
      { displayName: 'Admin account 042', email: 'adm-jjansen@fortigidemo.com' }, fay, DEFAULT_RULES,
    )).toBeNull();
    expect(strongestNameRung({ displayName: 'Admin account 042' }, fay, DEFAULT_RULES)).toBeNull();
  });

  it('tolerates a dictionary with no signals and an under-specified login rule', () => {
    // A rule with no stripPrefixes and no weight is still a rule: it reads the login
    // raw (no prefix to strip) and contributes nothing to the ladder's ranking, rather
    // than throwing in the middle of a run over every orphan on the tenant.
    expect(strongestNameRung({ displayName: 'Admin account 042' }, fay, {})).toBeNull();
    expect(strongestNameRung(
      { displayName: 'Admin account 042', email: 'fhogenbirk@fortigidemo.com' },
      fay,
      { signals: [{ type: 'loginName', name: 'bare', field: 'email' }] },
    )).toBe('loginName');
  });

  it('reads no login at all for a dictionary without a login rule', () => {
    const noLogin = { signals: DEFAULT_RULES.signals.filter(s => s.type !== 'loginName') };
    expect(strongestNameRung(
      { displayName: 'Admin account 042', email: 'adm-fhogenbirk@fortigidemo.com' }, fay, noLogin,
    )).toBeNull();
  });
});

describe('indexIdentities / collectCandidates - the login indexes', () => {
  const opts = {
    prefixes: prefixesFrom(DEFAULT_RULES),
    suffixes: suffixesFrom(DEFAULT_RULES),
    loginPrefixes: loginPrefixesFrom(DEFAULT_RULES),
  };
  const fay = {
    id: 'fay', displayName: 'Fay Hogenbirk', givenName: 'Fay', surname: 'Hogenbirk',
    email: 'f.h.hogenbirk@fortigidemo.com',
  };

  it('indexes a person under both of her login forms', () => {
    const { byLoginFull, byLoginInitial } = indexIdentities([fay]);
    expect(byLoginFull.get('fayhogenbirk')).toEqual([fay]);
    expect(byLoginInitial.get('fhogenbirk')).toEqual([fay]);
  });

  it('gathers her as a candidate for an admin login nothing else would reach', () => {
    // Scoring alone cannot fix this: an orphan that reaches no candidate is never
    // compared to anyone, and stays unlinked with no error anywhere.
    const orphan = { id: 'o', displayName: 'Admin account 042', email: 'adm-fhogenbirk@fortigidemo.com' };
    expect([...collectCandidates(orphan, indexIdentities([fay]), opts).keys()]).toEqual(['fay']);
  });

  it('gathers nobody when the login names a surname that is not hers', () => {
    const orphan = { id: 'o', displayName: 'Admin account 042', email: 'adm-fhogenberg@fortigidemo.com' };
    expect(collectCandidates(orphan, indexIdentities([fay]), opts).size).toBe(0);
  });

  it('does not read the login when the rules strip no login prefixes', () => {
    // `loginPrefixes` is the rules' decision that a login is evidence at all; without
    // it the token keeps the prefix ('admfhogenbirk') and matches no form.
    const orphan = { id: 'o', displayName: 'Admin account 042', email: 'adm-fhogenbirk@fortigidemo.com' };
    expect(collectCandidates(orphan, indexIdentities([fay]), {
      prefixes: [], suffixes: [], loginPrefixes: [],
    }).size).toBe(0);
  });
});

describe('nameClaim - the login is one of the account’s names', () => {
  const opts = { loginPrefixes: loginPrefixesFrom(DEFAULT_RULES) };
  const fay = {
    id: 'fay', displayName: 'Fay Hogenbirk', givenName: 'Fay', surname: 'Hogenbirk',
    email: 'f.h.hogenbirk@fortigidemo.com',
  };
  const petra = { id: 'petra', displayName: 'Petra Munck', givenName: 'Petra', surname: 'Munck', email: 'petra.munck@x.com' };
  const pieter = { id: 'pieter', displayName: 'Pieter Munck', givenName: 'Pieter', surname: 'Munck', email: 'pieter.munck@x.com' };

  it('singles out the person an admin login points at', () => {
    const orphan = { id: 'o', displayName: 'Admin account 042', email: 'adm-fhogenbirk@fortigidemo.com' };
    expect(nameClaim(orphan, indexIdentities([fay, petra]), opts).sole).toBe(fay);
  });

  it('singles out nobody when the login form fits two people', () => {
    // Initial + surname drops the particle and every given name but its first letter,
    // so 'adm-pmunck' answers for both. The wrong one would inherit the other's access
    // review, risk score and leaver handling.
    const orphan = { id: 'o', displayName: 'Admin account 043', email: 'adm-pmunck@fortigidemo.com' };
    const claim = nameClaim(orphan, indexIdentities([petra, pieter]), opts);
    expect(claim.sole).toBeNull();
    expect(claim.claimants.map(c => c.id).sort()).toEqual(['petra', 'pieter']);
  });

  it('reads the login at one level, so a whole-name form outranks an initial one', () => {
    // 'jhogenbirk' writes Jan Hogenbirk's whole name and only the initial of
    // J. Hogenbirk-de Wit's. Read at both levels at once, neither could be placed —
    // the cross-level reading #1460 removed for parsed names.
    const jan = { id: 'jan', displayName: 'J Hogenbirk', givenName: 'J', surname: 'Hogenbirk' };
    const jolanda = { id: 'jolanda', displayName: 'Jolanda Hogenbirk-de Wit', givenName: 'Jolanda', surname: 'Hogenbirk-de Wit' };
    const orphan = { id: 'o', displayName: 'Admin account 044', email: 'adm-jhogenbirk@fortigidemo.com' };
    expect(nameClaim(orphan, indexIdentities([jan, jolanda]), opts).sole).toBe(jan);
  });

  it('gives the name in use the stronger claim to a login form', () => {
    // Her HR record still carries 'de Wit' in its surname column, so 'adewit' is a form
    // of a name she only had. The account belongs to the woman actually called de Wit.
    const inUse = { id: 'anna-dewit', displayName: 'Anna de Wit', givenName: 'Anna', surname: 'de Wit' };
    const birth = { id: 'anna-bakker', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit' };
    const orphan = { id: 'o', displayName: 'Admin account 045', email: 'adm-adewit@fortigidemo.com' };
    expect(nameClaim(orphan, indexIdentities([inUse, birth]), opts).sole).toBe(inUse);
  });

  it('points at nobody when the display name and the login disagree', () => {
    // Two names singling out two different people say nothing about which of them the
    // account belongs to — the same reading the parsed names get.
    const orphan = { id: 'o', displayName: 'Petra Munck', email: 'adm-fhogenbirk@fortigidemo.com' };
    expect(nameClaim(orphan, indexIdentities([fay, petra]), opts).sole).toBeNull();
  });

  it('does not read the login when the caller does not pass the login prefixes', () => {
    // The default: a caller that is not applying login-reading rules asks the same
    // question it always asked.
    const orphan = { id: 'o', displayName: 'Admin account 042', email: 'adm-fhogenbirk@fortigidemo.com' };
    expect(nameClaim(orphan, indexIdentities([fay])).sole).toBeNull();
  });

  it('leaves a parsed-name claim intact when there is no login to read', () => {
    const orphan = { id: 'o', displayName: 'Fay Hogenbirk' };
    expect(nameClaim(orphan, indexIdentities([fay, petra]), opts).sole).toBe(fay);
  });
});

describe('nameClaim / collectCandidates - logins the conventions reduce (#1468)', () => {
  const opts = { loginPrefixes: loginPrefixesFrom(DEFAULT_RULES) };
  const candidateOpts = {
    prefixes: prefixesFrom(DEFAULT_RULES),
    suffixes: suffixesFrom(DEFAULT_RULES),
    loginPrefixes: loginPrefixesFrom(DEFAULT_RULES),
  };
  // These accounts carry no evidence but the login: the display name is the login
  // string itself, which parses to no person's name, and there is no employeeId,
  // no name column and no department. So the login reads, or nothing does.
  const admin = (login) => ({ id: 'o', displayName: login, email: `${login}@fortigidemo.com` });
  const danielle = {
    id: 'danielle', displayName: 'Daniëlle van Dongen', givenName: 'Daniëlle', surname: 'van Dongen',
    email: 'danielle.vandongen@fortigidemo.com',
  };
  const wilma = {
    id: 'wilma', displayName: 'W. van der Velde-Bierma', surname: 'van der Velde-Bierma',
    email: 'w.vandervelde@fortigidemo.com',
  };
  const petra = { id: 'petra', displayName: 'Petra Munck', givenName: 'Petra', surname: 'Munck', email: 'petra.munck@x.com' };

  it('singles out the sole owner of a particle-dropped login', () => {
    expect(nameClaim(admin('adm-ddongen'), indexIdentities([danielle, petra]), opts).sole).toBe(danielle);
  });

  it('singles out the sole owner of a login reduced to one half of her double surname', () => {
    expect(nameClaim(admin('adm-wvelde'), indexIdentities([wilma, petra]), opts).sole).toBe(wilma);
  });

  it('holds a numbered login for review between the namesakes it numbers', () => {
    // Two people answer to 'svisser', so the numbered login is contested, not placed —
    // and being contested is what puts it in the Name-only matches review list. Today
    // the claimant list is empty, so the account is invisible rather than held.
    const vissers = [
      { id: 'i1', displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser' },
      { id: 'i2', displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser' },
    ];
    const claim = nameClaim(admin('adm-svisser2'), indexIdentities(vissers), opts);
    expect(claim.sole).toBeNull();
    expect(claim.claimants.map(c => c.id).sort()).toEqual(['i1', 'i2']);
  });

  it('gathers the owner of a reduced login as a candidate at all', () => {
    // Scoring cannot rescue an orphan that reaches no candidate: it is never compared
    // to anybody, so it stays unlinked with no tie to review and no error anywhere.
    const indexes = indexIdentities([danielle, wilma, petra]);
    expect([...collectCandidates(admin('adm-ddongen'), indexes, candidateOpts).keys()]).toEqual(['danielle']);
    expect([...collectCandidates(admin('adm-wvelde'), indexes, candidateOpts).keys()]).toEqual(['wilma']);
  });

  it('still gathers nobody for a reduced login that names no identity', () => {
    const indexes = indexIdentities([danielle, wilma, petra]);
    expect(collectCandidates(admin('adm-dstraaten'), indexes, candidateOpts).size).toBe(0);
  });
});

describe('indexIdentities / nameClaim - the grade a shortened login claims at (#1468)', () => {
  const opts = { loginPrefixes: loginPrefixesFrom(DEFAULT_RULES) };
  const candidateOpts = {
    prefixes: prefixesFrom(DEFAULT_RULES),
    suffixes: suffixesFrom(DEFAULT_RULES),
    loginPrefixes: loginPrefixesFrom(DEFAULT_RULES),
  };
  const admin = (login) => ({ id: 'o', displayName: login, email: `${login}@fortigidemo.com` });
  const danielle = {
    id: 'danielle', displayName: 'Daniëlle van Dongen', givenName: 'Daniëlle', surname: 'van Dongen',
    email: 'danielle.vandongen@fortigidemo.com',
  };
  /** Genuinely called 'D. Dongen' — the particle-kept spelling of the same login. */
  const dirkje = { id: 'dirkje', displayName: 'Dirkje Dongen', givenName: 'Dirkje', surname: 'Dongen' };

  it('indexes a person under the shortened forms of her surname too', () => {
    const { byLoginInitial, byLoginLoose } = indexIdentities([danielle]);
    expect(byLoginInitial.get('dvandongen')).toEqual([danielle]);
    expect(byLoginLoose.get('ddongen')).toEqual([danielle]);
    // Not at both grades: the whole-surname spelling is hers alone to claim.
    expect(byLoginLoose.get('dvandongen')).toBeUndefined();
  });

  it('gives a login to the person genuinely spelled it over the one it was shortened to', () => {
    // Level-scoped rivalry (#1460) carried into the new grade: 'ddongen' is Dirkje's
    // own spelling and only a reduction of Daniëlle's, so the reduced claimant is no
    // rival at all and the account is placed rather than held between the two.
    const claim = nameClaim(admin('adm-ddongen'), indexIdentities([danielle, dirkje]), opts);
    expect(claim.sole).toBe(dirkje);
    expect(claim.claimants).toEqual([dirkje]);
  });

  it('holds a shortened login that two people’s surnames shorten to', () => {
    // Different particles, one reduction: nothing in the login says which of them it
    // belongs to, so it is contested at the loose grade like any other tie.
    const dirk = { id: 'dirk', displayName: 'Dirk ter Dongen', givenName: 'Dirk', surname: 'ter Dongen' };
    const claim = nameClaim(admin('adm-ddongen'), indexIdentities([danielle, dirk]), opts);
    expect(claim.sole).toBeNull();
    expect(claim.claimants.map(c => c.id).sort()).toEqual(['danielle', 'dirk']);
  });

  it('reads a numbered login as its own spelling before the name it numbers', () => {
    // 'svisser2' IS this Sanne's mailbox, so it is her login outright; the digit strip
    // is only reached where the login as written spells nobody. Read the other way
    // round, her own address would put her in a tie with her namesake.
    const owner = {
      id: 'owner', displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser',
      email: 'svisser2@fortigidemo.com',
    };
    const namesake = { id: 'namesake', displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser' };
    const claim = nameClaim(admin('adm-svisser2'), indexIdentities([owner, namesake]), opts);
    expect(claim.sole).toBe(owner);
    expect(claim.claimants).toEqual([owner]);
  });

  it('gathers the owner of a numbered login as a candidate', () => {
    // Both Vissers, because narrowing is all collectCandidates does — which of them
    // the login points at is nameClaim's question, asked after they are scored.
    const vissers = [
      { id: 'i1', displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser' },
      { id: 'i2', displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser' },
    ];
    const keys = [...collectCandidates(admin('adm-svisser2'), indexIdentities(vissers), candidateOpts).keys()];
    expect(keys.sort()).toEqual(['i1', 'i2']);
  });

  it('reads no shortened or numbered login when the rules strip no login prefixes', () => {
    // `loginPrefixes` is the rules' decision that a login is evidence at all. Without
    // it the token keeps its prefix ('admddongen') and shortens to nobody's name.
    const indexes = indexIdentities([danielle, dirkje]);
    const bare = { prefixes: [], suffixes: [], loginPrefixes: [] };
    expect(collectCandidates(admin('adm-ddongen'), indexes, bare).size).toBe(0);
    expect(nameClaim(admin('adm-ddongen'), indexes, {}).claimants).toEqual([]);
  });
});

describe('strongestNameRung - a shortened login is still the login rung (#1468)', () => {
  const danielle = {
    id: 'danielle', displayName: 'Daniëlle van Dongen', givenName: 'Daniëlle', surname: 'van Dongen',
    email: 'danielle.vandongen@fortigidemo.com',
  };

  it('fires the login rung for a login the convention shortened or numbered', () => {
    // The grade decides who out-claims whom, never whether the signal fires: an
    // account that reaches no rung scores nothing and stays orphaned.
    expect(strongestNameRung(
      { displayName: 'Admin account 128', email: 'adm-ddongen@fortigidemo.com' }, danielle, DEFAULT_RULES,
    )).toBe('loginName');
    expect(strongestNameRung(
      { displayName: 'Admin account 128', email: 'adm-ddongen2@fortigidemo.com' }, danielle, DEFAULT_RULES,
    )).toBe('loginName');
  });

  it('fires nothing for a login that shortens to somebody else', () => {
    expect(strongestNameRung(
      { displayName: 'Admin account 128', email: 'adm-dstraaten@fortigidemo.com' }, danielle, DEFAULT_RULES,
    )).toBeNull();
  });
});
