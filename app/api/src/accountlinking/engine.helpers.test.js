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
  nameSignalNames,
  isNameOnly,
  parseLinkSignals,
  indexIdentities,
  collectCandidates,
  nameClaim,
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

// ── A near-identical name is a rival too (#1440) ─────────────────────────────
//
// The tie between top-scoring candidates cannot see the case that actually went
// wrong: the real owner is spelled a little differently, so she scores BELOW the
// namesake who matches cleanly and never ties with her. Reading a name at both
// levels the engine scores names at -- the full name and the surname + given
// initial -- is what makes her visible.

describe('nameClaim - a namesake behind a near-identical spelling (#1440)', () => {
  const jan = { id: 'jan', displayName: 'Jan Jansen' };
  const johannes = { id: 'johannes', displayName: 'Johannes Jansen' };
  const account = { id: 'o', displayName: 'Jan Jansen' };

  it('points at nobody when a second person shares the surname and initial', () => {
    // "Jan Jansen" is an exact match for one of them and a plausible spelling of
    // the other. Nothing in the name says which, so neither may have it.
    const claim = nameClaim(account, indexIdentities([jan, johannes]));
    expect(claim.sole).toBeNull();
    expect(claim.claimants).toEqual([jan, johannes]);
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
