import { describe, it, expect } from 'vitest';
import { classifyAccount, emailLocalPart, normalizeName, stripKnownPrefixes, parseName, nameMatchLevel, compileAccountTypeRules } from './classifier.js';
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

describe('parseName', () => {
  it('parses "Surname, Given" and strips qualifiers', () => {
    expect(parseName('Euson, Robin (OGD)')).toMatchObject({ given: 'robin', surname: 'euson' });
    expect(parseName('(ADM-azure) Euson, Robin')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
  it('parses "Given Surname"', () => {
    expect(parseName('Robin Euson')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
  it('produces an order-independent key', () => {
    expect(parseName('Euson, Robin').key).toBe(parseName('Robin Euson').key);
  });
  it('falls back to explicit given/surname fields', () => {
    expect(parseName('', 'Robin', 'Euson')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
});

describe('nameMatchLevel', () => {
  const n = (dn) => parseName(dn);
  it('full match on same given + surname despite qualifiers', () => {
    expect(nameMatchLevel(n('Euson, Robin (OGD)'), n('(ADM-azure) Euson, Robin'))).toBe('full');
  });
  it('surnameInitial when only the initial matches', () => {
    expect(nameMatchLevel(parseName('', 'R', 'Euson'), n('Euson, Robin'))).toBe('surnameInitial');
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
