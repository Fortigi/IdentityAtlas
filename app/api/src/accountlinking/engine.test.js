import { describe, it, expect } from 'vitest';
import { scoreMatch, buildLinks, MAX_NAME_ONLY_SUGGESTIONS } from './engine.js';
import { DEFAULT_RULES } from './defaultRules.js';

const identity = { id: 'idy-1', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };

describe('scoreMatch', () => {
  it('links an admin account via email-prefix + full name', () => {
    const orphan = { id: 'p1', displayName: '(ADM-azure) Doe, John', email: 'adm-jdoe@contoso.com' };
    const { confidence, signals } = scoreMatch(orphan, identity, DEFAULT_RULES);
    expect(confidence).toBeGreaterThanOrEqual(70);
    expect(signals).toContain('emailPrefix');
    expect(signals).toContain('fullName');
  });
  it('links on an exact employeeId match', () => {
    const orphan = { id: 'p2', displayName: 'JD', email: 'unrelated@x.com', employeeId: 'E1' };
    const { confidence, signals } = scoreMatch(orphan, identity, DEFAULT_RULES);
    expect(signals).toContain('employeeId');
    expect(confidence).toBeGreaterThanOrEqual(70);
  });
  it('links a different email convention via name only, at lower confidence', () => {
    // robin.euson vs r.euson — emails differ, but the name still matches.
    const idy = { id: 'i', displayName: 'Euson, Robin', email: 'r.euson@por.com' };
    const orphan = { id: 'o', displayName: 'Euson, Robin (OGD)', email: 'robin.euson@ogd.nl' };
    const { confidence, signals } = scoreMatch(orphan, idy, DEFAULT_RULES);
    expect(signals).toEqual(['fullName']);
    expect(confidence).toBe(60); // name-only → honest, lower confidence
  });
  it('caps confidence at 100', () => {
    const orphan = { id: 'p3', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };
    expect(scoreMatch(orphan, identity, DEFAULT_RULES).confidence).toBe(100);
  });
  it('does not match unrelated people', () => {
    const orphan = { id: 'p4', displayName: 'Smith, Jane', email: 'jsmith@contoso.com' };
    expect(scoreMatch(orphan, identity, DEFAULT_RULES).confidence).toBeLessThan(50);
  });
});

describe('buildLinks', () => {
  const EUSON = [{ id: 'euson', displayName: 'Euson, Robin', email: 'r.euson@por.com', employeeId: 'E9' }];
  const EUSON_ORPHANS = [
    // adm-prefixed address shares the identity's email local part → corroborated.
    { id: 'adm', displayName: '(ADM-azure) Euson, Robin', email: 'R.Euson@por.onmicrosoft.com' },
    // robin.euson vs r.euson — the name is the only thing that matches.
    { id: 'ogd', displayName: 'Euson, Robin (OGD)', email: 'robin.euson@ogd.nl' },
    { id: 'admogd', displayName: '(ADM-azure) Euson, Robin (OGD)', email: 'robin.euson@por.onmicrosoft.com' },
    { id: 'svc', displayName: 'svc-backup', email: 'svc-backup@por.com' }, // service → skipped
  ];

  it('links all of a person’s accounts (admin + alternate-domain) when name-only links are allowed', () => {
    const { links } = buildLinks(EUSON_ORPHANS, EUSON, { ...DEFAULT_RULES, allowNameOnlyLinks: true });
    const linkedIds = links.map(l => l.principalId).sort();
    expect(linkedIds).toEqual(['adm', 'admogd', 'ogd']);
    expect(links.every(l => l.identityId === 'euson')).toBe(true);
    // The admin account that shares the email prefix scores highest.
    expect(links.find(l => l.principalId === 'adm').confidence).toBeGreaterThan(
      links.find(l => l.principalId === 'ogd').confidence
    );
  });

  it('links only the corroborated account of that same set under the shipped defaults', () => {
    // The paired case for the test above, on identical input: the two accounts
    // whose ONLY matching signal is the name are held back, the one that also
    // matches on the email prefix still links.
    const { links, stats } = buildLinks(EUSON_ORPHANS, EUSON, DEFAULT_RULES);
    expect(links.map(l => l.principalId)).toEqual(['adm']);
    expect(stats.nameOnlyMatches).toBe(2);
    expect(stats.suggestions.map(s => s.principalId).sort()).toEqual(['admogd', 'ogd']);
  });

  it('does not auto-link an ambiguous name-only match (two identities, same name)', () => {
    const identities = [
      { id: 'a', displayName: 'Jansen, Jan', email: 'jan.jansen@x.com' },
      { id: 'b', displayName: 'Jansen, Jan', email: 'j.jansen@y.com' },
    ];
    const orphan = { id: 'o', displayName: 'Jansen, Jan', email: 'jjansen@z.com' };
    expect(buildLinks([orphan], identities, DEFAULT_RULES).links).toHaveLength(0);
  });

  it('returns nothing when no identity matches', () => {
    const identities = [identity];
    const { links, stats } = buildLinks(
      [{ id: 'p-z', displayName: 'Zee, Zed', email: 'zzee@contoso.com' }], identities, DEFAULT_RULES);
    expect(links).toHaveLength(0);
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });
});

// ── scoreMatch ───────────────────────────────────────────────────────────────
//
// The confidence score that decides whether two accounts are the same person. It had NO
// coverage at all: 23 of its mutants were never even executed by the suite, so every
// signal type, the weighting, and the cap could have been wrong without a single test
// noticing. Both directions are silent -- score too high and one person inherits another's
// access everywhere; score too low and their accounts stay split from a reviewer's view.

describe('scoreMatch - signal types', () => {
  const rules = (signals, extra = {}) => ({ signals, ...extra });

  it('an EXACT signal fires only when both sides carry the same value', () => {
    const r = rules([{ type: 'exact', field: 'employeeId', name: 'employeeId', weight: 60 }]);
    expect(scoreMatch({ employeeId: 'E1' }, { employeeId: 'E1' }, r))
      .toEqual({ confidence: 60, signals: ['employeeId'] });
    expect(scoreMatch({ employeeId: 'E1' }, { employeeId: 'E2' }, r))
      .toEqual({ confidence: 0, signals: [] });
  });

  it('an EXACT signal never fires on two BLANKS', () => {
    // `!!a && a === b`. Without the emptiness check, two accounts that merely both lack an
    // employee id score as a confident match on it -- which is how unrelated people get
    // merged in a tenant where the attribute is optional.
    const r = rules([{ type: 'exact', field: 'employeeId', name: 'employeeId', weight: 60 }]);
    expect(scoreMatch({}, {}, r).confidence).toBe(0);
    expect(scoreMatch({ employeeId: '' }, { employeeId: '' }, r).confidence).toBe(0);
    expect(scoreMatch({ employeeId: '  ' }, { employeeId: '' }, r).confidence).toBe(0);
  });

  it('an EXACT signal normalises case and padding before comparing', () => {
    const r = rules([{ type: 'exact', field: 'employeeId', name: 'employeeId', weight: 60 }]);
    expect(scoreMatch({ employeeId: ' e1 ' }, { employeeId: 'E1' }, r).confidence).toBe(60);
  });

  it('a PREFIX signal strips the admin prefix from the orphan side only', () => {
    // adm-jsmith@corp matches jsmith@corp: the admin account is the orphan, the human is
    // the identity. Stripping the wrong side, or neither, and no admin account ever links.
    const r = rules([{ type: 'prefix', field: 'email', name: 'emailPrefix', weight: 40, stripPrefixes: ['adm-'] }]);
    expect(scoreMatch({ email: 'adm-jsmith@corp.com' }, { email: 'jsmith@corp.com' }, r).confidence).toBe(40);
    expect(scoreMatch({ email: 'adm-jsmith@corp.com' }, { email: 'someone@corp.com' }, r).confidence).toBe(0);
  });

  it('a PREFIX signal never fires on two blanks either', () => {
    const r = rules([{ type: 'prefix', field: 'email', name: 'emailPrefix', weight: 40, stripPrefixes: ['adm-'] }]);
    expect(scoreMatch({}, {}, r).confidence).toBe(0);
  });

  it('a NAME signal fires only at its OWN level', () => {
    // Name signals are mutually exclusive by design: an exact-name match must not also
    // collect the weaker level's weight. Comparing against the wrong level -- or dropping
    // the comparison -- either double-counts a name or silently stops scoring names at all.
    // Levels are the strings nameMatchLevel returns: 'full' (same surname AND given name)
    // or 'surnameInitial' (same surname, given name only agrees on its initial).
    const both = rules([
      { type: 'name', name: 'fullName', level: 'full', weight: 50 },
      { type: 'name', name: 'surnameInitial', level: 'surnameInitial', weight: 10 },
    ]);
    const res = scoreMatch(
      { displayName: 'Alice Smith', givenName: 'Alice', surname: 'Smith' },
      { displayName: 'Alice Smith', givenName: 'Alice', surname: 'Smith' },
      both,
    );
    expect(res.signals).toHaveLength(1);           // exactly one name signal, never both
    expect(res.signals[0]).toBe('fullName');
    expect(res.confidence).toBe(50);
  });

  it('a NAME signal drops to the weaker level when only the initial agrees', () => {
    // A. Smith vs Alice Smith: same surname, given name agrees only on its initial. The
    // weaker signal must fire and the stronger must not -- collapsing the two levels is
    // what turns "probably the same family name" into "confidently the same person".
    const both = rules([
      { type: 'name', name: 'fullName', level: 'full', weight: 50 },
      { type: 'name', name: 'surnameInitial', level: 'surnameInitial', weight: 10 },
    ]);
    const res = scoreMatch(
      { displayName: 'A. Smith', givenName: 'A', surname: 'Smith' },
      { displayName: 'Alice Smith', givenName: 'Alice', surname: 'Smith' },
      both,
    );
    expect(res.signals).toEqual(['surnameInitial']);
    expect(res.confidence).toBe(10);
  });

  it('a NAME signal fires for nobody when the surnames differ', () => {
    const both = rules([{ type: 'name', name: 'fullName', level: 'full', weight: 50 }]);
    expect(scoreMatch(
      { displayName: 'Alice Smith', givenName: 'Alice', surname: 'Smith' },
      { displayName: 'Alice Jones', givenName: 'Alice', surname: 'Jones' },
      both,
    )).toEqual({ confidence: 0, signals: [] });
  });

  it('a FUZZY signal falls back to givenName + surname when displayName is absent', () => {
    const r = rules([{ type: 'fuzzy', field: 'displayName', name: 'fuzzyName', weight: 30, stripSuffixes: ['(admin)'] }]);
    expect(scoreMatch(
      { givenName: 'Alice', surname: 'Smith' },
      { displayName: 'Alice Smith' }, r,
    ).confidence).toBe(30);
  });

  it('a FUZZY signal strips the configured suffix before comparing', () => {
    const r = rules([{ type: 'fuzzy', field: 'displayName', name: 'fuzzyName', weight: 30, stripSuffixes: ['(admin)'] }]);
    expect(scoreMatch(
      { displayName: 'Alice Smith (Admin)' },
      { displayName: 'Alice Smith' }, r,
    ).confidence).toBe(30);
  });

  it('ignores a signal type it does not understand', () => {
    expect(scoreMatch({ email: 'a@x' }, { email: 'a@x' }, rules([{ type: 'telepathy', name: 't', weight: 99 }])))
      .toEqual({ confidence: 0, signals: [] });
  });
});

describe('scoreMatch - totalling', () => {
  it('adds the weights of every signal that fired', () => {
    const r = {
      signals: [
        { type: 'exact', field: 'employeeId', name: 'employeeId', weight: 60 },
        { type: 'exact', field: 'email', name: 'email', weight: 30 },
      ],
    };
    const res = scoreMatch({ employeeId: 'E1', email: 'a@x' }, { employeeId: 'E1', email: 'a@x' }, r);
    expect(res.confidence).toBe(90);
    expect(res.signals.sort()).toEqual(['email', 'employeeId']);
  });

  it('treats a weightless signal as contributing nothing but still names it', () => {
    // `sig.weight || 0` -- a rule written without a weight must not throw or add NaN,
    // which would poison the total and make every later comparison false.
    const r = { signals: [{ type: 'exact', field: 'employeeId', name: 'noWeight' }] };
    const res = scoreMatch({ employeeId: 'E1' }, { employeeId: 'E1' }, r);
    expect(res.confidence).toBe(0);
    expect(res.signals).toEqual(['noWeight']);
  });

  it('caps the confidence at 100 however many signals fire', () => {
    // Confidence is presented as a percentage and compared against a threshold; 130 would
    // render as a nonsense bar and make the threshold meaningless.
    const r = {
      signals: [
        { type: 'exact', field: 'employeeId', name: 'a', weight: 70 },
        { type: 'exact', field: 'email', name: 'b', weight: 60 },
      ],
    };
    expect(scoreMatch({ employeeId: 'E1', email: 'x@y' }, { employeeId: 'E1', email: 'x@y' }, r).confidence).toBe(100);
  });

  it('scores nothing for a rule set with no signals', () => {
    expect(scoreMatch({ employeeId: 'E1' }, { employeeId: 'E1' }, {})).toEqual({ confidence: 0, signals: [] });
  });
});

// ── buildLinks: which candidate wins, and when to refuse ─────────────────────
//
// This is where a decision actually gets made. Refusing to link is the safe answer and
// linking the wrong identity is the dangerous one, so the guards below matter more than
// the happy path they surround.

describe('buildLinks - selection and thresholds', () => {
  const rules = (over = {}) => ({
    signals: [
      { name: 'employeeId', type: 'exact', field: 'employeeId', weight: 95 },
      { name: 'fullName', type: 'name', level: 'full', weight: 60 },
    ],
    linkThreshold: 50,
    onlyLinkTypes: ['Secondary', 'Admin'],
    accountTypeRules: [{ accountType: 'Admin', priority: 1, patterns: ['^adm-'] }],
    // These cases are about which candidate wins at which threshold, so the
    // corroboration guard is opted out of here and tested on its own below.
    allowNameOnlyLinks: true,
    ...over,
  });

  const person = (id, dn, extra = {}) => ({ id, displayName: dn, ...extra });

  it('links a candidate sitting EXACTLY on the threshold', () => {
    // `confidence < threshold` continues. Read as <=, a score equal to the threshold is
    // rejected -- and the threshold is a slider an admin sets, so "60 or better" quietly
    // becoming "better than 60" changes who links with no visible cause.
    const r = rules({ linkThreshold: 60 });
    const { links } = buildLinks(
      [person('p1', 'John Doe')],
      [person('i1', 'John Doe')],
      r,
    );
    expect(links).toHaveLength(1);
    expect(links[0].confidence).toBe(60);
  });

  it('refuses a candidate just under the threshold', () => {
    const r = rules({ linkThreshold: 61 });
    expect(buildLinks([person('p1', 'John Doe')], [person('i1', 'John Doe')], r).links).toHaveLength(0);
  });

  it('falls back to the shipped threshold when the rule set omits one', () => {
    // `rules.linkThreshold ?? DEFAULT_RULES.linkThreshold` -- this used to fall back to a
    // hard-coded 70, a second source of truth for a default that is 50. Two custom
    // non-name signals summing to 60 discriminate: they link under 50 and not under 70.
    const r = {
      signals: [
        { name: 'dept', type: 'exact', field: 'department', weight: 30 },
        { name: 'office', type: 'exact', field: 'officeLocation', weight: 30 },
      ],
      onlyLinkTypes: ['Secondary'],
      accountTypeRules: [],
    };
    const pair = { department: 'IT', officeLocation: 'Utrecht', displayName: 'Ann Jones' };
    const { links } = buildLinks([{ id: 'p1', ...pair }], [{ id: 'i1', ...pair }], r);
    expect(links).toHaveLength(1);
    expect(links[0].confidence).toBe(60);
    expect(DEFAULT_RULES.linkThreshold).toBe(50); // the single source of that default
  });

  it('takes the HIGHEST scoring candidate, not the first one seen', () => {
    // Candidates are scored in insertion order, so the better match is listed SECOND on
    // purpose: without the > comparison the first plausible identity wins and the person
    // is linked to the weaker match.
    const r = rules();
    const { links } = buildLinks(
      [person('p1', 'John Doe', { employeeId: 'E1' })],
      [person('i-weak', 'John Doe'), person('i-strong', 'John Doe', { employeeId: 'E1' })],
      r,
    );
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('i-strong');
    expect(links[0].confidence).toBe(100);   // 95 + 60, clamped by the cap
  });

  it('refuses an account type outside onlyLinkTypes', () => {
    // Service and Shared accounts are deliberately left unlinked. Read as "always link",
    // a shared mailbox is attached to whichever person its name resembles.
    const r = rules({
      onlyLinkTypes: ['Secondary'],
      accountTypeRules: [{ accountType: 'Service', priority: 1, patterns: ['^svc-'] }],
    });
    const { links, stats } = buildLinks([person('p1', 'svc-john doe')], [person('i1', 'John Doe')], r);
    expect(links).toHaveLength(0);
    expect(stats.nameOnlyMatches).toBe(0); // never scored, so never counted either
  });
});

describe('buildLinks - the ambiguity guard', () => {
  // Name-only matches are allowed here so the TIE guard is what the cases turn on;
  // the corroboration guard gets its own block below.
  const nameOnlyRules = {
    signals: [
      { name: 'employeeId', type: 'exact', field: 'employeeId', weight: 95 },
      { name: 'fullName', type: 'name', level: 'full', weight: 60 },
    ],
    linkThreshold: 50,
    onlyLinkTypes: ['Secondary'],
    accountTypeRules: [],
    allowNameOnlyLinks: true,
  };

  it('refuses a NAME-ONLY match that ties across two identities', () => {
    // Two different people who genuinely share a name. Linking either one merges two
    // humans, and the tie means there is no evidence to prefer one -- so the safe answer
    // is to leave it orphan for review. This guard is the difference between "we do not
    // know" and a confident wrong answer.
    const { links, stats } = buildLinks(
      [{ id: 'p1', displayName: 'John Doe' }],
      [{ id: 'i1', displayName: 'John Doe' }, { id: 'i2', displayName: 'John Doe' }],
      nameOnlyRules,
    );
    expect(links).toHaveLength(0);
    // Dropped by the tie guard, but still a name-only match that cleared the
    // threshold -- so it is counted once and carries its tie count for review.
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions).toHaveLength(1);
    expect(stats.suggestions[0].ties).toBe(2);
  });

  it('links a NAME-ONLY match when there is exactly one candidate', () => {
    // The paired case: the guard must fire on ambiguity, not on name matches generally.
    const { links, stats } = buildLinks(
      [{ id: 'p1', displayName: 'John Doe' }],
      [{ id: 'i1', displayName: 'John Doe' }],
      nameOnlyRules,
    );
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('i1');
    expect(stats.suggestions[0].ties).toBe(1); // one candidate → no ambiguity
  });

  it('links a tie that rests on a STRONG signal, not just a name', () => {
    // Same tie, but both candidates share the employee id -- that is a deliberate data
    // duplicate, not two people who happen to share a name, so the guard must not fire.
    const { links, stats } = buildLinks(
      [{ id: 'p1', displayName: 'John Doe', employeeId: 'E1' }],
      [
        { id: 'i1', displayName: 'John Doe', employeeId: 'E1' },
        { id: 'i2', displayName: 'John Doe', employeeId: 'E1' },
      ],
      nameOnlyRules,
    );
    expect(links).toHaveLength(1);
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('links when nothing matched at all only if above threshold - otherwise stays orphan', () => {
    expect(buildLinks(
      [{ id: 'p1', displayName: 'Nobody Here' }],
      [{ id: 'i1', displayName: 'Someone Else' }],
      nameOnlyRules,
    ).links).toHaveLength(0);
  });
});

// ── buildLinks: the corroboration guard ──────────────────────────────────────
//
// A name is not evidence enough on its own. Where the tie guard above only fires when two
// identities score IDENTICALLY, this one fires on the single-candidate case the tie guard
// cannot see: the real owner's name is spelled a little differently, a namesake matches
// cleanly, and the account is handed to the wrong person with no indication it rested on
// one signal. Every wrong link in the measured dataset behind #1440 was this case.

describe('buildLinks - the corroboration guard', () => {
  const rules = (over = {}) => ({
    signals: [
      { name: 'employeeId', type: 'exact', field: 'employeeId', weight: 95 },
      { name: 'email', type: 'exact', field: 'email', weight: 90 },
      { name: 'fullName', type: 'name', level: 'full', weight: 60 },
      { name: 'surnameInitial', type: 'name', level: 'surnameInitial', weight: 45 },
    ],
    linkThreshold: 50,
    onlyLinkTypes: ['Secondary'],
    accountTypeRules: [],
    ...over,
  });

  const JOHN = { id: 'i1', displayName: 'John Doe', email: 'john.doe@corp.com', employeeId: 'E1' };

  it('holds back a name-only match and records what it nearly linked', () => {
    const orphan = { id: 'p1', displayName: 'John Doe', email: 'jd2@elsewhere.com' };
    const { links, stats } = buildLinks([orphan], [JOHN], rules());

    expect(links).toHaveLength(0);
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions).toEqual([{
      principalId: 'p1',
      displayName: 'John Doe',
      identityId: 'i1',
      identityName: 'John Doe',
      confidence: 60,
      signals: ['fullName'],
      accountType: 'Secondary',
      ties: 1,
    }]);
  });

  it('links the very same match when the tenant opts back in', () => {
    // The paired case on identical input: allowNameOnlyLinks is the whole difference, and
    // the match is STILL counted -- the run reports what it linked on a name alone.
    const orphan = { id: 'p1', displayName: 'John Doe', email: 'jd2@elsewhere.com' };
    const { links, stats } = buildLinks([orphan], [JOHN], rules({ allowNameOnlyLinks: true }));

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'i1', confidence: 60, signals: ['fullName'] });
    expect(stats.nameOnlyMatches).toBe(1);
  });

  it('treats only a literal true as opting in', () => {
    // `=== true`. A config that stored the string "false", or 0, must not read as
    // permission to link -- the safe default has to survive a sloppy value.
    for (const value of ['false', 'true', 1, 0, null, undefined, {}]) {
      const { links } = buildLinks(
        [{ id: 'p1', displayName: 'John Doe' }], [JOHN], rules({ allowNameOnlyLinks: value }));
      expect(links).toHaveLength(0);
    }
  });

  it('links a name match that is corroborated by an email match', () => {
    // Two signals, one of them not a name → the guard must not fire. Measured on the
    // dataset behind #1440, no link combining a name with an email or employeeId was wrong.
    const orphan = { id: 'p1', displayName: 'John Doe', email: 'john.doe@corp.com' };
    const { links, stats } = buildLinks([orphan], [JOHN], rules());

    expect(links).toHaveLength(1);
    expect(links[0].confidence).toBe(100);           // 90 + 60, capped
    expect(links[0].signals).toEqual(['email', 'fullName']);
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('links on a strong signal alone, with no name agreement at all', () => {
    const orphan = { id: 'p1', displayName: 'J.D. (service desk)', employeeId: 'E1' };
    const { links, stats } = buildLinks([orphan], [JOHN], rules());

    expect(links.map(l => l.signals)).toEqual([['employeeId']]);
    expect(stats.nameOnlyMatches).toBe(0);
  });

  it('does not count a name match that never cleared the threshold', () => {
    // surnameInitial alone scores 45 against a threshold of 50. It was already not
    // linking; counting it would inflate "held for review" with matches nobody held.
    const orphan = { id: 'p1', displayName: 'J. Doe', givenName: 'J', surname: 'Doe' };
    const idy = { id: 'i1', displayName: 'John Doe', givenName: 'John', surname: 'Doe' };
    const { links, stats } = buildLinks([orphan], [idy], rules());

    expect(links).toHaveLength(0);
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('counts every name-only match but caps the stored list', () => {
    // The count is the true number; the list is capped so one run cannot write an
    // unbounded document onto its row.
    const identities = [];
    const orphans = [];
    for (let i = 0; i < MAX_NAME_ONLY_SUGGESTIONS + 7; i++) {
      identities.push({ id: `i${i}`, displayName: `Person${i} Surname${i}` });
      orphans.push({ id: `p${i}`, displayName: `Person${i} Surname${i}` });
    }
    const { links, stats } = buildLinks(orphans, identities, rules());

    expect(links).toHaveLength(0);
    expect(stats.nameOnlyMatches).toBe(MAX_NAME_ONLY_SUGGESTIONS + 7);
    expect(stats.suggestions).toHaveLength(MAX_NAME_ONLY_SUGGESTIONS);
  });

  it('counts nothing for an empty tenant', () => {
    expect(buildLinks([], [], rules())).toEqual({ links: [], stats: { nameOnlyMatches: 0, suggestions: [] } });
  });

  it('holds back a match resting only on a legacy FUZZY name signal', () => {
    // `fuzzy` is the legacy single-signal name comparison, so a match resting only on it
    // is exactly as uncorroborated as a `fullName`-only one.
    const fuzzyRules = {
      signals: [{ name: 'fuzzyName', type: 'fuzzy', field: 'displayName', weight: 60 }],
      linkThreshold: 50,
      onlyLinkTypes: ['Secondary'],
      accountTypeRules: [],
    };
    const { links, stats } = buildLinks(
      [{ id: 'p1', displayName: 'John Doe' }], [{ id: 'i1', displayName: 'John Doe' }], fuzzyRules);

    expect(links).toHaveLength(0);
    expect(stats.suggestions[0].signals).toEqual(['fuzzyName']);
  });
});

// The #1439 cases below are about how a name is matched and how a name tie is
// resolved, so they opt in to name-only links and read the links alone. Under
// the corroboration guard (the default) every one of these name-only matches is
// held for review instead -- the last block covers that interaction.
const NAME_ONLY_RULES = { ...DEFAULT_RULES, allowNameOnlyLinks: true };
const linksFor = (orphans, identities, rules) => buildLinks(orphans, identities, rules).links;

// ── Titled HR display names (#1439) ──────────────────────────────────────────
//
// The reporter-visible symptom of the name-parsing defect, through the default
// rules: an account belonging to someone whose HR display name carries a title
// is attached to an untitled namesake, while its real owner shows no accounts.

describe('buildLinks - owners with a titled display name (#1439)', () => {
  const titledOwner = {
    id: 'owner', displayName: 'Jan de Vries MSc', givenName: 'Jan', surname: 'de Vries',
    email: 'jan.devries@corp.example', employeeId: 'E100',
  };
  // An account from a system that carries neither address nor employee id, so the
  // name signals are the only evidence there is.
  const orphan = { id: 'p1', displayName: 'Jan de Vries', email: null, employeeId: null };

  it('links the orphan account to its titled owner', () => {
    const links = linksFor([orphan], [titledOwner], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'owner', signals: ['fullName'] });
    expect(links[0].confidence).toBe(60); // name-only evidence, reported honestly
  });

  it('leaves a genuine namesake tie for review instead of picking the untitled one', () => {
    // Both people really are called Jan de Vries. Today only the untitled one is even
    // found, so the account is confidently attached to the wrong person; once both are
    // candidates the existing ambiguity guard correctly declines to guess.
    const identities = [
      titledOwner,
      {
        id: 'namesake', displayName: 'Jan de Vries', givenName: 'Jan', surname: 'de Vries',
        email: 'j.devries@corp.example', employeeId: 'E200',
      },
    ];
    expect(linksFor([orphan], identities, NAME_ONLY_RULES)).toHaveLength(0);
  });

  it('still links the namesake when a strong signal breaks the tie', () => {
    // The paired case: the guard must only fire on name-only evidence.
    const identities = [
      titledOwner,
      {
        id: 'namesake', displayName: 'Jan de Vries', givenName: 'Jan', surname: 'de Vries',
        email: 'j.devries@corp.example', employeeId: 'E200',
      },
    ];
    const withId = { ...orphan, employeeId: 'E200' };
    const links = linksFor([withId], identities, NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('namesake');
  });

  it('does not link an account whose surname only shares the particle tail', () => {
    // 'van der Steen' and 'Schilder-van der Steen' are two families.
    const identities = [{
      id: 'schilder', displayName: 'Lisa Schilder-van der Steen',
      givenName: 'Lisa', surname: 'Schilder-van der Steen', email: 'l.schilder@corp.example',
    }];
    expect(linksFor(
      [{ id: 'p2', displayName: 'Lisa van der Steen', email: null, employeeId: null }],
      identities, NAME_ONLY_RULES,
    )).toHaveLength(0);
  });
});

// ── Birth surname vs name in use (#1439) ─────────────────────────────────────
//
// HR sources keep the BIRTH surname in the `surname` column while the display
// name — and the accounts provisioned from it — carry the name in use: a partner
// name or a double name. Reading the columns instead of the display name fixed
// the title mis-parse but unlinked these people instead, which is the larger
// population by far. Both names are now indexed, and ties are weighed per name.

describe('buildLinks - an owner whose birth surname differs from her name in use (#1439)', () => {
  // Born "de Wit", known as "Bakker-de Wit". HR writes the birth name in the
  // column and the name in use in the display name; her accounts carry the latter.
  const owner = {
    id: 'owner', displayName: 'Anna Bakker-de Wit', givenName: 'Anna', surname: 'de Wit',
    email: 'anna.dewit@corp.example', employeeId: 'E300',
  };
  // A different person who shares only the birth surname.
  const namesake = {
    id: 'namesake', displayName: 'Anna de Wit', givenName: 'Anna', surname: 'de Wit',
    email: 'a.dewit@corp.example', employeeId: 'E301',
  };
  // No address and no employee id, so the name is the only evidence there is.
  const account = (id, displayName, extra = {}) =>
    ({ id, displayName, email: null, employeeId: null, ...extra });

  it('links an account that carries the NAME IN USE', () => {
    // The regression: indexed under the column alone she is known only as
    // "Anna de Wit", her own account matches nobody, and it stays orphaned.
    const links = linksFor([account('p1', 'Anna Bakker-de Wit')], [owner], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'owner', signals: ['fullName'] });
    expect(links[0].confidence).toBe(60);
  });

  it('still links an account that carries the BIRTH surname', () => {
    // The paired case, and the reason the columns are read at all: a system fed
    // from the HR columns spells her the old way.
    const links = linksFor([account('p2', 'Anna de Wit')], [owner], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('owner');
  });

  it('places an account carrying BOTH spellings on the one person called that', () => {
    // An account provisioned from HR has the birth surname in its column and the
    // name in use in its display name, so it matches both people and ties at 60.
    // Read across the whole candidate set that tie sends it to review; read per
    // name, only one person is called "Bakker-de Wit" and she gets it.
    const orphan = account('p3', 'Anna Bakker-de Wit', { givenName: 'Anna', surname: 'de Wit' });
    const links = linksFor([orphan], [owner, namesake], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('owner');
  });

  it('places it there whichever order the identities arrive in', () => {
    // Candidates are scored in index order and the first of an equal pair wins,
    // which says nothing about who the account belongs to. Resolved from that
    // winner alone, this same account would land on the namesake instead.
    const orphan = account('p3', 'Anna Bakker-de Wit', { givenName: 'Anna', surname: 'de Wit' });
    const links = linksFor([orphan], [namesake, owner], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('owner');
  });

  it('gives an account spelled with the shared name to the person called that', () => {
    // "Anna de Wit" is the namesake's name in use and only the owner's birth
    // surname, so the two claims to it are not equal: the directory named this
    // account after the person who goes by it.
    const links = linksFor([account('p4', 'Anna de Wit')], [owner, namesake], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('namesake');
  });

  it('does not link an account that carries only half of the double name', () => {
    // Widening the names a person is indexed under must not widen what matches:
    // "Anna Bakker" is neither of her names.
    expect(linksFor([account('p5', 'Anna Bakker')], [owner, namesake], NAME_ONLY_RULES))
      .toHaveLength(0);
  });

  it('keeps linking a titled display name, which is what #1439 fixed first', () => {
    // The two halves of the issue have to hold at once: the title strip is still
    // in force while the columns are no longer the only source.
    const titled = {
      id: 'titled', displayName: 'Jan de Vries MSc', givenName: 'Jan', surname: 'de Vries',
      email: 'jan.devries@corp.example', employeeId: 'E100',
    };
    const links = linksFor([account('p6', 'Jan de Vries')], [titled], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('titled');
  });
});

// ── A birth surname must not tie up a plain directory account (#1439) ────────
//
// Indexing the birth-name variant puts a second person under a name key that
// used to hold one. An ordinary directory account — a display name and nothing
// else — then matches two identities, ties, and goes to review although it was
// linked correctly before. The two claims to that key are not equal: the account
// is named after the name in use, so the person who is actually called that gets
// it and the one who only carries it as a birth surname does not block her.

describe('buildLinks - a birth surname does not tie up a name that is unique in use (#1439)', () => {
  // She is called Jansen and her accounts are spelled that way.
  const owner = {
    id: 'owner', displayName: 'Anna Jansen', givenName: 'Anna', surname: 'Jansen',
    email: 'anna.jansen@corp.example', employeeId: 'E400',
  };
  // Someone else entirely, known as "de Boer-Jansen"; HR still records her birth
  // surname "Jansen" in the column, which is what puts her under 'jansen|anna'.
  const otherFamily = {
    id: 'other', displayName: 'Anna de Boer-Jansen', givenName: 'Anna', surname: 'Jansen',
    email: 'anna.deboer@corp.example', employeeId: 'E401',
  };
  // A directory account with no address and no employee id: the name is all the
  // evidence there is, which is the condition that makes this a tie at all.
  const account = { id: 'p1', displayName: 'Anna Jansen', email: null, employeeId: null };

  it('links the account to the identity whose name in use it carries', () => {
    const links = linksFor([account], [owner, otherFamily], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'owner', signals: ['fullName'] });
    expect(links[0].confidence).toBe(60);
  });

  it('links it there whichever order the identities arrive in', () => {
    const links = linksFor([account], [otherFamily, owner], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('owner');
  });

  it('links it exactly as it would with the other family absent', () => {
    // The point of the fix stated as the regression it is: adding a person who
    // merely used to be called Jansen must not change this account's outcome.
    expect(linksFor([account], [owner, otherFamily], NAME_ONLY_RULES))
      .toEqual(linksFor([account], [owner], NAME_ONLY_RULES));
  });

  it('still refuses when both of them are really called Jansen', () => {
    // The ambiguity guard is untouched for the case it exists for: two people
    // who both go by the name, and nothing to choose between them.
    const twin = { ...otherFamily, displayName: 'Anna Jansen' };
    expect(linksFor([account], [owner, twin], NAME_ONLY_RULES)).toHaveLength(0);
  });

  it('still refuses when the name is a birth surname for both of them', () => {
    // Neither goes by Jansen now, so neither has the stronger claim to this
    // account and it is left for an analyst.
    const alsoBorn = { ...owner, displayName: 'Anna Bakker-Jansen' };
    expect(linksFor([account], [alsoBorn, otherFamily], NAME_ONLY_RULES)).toHaveLength(0);
  });

  it('still links the other family’s own account', () => {
    // The paired positive: preferring the name in use must not cost the person
    // whose name it is not — her own account is spelled her way.
    const hers = { id: 'p2', displayName: 'Anna de Boer-Jansen', email: null, employeeId: null };
    const links = linksFor([hers], [owner, otherFamily], NAME_ONLY_RULES);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('other');
  });
});

describe('buildLinks - a per-name tie under the corroboration guard (#1439 x #1440)', () => {
  const owner = {
    id: 'owner', displayName: 'Anna Jansen', givenName: 'Anna', surname: 'Jansen',
    email: 'anna.jansen@corp.example', employeeId: 'E400',
  };
  const otherFamily = {
    id: 'other', displayName: 'Anna de Boer-Jansen', givenName: 'Anna', surname: 'Jansen',
    email: 'anna.deboer@corp.example', employeeId: 'E401',
  };
  const account = { id: 'p1', displayName: 'Anna Jansen', email: null, employeeId: null };

  it('holds a tie the name resolves for review, suggesting the person it resolved to', () => {
    // Per-name resolution settles who the account belongs to, but the evidence is
    // still a name alone, so the default guard must not turn it into a link. The
    // suggestion names the resolved owner -- not whichever tied identity was
    // scored first -- and carries no ambiguity, because none is left.
    const { links, stats } = buildLinks([account], [otherFamily, owner], DEFAULT_RULES);
    expect(links).toHaveLength(0);
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions).toHaveLength(1);
    expect(stats.suggestions[0]).toMatchObject({ identityId: 'owner', identityName: 'Anna Jansen', ties: 1 });
  });

  it('reports the tie count when no name singles anyone out', () => {
    // The paired case: two people who both go by the name stay ambiguous, and the
    // suggestion says so.
    const twin = { ...owner, id: 'twin', employeeId: 'E402', email: 'a.jansen@corp.example' };
    const { links, stats } = buildLinks([account], [owner, twin], DEFAULT_RULES);
    expect(links).toHaveLength(0);
    expect(stats.suggestions[0].ties).toBe(2);
  });
});
