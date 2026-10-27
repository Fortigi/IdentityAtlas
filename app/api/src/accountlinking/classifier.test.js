import { describe, it, expect } from 'vitest';
import { classifyAccount, emailLocalPart, normalizeName, stripKnownPrefixes, nameVariants, nameMatchLevel, bestNameMatch, compileAccountTypeRules, loginToken, unnumberedLoginToken, loginSpellings, numberedAwayFrom, loginNameForms, loginFormMatch } from './classifier.js';
import { nameInitials } from './initials.js';
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

// ── A login that spells a name (#1454) ───────────────────────────────────────
//
// An admin login is a name, not an address: `adm-fhogenbirk` says "the F. Hogenbirk
// of this tenant". Reading it as an address — strip the prefix, then demand the rest
// equal the owner's email local part — recognises one provisioning convention and
// nothing else, which left 34 of 64 admin accounts on the reporting tenant attached
// to nobody. The inputs below are the ones that discriminate: a one-initial login
// against a two-initial mailbox (which separator-stripping alone cannot bridge), and
// a short form that fits two people.

describe('loginToken', () => {
  const PREFIXES = DEFAULT_RULES.signals.find(s => s.type === 'loginName').stripPrefixes;

  it('strips the admin prefix and then the separators, in that order', () => {
    // Order matters: the prefix carries the separator that delimits it, so dropping
    // separators first leaves 'admfhogenbirk' and no prefix to recognise.
    expect(loginToken('adm-fhogenbirk@fortigidemo.com', PREFIXES)).toBe('fhogenbirk');
    expect(loginToken('ADM_F.Hogenbirk@fortigidemo.com', PREFIXES)).toBe('fhogenbirk');
  });

  it('reduces a login that carries no prefix to its separator-free local part', () => {
    expect(loginToken('f.h.hogenbirk@fortigidemo.com', PREFIXES)).toBe('fhhogenbirk');
  });

  it('is empty for an account with no login to read', () => {
    // The 25 ERP accounts in the report have no address at all; they must produce no
    // token rather than a token that matches whoever else has none (#1455 owns them).
    expect(loginToken(null, PREFIXES)).toBe('');
    expect(loginToken('', PREFIXES)).toBe('');
    expect(loginToken('adm-@fortigidemo.com', PREFIXES)).toBe('');
  });
});

describe('loginNameForms', () => {
  const fay = {
    displayName: 'Fay Hogenbirk', givenName: 'Fay', surname: 'Hogenbirk',
    email: 'f.h.hogenbirk@fortigidemo.com',
  };

  it('writes the name out in full and as initial + surname', () => {
    const { full, initial } = loginNameForms(fay);
    expect([...full.keys()].sort()).toEqual(['fayhogenbirk', 'fhhogenbirk']);
    // The form the reporter's admin login actually carries — and the one no
    // separator-stripped comparison of the two addresses can ever produce.
    expect([...initial.keys()]).toEqual(['fhogenbirk']);
  });

  it('grades the person’s own short address as an initial form, not a full one', () => {
    // 'j.jansen' is initial + surname however it was read. Graded 'full' because it
    // came off the address, it would outrank the real initial-level claimants and
    // hand a 'jjansen' login to this Jan Jansen over an equally-named one.
    const jan = { displayName: 'Jan Jansen', givenName: 'Jan', surname: 'Jansen', email: 'j.jansen@x.com' };
    const { full, initial } = loginNameForms(jan);
    expect([...full.keys()]).toEqual(['janjansen']);
    expect([...initial.keys()]).toEqual(['jjansen']);
  });

  it('never lists one form at both levels', () => {
    // A one-letter given name makes 'given + surname' and 'initial + surname' the
    // same string. Listed at both, the same person is their own rival.
    const { full, initial } = loginNameForms({ displayName: 'A Li', givenName: 'A', surname: 'Li' });
    expect([...full.keys()]).toEqual(['ali']);
    expect(initial.has('ali')).toBe(false);
  });

  it('records which of the person’s names each form came from', () => {
    // Her accounts are provisioned from the name she goes by; the surname column
    // still holds the birth name. Both are forms, and the guard needs to know which
    // is which to place an 'adewit' login on the woman actually called de Wit.
    const { full, initial } = loginNameForms({
      displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit',
    });
    expect(full.get('annabakkerdewit')).toBe('inUse');
    expect(full.get('annadewit')).toBe('birth');
    expect(initial.get('abakkerdewit')).toBe('inUse');
    expect(initial.get('adewit')).toBe('birth');
  });

  it('reads a form off a display name alone, and off columns alone', () => {
    expect([...loginNameForms({ displayName: 'Hogenbirk, Fay' }).initial.keys()]).toEqual(['fhogenbirk']);
    expect([...loginNameForms({ givenName: 'Fay', surname: 'Hogenbirk' }).initial.keys()]).toEqual(['fhogenbirk']);
  });

  it('produces no form for a name with no surname', () => {
    // A bare given name is not a login form: 'f' would answer for every F in the
    // tenant, and a bare surname is already treated as no name match at all.
    expect(loginNameForms({ displayName: 'Fay' }).initial.size).toBe(0);
    expect(loginNameForms({ givenName: 'Fay' }).full.size).toBe(0);
    expect(loginNameForms({}).full.size).toBe(0);
  });
});

describe('loginFormMatch', () => {
  const fay = {
    displayName: 'Fay Hogenbirk', givenName: 'Fay', surname: 'Hogenbirk',
    email: 'f.h.hogenbirk@fortigidemo.com',
  };

  it('matches the whole-name form ahead of the initial one', () => {
    expect(loginFormMatch('fayhogenbirk', fay)).toBe('full');
    expect(loginFormMatch('fhogenbirk', fay)).toBe('initial');
  });

  it('does not match a different surname or a different initial', () => {
    expect(loginFormMatch('jhogenbirk', fay)).toBe('none');
    expect(loginFormMatch('fhogenberg', fay)).toBe('none');
    // A bare surname is no form — every Hogenbirk would otherwise claim it.
    expect(loginFormMatch('hogenbirk', fay)).toBe('none');
  });

  it('matches nothing for an account with no login', () => {
    expect(loginFormMatch('', fay)).toBe('none');
  });
});

// ── Login conventions beyond initial + particle-kept surname (#1468) ─────────
//
// Three conventions a tenant writes an admin login in, none of which
// `loginNameForms` spells: the particle dropped (`adm-ddongen`), one half of a
// double surname (`adm-wvelde`), and a trailing digit run numbering a namesake
// (`adm-svisser2`). On the reporting tenant that was 0 of 8 particle-dropped and
// 0 of 2 half-double-surname accounts linked — and none even held for review,
// since a login that matches no form makes its owner invisible rather than
// contested. Each form must read strictly weaker than the particle-kept one, so
// a person genuinely named the reduced form still outranks the
// convention-reduced claimant (#1460).
describe('login forms the conventions actually write (#1468)', () => {
  const PREFIXES = DEFAULT_RULES.signals.find(s => s.type === 'loginName').stripPrefixes;
  const danielle = { displayName: 'Daniëlle van Dongen', givenName: 'Daniëlle', surname: 'van Dongen' };
  const wilma = { displayName: 'W. van der Velde-Bierma', surname: 'van der Velde-Bierma' };
  const sanne = { displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser' };

  it('reads a login that drops the surname particle', () => {
    // 'ddongen' equals none of her forms ('dvandongen', 'danillevandongen').
    expect(loginFormMatch(loginToken('adm-ddongen@fortigidemo.com', PREFIXES), danielle)).not.toBe('none');
  });

  it('reads a login that keeps one half of a double surname', () => {
    // Her only form writes the surname whole: 'wvanderveldebierma'.
    expect(loginFormMatch(loginToken('adm-wvelde@fortigidemo.com', PREFIXES), wilma)).not.toBe('none');
  });

  it('reads a numbered login the way it reads the unnumbered one', () => {
    // The 2 numbers a namesake; it is not part of the name. 'adm-svisser' is read
    // today, so the only thing keeping 'adm-svisser2' out is the digit run.
    expect(loginFormMatch(loginToken('adm-svisser2@fortigidemo.com', PREFIXES), sanne)).not.toBe('none');
  });

  it('grades a particle-dropped form below the particle-kept one', () => {
    // The woman actually called 'D. Dongen' answers 'ddongen' at the stronger,
    // particle-kept level; Daniëlle van Dongen answers it only reduced. Merged
    // into one level they would tie, and neither could be placed (#1460).
    const dirkje = { displayName: 'Dirkje Dongen', givenName: 'Dirkje', surname: 'Dongen' };
    expect(loginFormMatch('ddongen', dirkje)).toBe('initial');
    expect(loginFormMatch('ddongen', danielle)).not.toBe('none');
    expect(['full', 'initial']).not.toContain(loginFormMatch('ddongen', danielle));
  });

  it('keeps the digits of a login that is somebody’s own address', () => {
    // The digit strip is a lookup fallback, never a rewrite of the token: this
    // mailbox *is* 'jan2', and stripping the run in `loginToken` would hand the
    // account to every Jan Jansen in the tenant instead of to its owner.
    const jan = { displayName: 'Jan Jansen', givenName: 'Jan', surname: 'Jansen', email: 'jan2@x.com' };
    expect(loginToken('adm-jan2@fortigidemo.com', PREFIXES)).toBe('jan2');
    expect(loginFormMatch('jan2', jan)).toBe('full');
  });
});

describe('unnumberedLoginToken', () => {
  it('drops the digit run a convention numbers a namesake with', () => {
    expect(unnumberedLoginToken('svisser2')).toBe('svisser');
    expect(unnumberedLoginToken('svisser12')).toBe('svisser');
  });

  it('is empty for a login that carries no number to drop', () => {
    // Empty rather than the token itself: handed back unchanged, a caller would look
    // the same spelling up twice and read one claimant as two.
    expect(unnumberedLoginToken('svisser')).toBe('');
    expect(unnumberedLoginToken('')).toBe('');
    expect(unnumberedLoginToken(null)).toBe('');
  });

  it('drops only the trailing run, and leaves nothing of an all-digit login', () => {
    // 'a1b2' is not 'a1b2' numbered — only its last run is a number, and a login
    // that is nothing but digits names nobody once they are gone.
    expect(unnumberedLoginToken('a1b2')).toBe('a1b');
    expect(unnumberedLoginToken('042')).toBe('');
  });
});

describe('loginNameForms - the surname a convention shortened (#1468)', () => {
  it('spells the particle-dropped surname at the loose grade and nowhere else', () => {
    const { full, initial, loose } = loginNameForms({
      displayName: 'Daniëlle van Dongen', givenName: 'Daniëlle', surname: 'van Dongen',
    });
    expect([...full.keys()]).toEqual(['danillevandongen']);
    expect([...initial.keys()]).toEqual(['dvandongen']);
    expect([...loose.keys()]).toEqual(['ddongen']);
  });

  it('spells each half of a hyphenated double surname, with and without its particles', () => {
    const { loose } = loginNameForms({
      displayName: 'W. van der Velde-Bierma', surname: 'van der Velde-Bierma',
    });
    expect([...loose.keys()].sort()).toEqual(['wbierma', 'wvandervelde', 'wvelde', 'wveldebierma']);
  });

  it('shortens nothing for a surname that is one plain word', () => {
    // The control that makes the assertions above mean something: a reduction firing
    // here would re-spell the whole surname at the weakest grade, so every S. Visser
    // would answer 'svisser' twice — as herself, and as her own weaker rival.
    const sanne = loginNameForms({ displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser' });
    expect(sanne.loose.size).toBe(0);
    expect([...sanne.initial.keys()]).toEqual(['svisser']);
  });

  it('never lists a shortened form at a grade that already spells it', () => {
    // 'de Wit' is both the birth surname her columns hold and the second half of the
    // name she goes by, so 'adewit' is genuinely spelled at `initial` and merely
    // reduced to at `loose`. Listed at both she is her own rival one grade down.
    const { initial, loose } = loginNameForms({
      displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit',
    });
    expect(initial.get('adewit')).toBe('birth');
    expect(loose.has('adewit')).toBe(false);
    expect([...loose.keys()].sort()).toEqual(['abakker', 'abakkerwit', 'awit']);
  });

  it('keeps the person’s own address off the full grade when it is only a shortened form', () => {
    // Her mailbox IS 'w.vandervelde', but that spelling carries one initial and half
    // a surname. Graded 'full' because it came off her address it would outrank the
    // W. van der Velde who is genuinely spelled that way — the same reason a short
    // address is graded 'initial' rather than 'full'.
    const { full, loose } = loginNameForms({
      displayName: 'Wilma van der Velde-Bierma', givenName: 'Wilma',
      surname: 'van der Velde-Bierma', email: 'w.vandervelde@x.com',
    });
    expect(full.has('wvandervelde')).toBe(false);
    expect(loose.get('wvandervelde')).toBe('inUse');
  });

  it('carries the shortened surnames on the parsed name itself', () => {
    expect(one('Daniëlle van Dongen', 'Daniëlle', 'van Dongen').reducedSurnames).toEqual(['dongen']);
    expect(one('Sanne Visser', 'Sanne', 'Visser').reducedSurnames).toEqual([]);
    expect(one('Fay').reducedSurnames).toEqual([]);
  });
});

describe('loginFormMatch - the grade a shortened or numbered login reads at (#1468)', () => {
  const sanne = { displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser' };
  const danielle = { displayName: 'Daniëlle van Dongen', givenName: 'Daniëlle', surname: 'van Dongen' };

  it('reads a numbered login at the grade the name it numbers reads at', () => {
    // The number is not evidence and is not noise either: it must not promote or
    // demote the form it is attached to.
    expect(loginFormMatch('svisser2', sanne)).toBe('initial');
    expect(loginFormMatch('sannevisser2', sanne)).toBe('full');
    expect(loginFormMatch('ddongen2', danielle)).toBe('loose');
  });

  it('reads the login as written before reading it as a numbered name', () => {
    // 'pmunck2' is this Munck's own mailbox, so it is her whole login rather than the
    // tenant's second P. Munck. Falling through to the digit strip first would grade
    // her own address as a weaker, initial-level form of her name.
    const petra = { displayName: 'Petra Munck', givenName: 'Petra', surname: 'Munck', email: 'pmunck2@x.com' };
    expect(loginFormMatch('pmunck2', petra)).toBe('full');
  });

  it('still matches nothing for a shortened surname that is not hers', () => {
    expect(loginFormMatch('dstraaten', danielle)).toBe('none');
    // Her surname shortened, but under somebody else's initial.
    expect(loginFormMatch('rdongen', danielle)).toBe('none');
    // A bare shortened surname is no form, exactly as a bare whole one is not.
    expect(loginFormMatch('dongen', danielle)).toBe('none');
  });
});

// ── What the number in a numbered login says (#1468) ─────────────────────────
//
// Stripping the digits widens who a login can name, and on the reporting tenant
// it widened it onto exactly the wrong person: the directory account
// `p.h.nanhoe2` was attributed to the Priya Nanhoe whose own mailbox is
// `p.h.nanhoe`. Numbering exists to tell those two apart, so the un-numbered
// spelling is the one claim the number rules out — and only that spelling, since
// the login as written may genuinely be somebody's address.
describe('loginSpellings', () => {
  it('reads the login as written before the name a number numbers', () => {
    expect(loginSpellings('svisser2')).toEqual([
      { form: 'svisser2', numbered: false },
      { form: 'svisser', numbered: true },
    ]);
  });

  it('offers only the login itself when it carries no number', () => {
    // Not the token twice: looked up twice, one claimant reads as two.
    expect(loginSpellings('svisser')).toEqual([{ form: 'svisser', numbered: false }]);
  });

  it('offers nothing for an empty login, or one that is nothing but digits', () => {
    expect(loginSpellings('')).toEqual([]);
    expect(loginSpellings(null)).toEqual([]);
    expect(loginSpellings('042')).toEqual([{ form: '042', numbered: false }]);
  });
});

describe('numberedAwayFrom', () => {
  const priya = { displayName: 'Priya Nanhoe', givenName: 'Priya', surname: 'Nanhoe', email: 'p.h.nanhoe@x.com' };
  const numbered = { form: 'phnanhoe', numbered: true };

  it('rules out the person whose own address the un-numbered spelling is', () => {
    // 'p.h.nanhoe2' is not the 'p.h.nanhoe' mailbox owner's account: the number is
    // there precisely to say the two are different people.
    expect(numberedAwayFrom(priya, numbered)).toBe(true);
  });

  it('rules out nobody on the login as written', () => {
    // The same spelling read as the login itself is her address and so her strongest
    // possible claim. Only the digit-stripped fallback is read on narrower terms.
    expect(numberedAwayFrom(priya, { form: 'phnanhoe', numbered: false })).toBe(false);
  });

  it('rules out nobody whose address is merely a form of the same name', () => {
    // Her name reduces to the spelling; her mailbox is not it. A number says nothing
    // about a namesake who does not hold the un-numbered address.
    const other = { displayName: 'Priya Nanhoe', givenName: 'Priya', surname: 'Nanhoe', email: 'priya.nanhoe@x.com' };
    expect(numberedAwayFrom(other, numbered)).toBe(false);
    expect(numberedAwayFrom({ displayName: 'Priya Nanhoe' }, numbered)).toBe(false);
  });

  it('compares the address separator-insensitively, as every login form is', () => {
    // 'adm-x2' against the person whose own address is 'x': the mailbox writes its
    // separators and the login does not, which is the whole reason forms are normalised.
    const sophie = { displayName: 'Sophie van Kleef', surname: 'van Kleef', email: 's.kleef@x.com' };
    expect(numberedAwayFrom(sophie, { form: 'skleef', numbered: true })).toBe(true);
  });
});

// ── Letters with diacritics fold, they do not vanish (#1480) ─────────────────
//
// Both normalisers reduce a name by *deleting* every character outside
// [a-z0-9], so "Doğan" comes out as `doan` and "Daniëlle" as `danille`. One
// side of a comparison is routinely ASCII — a login (`adm-sdogan`), an email
// local part, an ERP export — and a deleted letter is a letter the two
// spellings can never agree on, so the account stays an orphan. Folding each
// letter to its ASCII base is what lets the two meet; the [a-z0-9] strip stays
// as the final guard. Display name against display name hid this, because both
// sides lost the same letters.
//
// The letters come in two kinds and the tests keep them apart: the ones NFKD
// decomposes into a base letter plus a combining mark, and the ones it leaves
// alone (ı, ł, ø, đ, ß, æ, œ, þ, ð), which need naming one by one — so there is
// one discriminating input per mapped letter rather than one name standing in
// for all of them.
describe('diacritic folding (#1480)', () => {
  it('normalizeName folds the letters NFKD decomposes', () => {
    expect(normalizeName('Doğan')).toBe('dogan');       // today: 'doan'
    expect(normalizeName('Daniëlle')).toBe('danielle'); // today: 'danille'
    expect(normalizeName('Ömer')).toBe('omer');         // today: 'mer'
    // Turkish dotted İ: its JS lowercase is 'i' + a combining dot, so the mark
    // has to go while the 'i' it sits on stays.
    expect(normalizeName('İnönü')).toBe('inonu');       // today: 'inn'
  });

  it('normalizeName folds the letters NFKD alone does not decompose', () => {
    expect(normalizeName('Yıldırım')).toBe('yildirim');       // dotless ı — today: 'yldrm'
    expect(normalizeName('Łukasz')).toBe('lukasz');           // ł — today: 'ukasz'
    expect(normalizeName('Møller')).toBe('moller');           // ø — today: 'mller'
    expect(normalizeName('Đorđević')).toBe('dordevic');       // đ — today: 'orevi'
    expect(normalizeName('Großmann')).toBe('grossmann');      // ß → ss — today: 'gromann'
    expect(normalizeName('Æblegaard')).toBe('aeblegaard');    // æ → ae — today: 'blegaard'
    expect(normalizeName('Œuvre')).toBe('oeuvre');            // œ → oe — today: 'uvre'
    expect(normalizeName('Þórsdóttir')).toBe('thorsdottir');  // þ → th — today: 'rsdttir'
    expect(normalizeName('Guðrún')).toBe('gudrun');           // ð → d — today: 'gurun'
  });

  it('normalizeName keeps the separator, digit and suffix rules it always had', () => {
    // Folding is inserted between the lowercase and the [a-z0-9] strip, so
    // everything the strip was there for still happens.
    expect(normalizeName('Sevgi  Doğan-Yıldırım 2')).toBe('sevgidoganyildirim2');
    expect(normalizeName('Sevgi Doğan (Admin)', ['(admin)'])).toBe('sevgidogan');
  });

  it('an ASCII admin login matches the diacritic name it spells', () => {
    // The acceptance criterion. No email on the identity, so nothing but the
    // (folded) name forms can answer for the login.
    const identity = { displayName: 'Furkan Doğan', givenName: 'Furkan', surname: 'Doğan', email: null };
    expect(loginFormMatch(loginToken('adm-fdogan@contoso.com', ['adm-']), identity)).toBe('initial'); // today: 'none'
    expect(loginFormMatch(loginToken('adm-furkandogan@contoso.com', ['adm-']), identity)).toBe('full'); // today: 'none'
  });

  it('folds the login side too, so a diacritic login still reaches its own name', () => {
    // A directory that does spell the login with the letter must keep matching:
    // both sides fold, so the forms meet in the middle rather than one of them
    // moving away from the other.
    const identity = { displayName: 'Furkan Doğan', givenName: 'Furkan', surname: 'Doğan', email: null };
    expect(loginToken('adm-fdoğan@contoso.com', ['adm-'])).toBe('fdogan'); // today: 'fdoan'
    expect(loginFormMatch(loginToken('adm-fdoğan@contoso.com', ['adm-']), identity)).toBe('initial');
  });

  it('an ASCII-spelled account name fully matches the diacritic identity name', () => {
    const level = bestNameMatch(
      nameVariants('Danielle Dongen', '', ''),               // ERP/CSV spelling, no diacritics
      nameVariants('Daniëlle Dongen', 'Daniëlle', 'Dongen'), // HR spelling
    );
    // today: 'surnameInitial' — 45 points, below the 50-point threshold on its own.
    expect(level).toBe('full');
  });

  it('initials fold the same way, so both paths agree on the initial of Ömer', () => {
    // initials.js carries its own copy of the ASCII strip. Left unfolded it
    // contradicts the folded classifier: the name side matches Ömer while the
    // initials signal reads his initial as 'm' and rules him out.
    expect(nameInitials(['Ömer'], 'omer')).toEqual(['o']);           // today: ['m']
    expect(nameVariants('Ömer Doğan', '', '')[0].initial).toBe('o'); // today: 'm'
  });

  it('reads a dotted diacritic initial as the initial it is', () => {
    // 'Ö.R.' is an initials half like 'L.R.' is, and the ERP that writes it
    // carries nothing else to match on (#1455). Unfolded, the dotted-initials
    // test rejects it and the half collapses to a single wrong letter.
    expect(nameInitials(['Ö.R.'], 'or')).toEqual(['o', 'r']); // today: ['r']
    const level = bestNameMatch(
      nameVariants('Doğan, Ö.R.', '', ''),                            // the ERP export
      nameVariants('Ömer Rüstem Doğan', 'Ömer Rüstem', 'Doğan'),      // the identity
    );
    expect(level).toBe('surnameInitials'); // today: 'none'
  });
});
