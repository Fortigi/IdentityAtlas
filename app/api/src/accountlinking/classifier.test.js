import { describe, it, expect } from 'vitest';
import { classifyAccount, emailLocalPart, normalizeName, stripKnownPrefixes, nameVariants, nameMatchLevel, bestNameMatch, compileAccountTypeRules } from './classifier.js';
import { DEFAULT_RULES } from './defaultRules.js';

describe('classifyAccount', () => {
  it('detects admin accounts by prefix', () => {
    expect(classifyAccount({ email: 'adm-jdoe@x.com', displayName: 'John Doe (Admin)' }, DEFAULT_RULES).accountType).toBe('Admin');
  });
  it('detects guest accounts via #EXT#', () => {
    expect(classifyAccount({ email: 'jdoe_contoso.com#EXT#@fabrikam.onmicrosoft.com', displayName: 'John (Guest)' }, DEFAULT_RULES).accountType).toBe('Guest');
  });
  it('detects guest accounts via userType metadata', () => {
    expect(classifyAccount({ email: 'g@x.com', displayName: 'G', extendedAttributes: { userType: 'Guest' } }, DEFAULT_RULES).accountType).toBe('Guest');
  });
  it('detects service accounts', () => {
    expect(classifyAccount({ email: 'svc-backup@x.com', displayName: 'Backup Job' }, DEFAULT_RULES).accountType).toBe('Service');
  });
  it('detects shared / room mailboxes', () => {
    expect(classifyAccount({ email: 'room-a@x.com', displayName: 'Room A Conference' }, DEFAULT_RULES).accountType).toBe('Shared');
  });
  it('defaults to Secondary for a plain human account', () => {
    expect(classifyAccount({ email: 'jane@x.com', displayName: 'Jane Smith' }, DEFAULT_RULES).accountType).toBe('Secondary');
  });
});

describe('match helpers', () => {
  it('emailLocalPart lowercases and drops the domain', () => {
    expect(emailLocalPart('Foo.Bar@Example.com')).toBe('foo.bar');
  });
  it('stripKnownPrefixes strips the first matching prefix', () => {
    expect(stripKnownPrefixes('adm-jdoe', ['adm-', 'a-'])).toBe('jdoe');
    expect(stripKnownPrefixes('jdoe', ['adm-'])).toBe('jdoe');
  });
  it('normalizeName strips suffixes and non-alnum', () => {
    expect(normalizeName('John Doe (Admin)', ['(admin)'])).toBe('johndoe');
    expect(normalizeName('John  Doe')).toBe('johndoe');
  });
});

// ── Helpers for the name-parsing tests ───────────────────────────────────────
//
// nameVariants returns EVERY name a person is known by — the structured
// givenName/surname columns, the parsed display name, and one half from each —
// because an HR source and the accounts it describes often spell the same person
// differently (birth surname vs name in use). A person with only one name source
// has exactly one variant, which is what most cases below are about; `keysOf`
// is for the cases where the sources genuinely disagree.

const EMPTY_NAME = { given: '', surname: '', initial: '', key: '' };
/** The first (and, for a single-source person, only) name a person reduces to. */
const one = (dn, g, s) => nameVariants(dn, g, s)[0] ?? EMPTY_NAME;
/** Every candidate-index key a person is indexed under, sorted (empties dropped,
 *  as the index itself drops them — a name with no surname indexes nothing). */
const keysOf = (dn, g, s) => nameVariants(dn, g, s).map(v => v.key).filter(Boolean).sort();

describe('nameVariants', () => {
  it('parses "Surname, Given" and strips qualifiers', () => {
    expect(one('Euson, Robin (OGD)')).toMatchObject({ given: 'robin', surname: 'euson' });
    expect(one('(ADM-azure) Euson, Robin')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
  it('parses "Given Surname"', () => {
    expect(one('Robin Euson')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
  it('produces an order-independent key', () => {
    expect(one('Euson, Robin').key).toBe(one('Robin Euson').key);
  });
  it('reads the explicit given/surname fields', () => {
    expect(one('', 'Robin', 'Euson')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
  it('yields one name when every source spells it the same way', () => {
    expect(nameVariants('Euson, Robin', 'Robin', 'Euson')).toHaveLength(1);
  });
});

describe('nameMatchLevel', () => {
  const n = (dn) => one(dn);
  it('full match on same given + surname despite qualifiers', () => {
    expect(nameMatchLevel(n('Euson, Robin (OGD)'), n('(ADM-azure) Euson, Robin'))).toBe('full');
  });
  it('surnameInitial when only the initial matches', () => {
    expect(nameMatchLevel(one('', 'R', 'Euson'), n('Euson, Robin'))).toBe('surnameInitial');
  });
  it('none when surnames differ', () => {
    expect(nameMatchLevel(n('Smith, Jane'), n('Euson, Robin'))).toBe('none');
  });
});

// ── The parts the tests above reach but never pin ────────────────────────────
//
// Linking decides which accounts are the same PERSON, so both failure directions are
// silent and serious: link too eagerly and one person inherits another's access in every
// view; link too shyly and their real combined access is never visible to a reviewer.
// Everything below survived mutation while the file sat at 97% line coverage.

describe('emailLocalPart - normalisation', () => {
  it('returns empty for an absent address rather than throwing', () => {
    // Called on principals straight out of a crawler, where email is routinely null.
    expect(emailLocalPart(null)).toBe('');
    expect(emailLocalPart(undefined)).toBe('');
    expect(emailLocalPart('')).toBe('');
  });

  it('lowercases AND trims, not one or the other', () => {
    // Two separate steps on one line: drop either and " Alice@x.com " no longer matches
    // "alice", so the same person arrives as two identities.
    expect(emailLocalPart('  Alice@Example.COM  ')).toBe('alice');
  });

  it('keeps the whole string when there is no @ at all', () => {
    // The at === -1 branch. Read as "found", slice(0, -1) silently drops the last
    // character of every domain-less value -- so "jsmith" matches as "jsmit".
    expect(emailLocalPart('jsmith')).toBe('jsmith');
    expect(emailLocalPart('  JSmith ')).toBe('jsmith');
  });

  it('splits on the FIRST @', () => {
    expect(emailLocalPart('a.b@x@y.com')).toBe('a.b');
  });
});

describe('normalizeName - normalisation', () => {
  it('returns empty for an absent value', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });

  it('lowercases and trims before stripping', () => {
    expect(normalizeName('  Van Der Berg  ')).toBe('vanderberg');
  });

  it('strips a suffix only when it is actually present', () => {
    // `sl && s.includes(sl)`: as OR, an empty suffix entry is "present" in every string
    // and splits it on '' -- as AND-with-true, every name loses text it never contained.
    expect(normalizeName('Alice Smith (Admin)', ['(admin)'])).toBe('alicesmith');
    expect(normalizeName('Alice Smith', ['(admin)'])).toBe('alicesmith');
    expect(normalizeName('Alice Smith', [''])).toBe('alicesmith');
  });
});

describe('compileAccountTypeRules - ordering', () => {
  it('applies rules in priority order, lowest first', () => {
    // The sort is what makes a rule "win". Supplied in the WRONG order deliberately: an
    // unsorted (or reversed) compile classifies this account as Service rather than Admin.
    const rules = {
      accountTypeRules: [
        { accountType: 'Service', priority: 20, patterns: ['^svc-'] },
        { accountType: 'Admin', priority: 10, patterns: ['^svc-'] },
      ],
    };
    expect(compileAccountTypeRules(rules).map(r => r.accountType)).toEqual(['Admin', 'Service']);
    expect(classifyAccount({ email: 'svc-x@corp.com' }, rules).accountType).toBe('Admin');
  });

  it('sorts an already-ordered list stably', () => {
    // Pairs with the case above so "reverse everything" cannot pass both.
    const rules = {
      accountTypeRules: [
        { accountType: 'Admin', priority: 10, patterns: ['^adm-'] },
        { accountType: 'Service', priority: 20, patterns: ['^svc-'] },
      ],
    };
    expect(compileAccountTypeRules(rules).map(r => r.accountType)).toEqual(['Admin', 'Service']);
  });

  it('defaults a rule with no priority to the back', () => {
    const rules = {
      accountTypeRules: [
        { accountType: 'NoPriority', patterns: ['^x-'] },
        { accountType: 'Explicit', priority: 5, patterns: ['^y-'] },
      ],
    };
    expect(compileAccountTypeRules(rules).map(r => r.accountType)).toEqual(['Explicit', 'NoPriority']);
  });

  it('tolerates a rule with no patterns instead of throwing', () => {
    // Reachable from a hand-edited config; the rule contributes nothing but must not take
    // the whole classification down with it.
    const rules = { accountTypeRules: [{ accountType: 'Empty', priority: 1 }] };
    const compiled = compileAccountTypeRules(rules);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].regexes).toEqual([]);
    expect(classifyAccount({ email: 'someone@corp.com' }, rules).accountType).toBe('Secondary');
  });
});

describe('classifyAccount - guest detection', () => {
  it('reports WHICH signal made it a guest', () => {
    // Two independent signals, and the pattern field says which one fired. Hard-coded
    // either way, the reason shown to a reviewer stops matching the account.
    expect(classifyAccount({ email: 'a@x.com', extendedAttributes: { userType: 'Guest' } }))
      .toEqual({ accountType: 'Guest', pattern: 'userType=Guest' });
    expect(classifyAccount({ email: 'a_ext#EXT#@x.com'.toLowerCase(), extendedAttributes: {} }))
      .toEqual({ accountType: 'Guest', pattern: '#ext#' });
  });

  it('does not treat a member as a guest', () => {
    // Without this, `userType === 'guest'` hard-coded true makes EVERY account a guest.
    expect(classifyAccount({ email: 'a@x.com', extendedAttributes: { userType: 'Member' } }).accountType)
      .not.toBe('Guest');
  });

  it('reads userType case-insensitively and under either spelling', () => {
    expect(classifyAccount({ email: 'a@x.com', extendedAttributes: { userType: 'GUEST' } }).accountType).toBe('Guest');
    expect(classifyAccount({ email: 'a@x.com', extendedAttributes: { usertype: 'guest' } }).accountType).toBe('Guest');
  });
});

describe('nameVariants - forms and fallbacks', () => {
  it('parses "Surname, Given" and takes only the FIRST given token', () => {
    // "Doe, John Michael" -> given "john", not "john michael": middle names appear
    // inconsistently across systems, so including them would split one person in two.
    expect(one('Doe, John Michael')).toMatchObject({ given: 'john', surname: 'doe' });
  });

  it('parses "Given Surname" using the FIRST and LAST tokens', () => {
    // Middle names again: the surname is the last token, not the second.
    expect(one('John Michael Doe')).toMatchObject({ given: 'john', surname: 'doe' });
  });

  it('treats a lone token as a SURNAME, not a given name', () => {
    // A mononym or a display name that is just "Doe". Surname is the field
    // nameMatchLevel requires, so guessing wrong here means the name never matches
    // anything at all.
    expect(one('Doe')).toMatchObject({ given: '', surname: 'doe' });
  });

  it('collapses runs of whitespace rather than producing empty tokens', () => {
    expect(one('John    Doe')).toMatchObject({ given: 'john', surname: 'doe' });
    expect(one('  John   Michael   Doe  ')).toMatchObject({ given: 'john', surname: 'doe' });
  });

  it('keeps the explicit columns AND the parsed display name, not one or the other', () => {
    // Neither source is authoritative: the columns are clean but often hold the birth
    // surname, while the display name carries the name in use the accounts are spelled
    // with. Dropping either half is a regression in one direction or the other (#1439),
    // so both are indexed and a match on either counts.
    expect(keysOf('Doe, John', 'Jane', 'Smith')).toEqual(['doe|john', 'jane|smith']);
    expect(keysOf('', 'John', 'Doe')).toEqual(['doe|john']);
  });

  it('fills whichever half a column leaves empty from the display name', () => {
    // A half-populated column pair is still worth a name of its own: "Smith" with no
    // given name matches nothing, so the display name supplies the other half.
    expect(keysOf('Doe, John', '', 'Smith')).toEqual(['doe|john', 'john|smith', 'smith']);
    expect(keysOf('Doe, John', 'Jane', '')).toEqual(['doe|jane', 'doe|john']);
    // A lone display-name token fills surname, so only the GIVEN comes from the column.
    expect(keysOf('Doe', 'John', '')).toEqual(['doe', 'doe|john']);
  });

  it('strips bracketed qualifiers before parsing', () => {
    expect(one('John Doe (Admin)')).toMatchObject({ given: 'john', surname: 'doe' });
    expect(one('Doe, John [Contractor]')).toMatchObject({ given: 'john', surname: 'doe' });
  });

  it('builds an order-independent key, and none at all without a surname', () => {
    // The key indexes candidates, so it must be the same whichever way round the name
    // arrived. Without a surname there is nothing to index on and the key must be empty
    // rather than a given-name-only key that would collide across unrelated people.
    expect(one('Doe, John').key).toBe(one('John Doe').key);
    expect(one('Doe, John').key).toBe('doe|john');
    expect(one('', 'John', '').key).toBe('');
  });

  it('yields no name at all for a person with no name anywhere', () => {
    expect(nameVariants('', '', '')).toEqual([]);
    expect(nameVariants(null, null, null)).toEqual([]);
  });

  it('exposes the given-name initial', () => {
    expect(one('John Doe').initial).toBe('j');
    expect(one('Doe').initial).toBe('');
  });
});

describe('nameMatchLevel - levels', () => {
  const n = (dn, g, s) => one(dn, g, s);

  it('is full only when surname AND given name agree', () => {
    expect(nameMatchLevel(n('John Doe'), n('John Doe'))).toBe('full');
  });

  it('is surnameInitial when the given names share only their first letter', () => {
    expect(nameMatchLevel(n('J Doe'), n('John Doe'))).toBe('surnameInitial');
  });

  it('is none when the surnames differ, whatever the given names do', () => {
    expect(nameMatchLevel(n('John Doe'), n('John Smith'))).toBe('none');
  });

  it('is none when EITHER side has no surname', () => {
    // `!a.surname || !b.surname`. As AND, only a pair where BOTH lack a surname is
    // rejected -- so a nameless account matches any single name it is compared against,
    // which is the widest possible false link.
    expect(nameMatchLevel(n('', 'John', ''), n('John Doe'))).toBe('none');
    expect(nameMatchLevel(n('John Doe'), n('', 'John', ''))).toBe('none');
    expect(nameMatchLevel(n('', '', ''), n('', '', ''))).toBe('none');
  });

  it('is none for a surname match with no given name on either side', () => {
    // Surname-only is deliberately NOT a match: "Doe" and "Doe" are not evidence of one
    // person. Both the given and the initial comparison must decline.
    expect(nameMatchLevel(n('Doe'), n('Doe'))).toBe('none');
  });

  it('does not treat a one-sided given name as an initial match', () => {
    // `a.initial && b.initial`. As OR, one side having an initial is enough and the
    // comparison runs against an empty string on the other.
    expect(nameMatchLevel(n('John Doe'), n('Doe'))).toBe('none');
    expect(nameMatchLevel(n('Doe'), n('John Doe'))).toBe('none');
  });

  it('does not treat different initials as a match', () => {
    expect(nameMatchLevel(n('Alice Doe'), n('John Doe'))).toBe('none');
  });
});

// ── Titles and multi-word surnames (#1439) ───────────────────────────────────
//
// HR display names in Dutch, Belgian and German sources routinely carry academic
// titles ("Jan de Vries MSc", "drs. Anna Bakker") and particle surnames ("van den
// Berg"). Parsing the first token as the given name and the LAST as the surname
// turns a title into a name, so the real owner stops matching and the account is
// linked to a namesake instead -- access rolls up to the wrong person.

describe('nameVariants - titles and multi-word surnames (#1439)', () => {
  it('reads the title-bearing display name without turning the title into a name', () => {
    // The reported case: the LAST token is 'MSc', so the owner was indexed under
    // {jan, msc} and was never even a candidate for her own account. Whether the
    // columns are present or not, no name she is indexed under is 'msc'.
    expect(keysOf('Jan de Vries MSc', 'Jan', 'de Vries')).toEqual(['devries|jan']);
    expect(keysOf('Jan de Vries MSc')).toEqual(['devries|jan']);
  });

  it('strips post-nominal titles when only a display name is available', () => {
    expect(one('Jan de Vries MSc')).toMatchObject({ given: 'jan', surname: 'devries' });
    expect(one('Anna Bakker PhD')).toMatchObject({ given: 'anna', surname: 'bakker' });
  });

  it('strips pre-nominal titles when only a display name is available', () => {
    expect(one('drs. Anna Bakker')).toMatchObject({ given: 'anna', surname: 'bakker' });
    expect(one('ir. Jeroen Visser')).toMatchObject({ given: 'jeroen', surname: 'visser' });
  });

  it('strips a stack of titles on both sides of the name', () => {
    // Several titles at once, which a single-shot strip would only half remove.
    expect(one('Prof. dr. ir. Willem van der Laan MSc'))
      .toMatchObject({ given: 'willem', surname: 'vanderlaan' });
  });

  it('keeps the particles as part of the surname', () => {
    // 'berg' is not this person's surname: every other "van den Berg" in the tenant
    // reduces to the same token, so a name match stops meaning anything.
    expect(one('Jeroen van den Berg').surname).toBe('vandenberg');
    expect(one('Mark ter Horst').surname).toBe('terhorst');
  });

  it('does not conflate a particle surname with its hyphenated compound', () => {
    // Two different people and two different families -- the last-word rule scores
    // them as the same surname, which is the one non-title wrong link in the report.
    expect(one('Mark van der Steen').surname)
      .not.toBe(one('Lisa Schilder-van der Steen').surname);
    expect(one('Lisa Schilder-van der Steen')).toMatchObject({ given: 'lisa', surname: 'schildervandersteen' });
  });

  it('still collapses a middle name into the given+last pair', () => {
    // The paired negative: the surname grows only from a known particle onwards, not
    // from "everything after the given name" -- otherwise the middle names that appear
    // inconsistently across systems would split one person into two.
    expect(one('Anna Maria Bakker')).toMatchObject({ given: 'anna', surname: 'bakker' });
    expect(one('John Michael Doe')).toMatchObject({ given: 'john', surname: 'doe' });
  });

  it('matches the same person across a titled and an untitled display name', () => {
    // What the linking engine actually asks: the HR record and the account are one person.
    expect(bestNameMatch(nameVariants('Jan de Vries MSc', 'Jan', 'de Vries'), nameVariants('Jan de Vries')))
      .toBe('full');
    expect(keysOf('Jan de Vries MSc', 'Jan', 'de Vries')).toContain(one('Jan de Vries').key);
  });

  it('still separates two people whose surnames differ only by a particle', () => {
    expect(nameMatchLevel(one('Mark van der Steen'), one('Mark Steen'))).toBe('none');
  });

  it('does not let a hyphenated GIVEN name start the surname', () => {
    // Only a compound ending in a particle ("Schilder-van") begins the surname. A
    // hyphenated first or middle name is just a name token -- treat it as a surname
    // start and "Anna Maria-Louise Bakker" stops matching "Anna Bakker", which is
    // the same person under a system that records no middle name.
    expect(one('Anna Maria-Louise Bakker')).toMatchObject({ given: 'anna', surname: 'bakker' });
    expect(nameMatchLevel(one('Anna Maria-Louise Bakker'), one('Anna Bakker'))).toBe('full');
  });

  it('reads a trailing comma as a surname with no given name', () => {
    // "Doe," is what a source with an empty given-name column writes. The surname
    // half must still land -- it is the half nameMatchLevel requires, so losing it
    // means the account matches nothing at all rather than matching too much.
    expect(one('Doe,')).toMatchObject({ given: '', surname: 'doe' });
    expect(one('de Vries,', '', '')).toMatchObject({ given: '', surname: 'devries' });
  });

  it('keeps a short surname that happens to spell a degree', () => {
    // The title strip never takes a name down to fewer than two tokens, so the
    // surname of someone called "Jan Ma" survives being spelled like an MA.
    expect(one('Jan Ma')).toMatchObject({ given: 'jan', surname: 'ma' });
    expect(one('Ma, Jan')).toMatchObject({ given: 'jan', surname: 'ma' });
  });
});

// ── Birth surname vs name in use (#1439) ─────────────────────────────────────
//
// The follow-up regression. Reading the structured columns INSTEAD of the parsed
// display name fixed the title mis-parse but broke the far more common case: HR
// holds the birth surname in `surname`, while the display name and the accounts
// carry the name in use (a partner name, a double name). On the synthetic
// dataset that left 469 previously-correct links unlinked. So both names are
// kept, and a match on either one counts.

describe('nameVariants - birth surname and name in use (#1439)', () => {
  // HR: born "de Wit", known as "Bakker-de Wit" since she married.
  const hr = () => nameVariants('Anna Bakker-de Wit', 'Anna', 'de Wit');

  it('indexes a person under BOTH her birth surname and her name in use', () => {
    expect(keysOf('Anna Bakker-de Wit', 'Anna', 'de Wit'))
      .toEqual(['anna|bakkerdewit', 'anna|dewit']);
  });

  it('matches an account that carries the name in use', () => {
    // The account the directory actually holds. Column-only parsing indexes her
    // as {anna, dewit} alone, this account matches nothing, and her own account
    // is left orphaned -- the 397-link half of the regression.
    expect(bestNameMatch(hr(), nameVariants('Anna Bakker-de Wit'))).toBe('full');
  });

  it('still matches an account that carries the birth surname', () => {
    // The paired case: a system that was fed the HR columns spells her the old
    // way, and that has to keep working -- it is why the columns are read at all.
    expect(bestNameMatch(hr(), nameVariants('Anna de Wit'))).toBe('full');
    expect(bestNameMatch(hr(), nameVariants('', 'Anna', 'de Wit'))).toBe('full');
  });

  it('matches on the initial through either name', () => {
    expect(bestNameMatch(hr(), nameVariants('A. Bakker-de Wit'))).toBe('surnameInitial');
    expect(bestNameMatch(hr(), nameVariants('A. de Wit'))).toBe('surnameInitial');
  });

  it('does not match a stranger who shares neither name', () => {
    // Widening the name set must not widen what matches: two names each, four
    // comparisons, and all four have to decline.
    expect(bestNameMatch(hr(), nameVariants('Anna Visser', 'Anna', 'Visser'))).toBe('none');
    expect(bestNameMatch(hr(), nameVariants('Bakker, Anna'))).toBe('none');
  });

  it('records which of her names each variant is', () => {
    // What tells the two apart when they collide under one name key: the person
    // whose name in use it is outranks the one who only was born with it, so a
    // birth surname cannot tie up an account that is unique on the name in use.
    expect(hr().map(v => [v.surname, v.variant]))
      .toEqual([['dewit', 'birth'], ['bakkerdewit', 'inUse']]);
  });

  it('reads a column the display name agrees with as the name in use', () => {
    expect(nameVariants('Anna de Wit', 'Anna', 'de Wit').map(v => v.variant)).toEqual(['inUse']);
  });

  it('reads the columns as the name in use when no display name contradicts them', () => {
    // Nothing marks this as an old name. Called one, she would lose every tie to
    // anyone who happens to have a display name — including her own accounts'.
    expect(nameVariants('', 'Anna', 'de Wit').map(v => v.variant)).toEqual(['inUse']);
    expect(nameVariants(null, 'Anna', 'de Wit').map(v => v.variant)).toEqual(['inUse']);
  });

  it('reads a half it took from the display name as the name in use', () => {
    // Only a surname the COLUMN holds can be a birth name; a half filled in from
    // the display name is the name in use whatever the other half came from.
    expect(nameVariants('Anna Bakker-de Wit', 'Anna', '').map(v => [v.surname, v.variant]))
      .toEqual([['', 'inUse'], ['bakkerdewit', 'inUse']]);
  });
});

describe('bestNameMatch', () => {
  it('takes the STRONGEST level across the name pairs, not the first or the last', () => {
    // Her birth name matches only on the initial, her name in use matches in full.
    // Returning the first or the weakest comparison downgrades a certain match to
    // 'surnameInitial', which scores 45 instead of 60 and can drop under the
    // threshold -- the account silently stops linking.
    const hr = nameVariants('Anna Bakker-de Wit', 'Anna', 'de Wit');
    expect(bestNameMatch(hr, nameVariants('A. de Wit'))).toBe('surnameInitial');
    expect(bestNameMatch(hr, nameVariants('Anna Bakker-de Wit', 'A', 'de Wit'))).toBe('full');
  });

  it('is symmetric', () => {
    const a = nameVariants('Anna Bakker-de Wit', 'Anna', 'de Wit');
    const b = nameVariants('Anna Bakker-de Wit');
    expect(bestNameMatch(a, b)).toBe(bestNameMatch(b, a));
  });

  it('is none when either side has no name at all', () => {
    expect(bestNameMatch(nameVariants('Anna de Wit'), [])).toBe('none');
    expect(bestNameMatch([], nameVariants('Anna de Wit'))).toBe('none');
    expect(bestNameMatch([], [])).toBe('none');
  });
});
