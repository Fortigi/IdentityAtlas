import { describe, it, expect } from 'vitest';
import { scoreMatch, buildLinks, MAX_NAME_ONLY_SUGGESTIONS, MAX_NAME_ONLY_RIVALS } from './engine.js';
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

  it('links all of a person’s accounts (admin + alternate-domain) under the shipped defaults', () => {
    // Nobody else in this tenant is called Euson, so the two accounts that match
    // on the name alone are hers and link — a source carrying nothing but display
    // names depends on exactly this.
    const { links, stats } = buildLinks(EUSON_ORPHANS, EUSON, DEFAULT_RULES);
    const linkedIds = links.map(l => l.principalId).sort();
    expect(linkedIds).toEqual(['adm', 'admogd', 'ogd']);
    expect(links.every(l => l.identityId === 'euson')).toBe(true);
    // The admin account that shares the email prefix scores highest.
    expect(links.find(l => l.principalId === 'adm').confidence).toBeGreaterThan(
      links.find(l => l.principalId === 'ogd').confidence
    );
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('links only the corroborated account of that same set when a name is never enough', () => {
    // The paired case on identical input: `allowNameOnlyLinks: false` is a tenant
    // asking for a second signal on every link, so the two accounts whose ONLY
    // matching signal is the name are held back and the email-prefix one links.
    const { links, stats } = buildLinks(EUSON_ORPHANS, EUSON, { ...DEFAULT_RULES, allowNameOnlyLinks: false });
    expect(links.map(l => l.principalId)).toEqual(['adm']);
    expect(stats.nameOnlyMatches).toBe(2);
    expect(stats.suggestions.map(s => s.principalId).sort()).toEqual(['admogd', 'ogd']);
  });

  it('still links them when the only other Euson merely shares Robin’s initial', () => {
    // The same two accounts, same rules as the first case, plus a second Euson whose
    // given name happens to start with an R. "Euson, Robin" is still the spelling of
    // exactly one person, and Rachel is no competing answer to a name she is not
    // called — holding these back cost the link for no gain (#1460).
    const nearNamesake = [...EUSON, { id: 'rachel', displayName: 'Euson, Rachel', email: 'rachel.euson@por.com' }];
    const { links, stats } = buildLinks(EUSON_ORPHANS, nearNamesake, DEFAULT_RULES);
    expect(links.map(l => l.principalId).sort()).toEqual(['adm', 'admogd', 'ogd']);
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('holds back the name-only accounts of a person with a real namesake', () => {
    // The paired case on the same input: a second person who really is called "Euson,
    // Robin". Now the name does not say which of them these accounts belong to, so
    // they go to review while the one corroborated by the email prefix still links.
    const namesake = [...EUSON, { id: 'robin2', displayName: 'Euson, Robin', email: 'r.euson.2@por.com' }];
    const { links, stats } = buildLinks(EUSON_ORPHANS, namesake, DEFAULT_RULES);
    expect(links.map(l => l.principalId)).toEqual(['adm']);
    expect(stats.suggestions.map(s => s.principalId).sort()).toEqual(['admogd', 'ogd']);
    expect(stats.suggestions[0].reason).toBe('ambiguousName');
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

describe('buildLinks - the name-uniqueness guard', () => {
  const nameOnlyRules = {
    signals: [
      { name: 'employeeId', type: 'exact', field: 'employeeId', weight: 95 },
      { name: 'fullName', type: 'name', level: 'full', weight: 60 },
    ],
    linkThreshold: 50,
    onlyLinkTypes: ['Secondary'],
    accountTypeRules: [],
  };

  it('refuses a NAME-ONLY match that two identities answer to', () => {
    // Two different people who genuinely share a name. Linking either one merges two
    // humans, and the shared name is no evidence of which -- so the safe answer is to
    // leave it orphan for review. This guard is the difference between "we do not know"
    // and a confident wrong answer.
    const { links, stats } = buildLinks(
      [{ id: 'p1', displayName: 'John Doe' }],
      [{ id: 'i1', displayName: 'John Doe' }, { id: 'i2', displayName: 'John Doe' }],
      nameOnlyRules,
    );
    expect(links).toHaveLength(0);
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions).toHaveLength(1);
    expect(stats.suggestions[0]).toMatchObject({
      reason: 'ambiguousName',
      rivals: [{ identityId: 'i2', identityName: 'John Doe' }],
      rivalCount: 1,
    });
  });

  it('links a NAME-ONLY match that only one identity answers to', () => {
    // The paired case: the guard must fire on ambiguity, not on name matches generally.
    // A linked match is not a suggestion -- the card lists what needs an analyst.
    const { links, stats } = buildLinks(
      [{ id: 'p1', displayName: 'John Doe' }],
      [{ id: 'i1', displayName: 'John Doe' }],
      nameOnlyRules,
    );
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('i1');
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
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

  it('refuses to link the identity a name singles out when the score ranks it lower', () => {
    // This account carries two names: its display name is a 60-point match for a name
    // two identities answer to, while its HR columns single out a third identity at 45.
    // A name that singles out somebody the score does not rank first settles nothing --
    // linking her would attach the account to a weaker match than the engine's own best
    // candidate -- so it goes to review, suggesting the best candidate.
    const graded = { ...nameOnlyRules, linkThreshold: 40, signals: [
      ...nameOnlyRules.signals,
      { name: 'surnameInitial', type: 'name', level: 'surnameInitial', weight: 45 },
    ] };
    const { links, stats } = buildLinks(
      [{ id: 'p1', displayName: 'John Doe', givenName: 'Wim', surname: 'Bakker', email: 'wim.bakker@x.com' }],
      [
        { id: 'shared1', displayName: 'John Doe' },
        { id: 'shared2', displayName: 'John Doe' },
        // Reached as a candidate through the email index, and scored on her name alone.
        { id: 'willem', displayName: 'Willem Bakker', email: 'wim.bakker@y.com' },
      ],
      graded,
    );
    expect(links).toHaveLength(0);
    expect(stats.suggestions[0]).toMatchObject({
      identityId: 'shared1', confidence: 60, reason: 'ambiguousName',
    });
  });
});

// ── buildLinks: a near-identical namesake (#1440, as scoped by #1460) ────────
//
// The case a tie between top-scoring candidates cannot see: the real owner's name is
// spelled a little differently, so she scores BELOW the candidate who matches cleanly and
// never ties with him. Reading the name at the surname + given initial level as well is
// what finds her — but only where the account is an exact match for nobody. An account
// somebody IS spelled is that person's, and a near spelling is not a rival to it (#1460).
//
// (The wrong links measured behind #1440 were classified afterwards: all 44 were the
// titled/particle class #1443 fixed — a plain account whose owner's record carries a
// title — and none was a short form like Jan for Johannes. Titles strip before keying, so
// those still tie at the exact level and are still held; see the #1460 suite below.)

describe('buildLinks - a near-identical namesake (#1440, as scoped by #1460)', () => {
  const rules = (over = {}) => ({
    signals: [
      { name: 'email',    type: 'exact', field: 'email', weight: 90 },
      { name: 'fullName', type: 'name',  level: 'full',  weight: 60 },
    ],
    linkThreshold: 50,
    onlyLinkTypes: ['Secondary'],
    accountTypeRules: [],
    ...over,
  });

  // The account is named after one spelling of a given name; the tenant holds two people
  // whose given names share its initial. Only ONE of them is an above-threshold match.
  const account = { id: 'p1', displayName: 'Jan Jansen', email: null };
  const jan = { id: 'jan', displayName: 'Jan Jansen', email: 'jan.jansen@corp.example' };
  const johannes = { id: 'johannes', displayName: 'Johannes Jansen', email: 'johannes.jansen@corp.example' };

  it('links the clean match although a near-identical name stands behind it', () => {
    // Johannes may be a plausible owner of a "Jan Jansen" account, but Jan is the one
    // actually spelled that — and on the reporter's dataset refusing every such match
    // cost ~1,700 correct links per run for no measured wrong link avoided (#1460).
    const { links, stats } = buildLinks([account], [jan, johannes], rules());
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'jan', confidence: 60, signals: ['fullName'] });
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('holds the same match back once a second person is spelled the name too', () => {
    // The paired case on identical input bar one identity, and the protection that does
    // survive: two people really are called "Jan Jansen", so the name settles nothing.
    const twin = { id: 'twin', displayName: 'Jan Jansen', email: 'j.jansen@corp.example' };
    const { links, stats } = buildLinks([account], [jan, twin, johannes], rules());
    expect(links).toHaveLength(0);
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions[0]).toMatchObject({
      identityId: 'jan',
      confidence: 60,
      reason: 'ambiguousName',
      // Johannes is not named: he does not answer to the name this match rests on.
      rivals: [{ identityId: 'twin', identityName: 'Jan Jansen' }],
      rivalCount: 1,
    });
  });

  it('links it despite a namesake when a second signal corroborates it', () => {
    // The guard only ever applies to a match resting on the name alone.
    const twin = { id: 'twin', displayName: 'Jan Jansen', email: 'j.jansen@corp.example' };
    const corroborated = { ...account, email: 'jan.jansen@corp.example' };
    const { links } = buildLinks([corroborated], [jan, twin], rules());
    expect(links.map(l => l.identityId)).toEqual(['jan']);
  });

  it('records the match even when neither the account nor the rival has a display name', () => {
    // A source that fills the structured columns and leaves displayName empty is
    // ordinary. The names still match, so the match is still held — and the record has
    // to say so with nulls rather than drop the fields and render as blank rows.
    const fromColumns = { id: 'p2', givenName: 'Jan', surname: 'Jansen' };
    const namelessRival = { id: 'anon', givenName: 'Jan', surname: 'Jansen' };
    const { links, stats } = buildLinks([fromColumns], [jan, namelessRival], rules());

    expect(links).toHaveLength(0);
    expect(stats.suggestions[0]).toMatchObject({
      principalId: 'p2',
      displayName: null,
      identityId: 'jan',
      rivals: [{ identityId: 'anon', identityName: null }],
    });
  });

  it('names at most a handful of rivals but counts them all', () => {
    // A common name in a large tenant produces more rivals than are worth storing on
    // the run row; the count must stay true so the card can say how many it is not showing.
    const crowd = [jan, ...Array.from({ length: MAX_NAME_ONLY_RIVALS + 3 }, (_, i) => ({
      id: `j${i}`, displayName: 'Jan Jansen', email: `jan.jansen.${i}@corp.example`,
    }))];
    const { stats } = buildLinks([account], crowd, rules());
    expect(stats.suggestions[0].rivals).toHaveLength(MAX_NAME_ONLY_RIVALS);
    expect(stats.suggestions[0].rivalCount).toBe(MAX_NAME_ONLY_RIVALS + 3);
  });
});

// ── buildLinks: when a name is never evidence enough ─────────────────────────
//
// `allowNameOnlyLinks: false` is the stricter policy a tenant can ask for: hold back every
// name-only match, even one whose name is unique in the whole tenant. It costs every link
// from a source that carries nothing but display names, which is why it is not the default.

describe('buildLinks - allowNameOnlyLinks: false', () => {
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
    allowNameOnlyLinks: false,
    ...over,
  });

  const JOHN = { id: 'i1', displayName: 'John Doe', email: 'john.doe@corp.com', employeeId: 'E1' };

  it('holds back a name-only match nobody else answers to, and records it', () => {
    // Nothing is ambiguous here -- John is the only John Doe in the tenant -- so this is
    // the policy, not the guard: the account is held for review for want of a second
    // signal, and the record says so rather than naming a rival that does not exist.
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
      reason: 'uncorroborated',
      matchLevel: 'full',
      rivals: [],
      rivalCount: 0,
    }]);
  });

  it('links the very same match under the shipped policy', () => {
    // The paired case on identical input: allowNameOnlyLinks is the whole difference.
    const orphan = { id: 'p1', displayName: 'John Doe', email: 'jd2@elsewhere.com' };
    const { links, stats } = buildLinks([orphan], [JOHN], rules({ allowNameOnlyLinks: true }));

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'i1', confidence: 60, signals: ['fullName'] });
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('treats only a literal false as opting out', () => {
    // `!== false`. The stricter policy costs every link from a display-name-only source,
    // so it is only ever applied on an explicit boolean false -- a config holding the
    // string "false", or 0, or nothing at all, runs the shipped policy.
    for (const value of ['false', 'true', 1, 0, null, undefined, {}]) {
      const { links } = buildLinks(
        [{ id: 'p1', displayName: 'John Doe' }], [JOHN], rules({ allowNameOnlyLinks: value }));
      expect(links).toHaveLength(1);
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
      allowNameOnlyLinks: false,
    };
    const { links, stats } = buildLinks(
      [{ id: 'p1', displayName: 'John Doe' }], [{ id: 'i1', displayName: 'John Doe' }], fuzzyRules);

    expect(links).toHaveLength(0);
    expect(stats.suggestions[0].signals).toEqual(['fuzzyName']);
  });
});

// The #1439 cases below are about how a name is matched and which person it points
// at, read through the SHIPPED rules and asserted on the links alone. Every name
// they turn on is unique in its fixture, which is what makes the match linkable at
// all; the last block covers the interaction with the name-uniqueness guard.
const linksFor = (orphans, identities, rules = DEFAULT_RULES) => buildLinks(orphans, identities, rules).links;

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
    const links = linksFor([orphan], [titledOwner]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'owner', signals: ['fullName'] });
    expect(links[0].confidence).toBe(60); // name-only evidence, reported honestly
  });

  it('leaves a genuine namesake tie for review instead of picking the untitled one', () => {
    // Both people really are called Jan de Vries. Today only the untitled one is even
    // found, so the account is confidently attached to the wrong person; once both are
    // candidates the name-uniqueness guard correctly declines to guess.
    const identities = [
      titledOwner,
      {
        id: 'namesake', displayName: 'Jan de Vries', givenName: 'Jan', surname: 'de Vries',
        email: 'j.devries@corp.example', employeeId: 'E200',
      },
    ];
    expect(linksFor([orphan], identities)).toHaveLength(0);
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
    const links = linksFor([withId], identities);
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
      identities
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
    const links = linksFor([account('p1', 'Anna Bakker-de Wit')], [owner]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'owner', signals: ['fullName'] });
    expect(links[0].confidence).toBe(60);
  });

  it('still links an account that carries the BIRTH surname', () => {
    // The paired case, and the reason the columns are read at all: a system fed
    // from the HR columns spells her the old way.
    const links = linksFor([account('p2', 'Anna de Wit')], [owner]);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('owner');
  });

  it('places an account carrying BOTH spellings on the one person called that', () => {
    // An account provisioned from HR has the birth surname in its column and the
    // name in use in its display name, so it matches both people and ties at 60.
    // Read across the whole candidate set that tie sends it to review; read per
    // name, only one person is called "Bakker-de Wit" and she gets it.
    const orphan = account('p3', 'Anna Bakker-de Wit', { givenName: 'Anna', surname: 'de Wit' });
    const links = linksFor([orphan], [owner, namesake]);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('owner');
  });

  it('places it there whichever order the identities arrive in', () => {
    // Candidates are scored in index order and the first of an equal pair wins,
    // which says nothing about who the account belongs to. Resolved from that
    // winner alone, this same account would land on the namesake instead.
    const orphan = account('p3', 'Anna Bakker-de Wit', { givenName: 'Anna', surname: 'de Wit' });
    const links = linksFor([orphan], [namesake, owner]);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('owner');
  });

  it('gives an account spelled with the shared name to the person called that', () => {
    // "Anna de Wit" is the namesake's name in use and only the owner's birth
    // surname, so the two claims to it are not equal: the directory named this
    // account after the person who goes by it.
    const links = linksFor([account('p4', 'Anna de Wit')], [owner, namesake]);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('namesake');
  });

  it('does not link an account that carries only half of the double name', () => {
    // Widening the names a person is indexed under must not widen what matches:
    // "Anna Bakker" is neither of her names.
    expect(linksFor([account('p5', 'Anna Bakker')], [owner, namesake]))
      .toHaveLength(0);
  });

  it('keeps linking a titled display name, which is what #1439 fixed first', () => {
    // The two halves of the issue have to hold at once: the title strip is still
    // in force while the columns are no longer the only source.
    const titled = {
      id: 'titled', displayName: 'Jan de Vries MSc', givenName: 'Jan', surname: 'de Vries',
      email: 'jan.devries@corp.example', employeeId: 'E100',
    };
    const links = linksFor([account('p6', 'Jan de Vries')], [titled]);
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
    const links = linksFor([account], [owner, otherFamily]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'owner', signals: ['fullName'] });
    expect(links[0].confidence).toBe(60);
  });

  it('links it there whichever order the identities arrive in', () => {
    const links = linksFor([account], [otherFamily, owner]);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('owner');
  });

  it('links it exactly as it would with the other family absent', () => {
    // The point of the fix stated as the regression it is: adding a person who
    // merely used to be called Jansen must not change this account's outcome.
    expect(linksFor([account], [owner, otherFamily]))
      .toEqual(linksFor([account], [owner]));
  });

  it('still refuses when both of them are really called Jansen', () => {
    // The guard still fires for the case it exists for: two people who both go
    // by the name, and nothing to choose between them.
    const twin = { ...otherFamily, displayName: 'Anna Jansen' };
    expect(linksFor([account], [owner, twin])).toHaveLength(0);
  });

  it('still refuses when the name is a birth surname for both of them', () => {
    // Neither goes by Jansen now, so neither has the stronger claim to this
    // account and it is left for an analyst.
    const alsoBorn = { ...owner, displayName: 'Anna Bakker-Jansen' };
    expect(linksFor([account], [alsoBorn, otherFamily])).toHaveLength(0);
  });

  it('still links the other family’s own account', () => {
    // The paired positive: preferring the name in use must not cost the person
    // whose name it is not — her own account is spelled her way.
    const hers = { id: 'p2', displayName: 'Anna de Boer-Jansen', email: null, employeeId: null };
    const links = linksFor([hers], [owner, otherFamily]);
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('other');
  });
});

describe('buildLinks - a per-name claim under the name-uniqueness guard (#1439 x #1440)', () => {
  const owner = {
    id: 'owner', displayName: 'Anna Jansen', givenName: 'Anna', surname: 'Jansen',
    email: 'anna.jansen@corp.example', employeeId: 'E400',
  };
  const otherFamily = {
    id: 'other', displayName: 'Anna de Boer-Jansen', givenName: 'Anna', surname: 'Jansen',
    email: 'anna.deboer@corp.example', employeeId: 'E401',
  };
  const account = { id: 'p1', displayName: 'Anna Jansen', email: null, employeeId: null };

  it('links a name the per-name reading resolves, to the person it resolved to', () => {
    // Two identities answer to 'Jansen', but only one of them is CALLED it -- the
    // other merely carries it as a birth surname. Read as one shared name this is
    // ambiguous and the account goes to review; read per name it is unique in use,
    // and it links to her rather than to whichever identity was scored first.
    const { links, stats } = buildLinks([account], [otherFamily, owner], DEFAULT_RULES);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'owner', confidence: 60, signals: ['fullName'] });
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('holds it for review, naming the resolved identity, when a name is never enough', () => {
    // The same resolution under the stricter policy: it still settles WHO the
    // account would belong to, so the suggestion names her -- not whichever tied
    // identity happened to be scored first -- and reports no rival, because the
    // birth-surname claim is not one.
    const { links, stats } = buildLinks(
      [account], [otherFamily, owner], { ...DEFAULT_RULES, allowNameOnlyLinks: false });
    expect(links).toHaveLength(0);
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions[0]).toMatchObject({
      identityId: 'owner', identityName: 'Anna Jansen', reason: 'uncorroborated', rivalCount: 0,
    });
  });

  it('holds it and names the rival when no name singles anyone out', () => {
    // The paired case: two people who both go by the name stay ambiguous under the
    // shipped policy too, and the suggestion says who the other one is.
    const twin = { ...owner, id: 'twin', displayName: 'Anna Jansen', employeeId: 'E402', email: 'a.jansen@corp.example' };
    const { links, stats } = buildLinks([account], [owner, twin], DEFAULT_RULES);
    expect(links).toHaveLength(0);
    expect(stats.suggestions[0]).toMatchObject({
      reason: 'ambiguousName',
      rivals: [{ identityId: 'twin', identityName: 'Anna Jansen' }],
      rivalCount: 1,
    });
  });
});

// ── Rivalry belongs at the level the match rests on (#1460) ──────────────────
//
// A rival is only a rival at the level the evidence itself sits at. An account
// whose full name is the exact spelling of exactly one identity has that
// identity named by its own evidence; another identity who merely shares the
// surname and first initial is not a competing answer to that name, and holding
// the match on her costs the link for no gain. The protection the guard exists
// for is unchanged where it applies: a second identity spelled the SAME name
// (including a titled spelling, which reduces to the same name) still ties, and
// a match that itself rests on surname + initial is still weighed there.
//
// Each held match also records WHICH level it rested on, because "who else
// answers to this name" means a different name in the two cases and the review
// card has to be able to say which.

describe('buildLinks - rivals only at the initial level (#1460)', () => {
  const rules = (over = {}) => ({
    signals: [
      { name: 'email', type: 'exact', field: 'email', weight: 90 },
      { name: 'fullName', type: 'name', level: 'full', weight: 60 },
      { name: 'surnameInitial', type: 'name', level: 'surnameInitial', weight: 45 },
    ],
    linkThreshold: 50,
    onlyLinkTypes: ['Secondary'],
    accountTypeRules: [],
    ...over,
  });

  // Three unrelated people sharing a surname whose given names all start with Y.
  const youssef = { id: 'youssef', displayName: 'Youssef El Mahdi' };
  const yasmina = { id: 'yasmina', displayName: 'Yasmina El Mahdi' };
  const yassin = { id: 'yassin', displayName: 'Yassin El Mahdi' };

  it('links the account whose full name is spelled by exactly one identity', () => {
    // The reported regression: the account is an exact match for Youssef and for
    // nobody else, yet it is held with rivals Yasmina and Yassin — neither of whom
    // is called "Youssef El Mahdi". On the reporter's dataset this is ~1,700
    // correct links per run.
    const account = { id: 'o1', displayName: 'Youssef El Mahdi', email: null };
    const { links, stats } = buildLinks([account], [youssef, yasmina, yassin], rules());

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ identityId: 'youssef', confidence: 60, signals: ['fullName'] });
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('still holds the match when a second identity is spelled exactly the same', () => {
    // The namesake case the guard exists for, on the same fixture bar one identity:
    // two people really are called "Youssef El Mahdi", so nothing in the name says
    // which — and the rival named is the one who shares the full name, not the one
    // who merely shares the initial.
    const twin = { id: 'twin', displayName: 'Youssef El Mahdi' };
    const account = { id: 'o2', displayName: 'Youssef El Mahdi', email: null };
    const { links, stats } = buildLinks([account], [youssef, twin, yassin], rules());

    expect(links).toHaveLength(0);
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions[0]).toMatchObject({
      identityId: 'youssef',
      reason: 'ambiguousName',
      matchLevel: 'full',
      rivals: [{ identityId: 'twin', identityName: 'Youssef El Mahdi' }],
      rivalCount: 1,
    });
  });

  it('still holds the match when the namesake carries a title', () => {
    // The measured wrong-link class behind #1443: titles are stripped before a name
    // is keyed, so "drs. Youssef El Mahdi" is the same name and the two tie at the
    // full level. Scoping rivalry to the matched level must not release these.
    const titled = { id: 'titled', displayName: 'drs. Youssef El Mahdi' };
    const account = { id: 'o3', displayName: 'Youssef El Mahdi', email: null };
    const { links, stats } = buildLinks([account], [youssef, titled], rules());

    expect(links).toHaveLength(0);
    expect(stats.suggestions[0]).toMatchObject({ reason: 'ambiguousName', matchLevel: 'full' });
  });

  it('holds a match that itself rests on surname and first initial, and says so', () => {
    // The account is an exact match for nobody, so its own evidence sits at the
    // initial level — where two people stand — and it stays held. (Surname+initial
    // is deliberately not a candidate index, so these candidates are reached
    // through the shared email local part and scored on the name alone.)
    const account = { id: 'o4', displayName: 'Youri El Mahdi', email: 'y.elmahdi@contractor.example' };
    const { links, stats } = buildLinks(
      [account],
      [{ ...youssef, email: 'y.elmahdi@corp.example' }, { ...yassin, email: 'y.elmahdi@eu.corp.example' }],
      rules({ linkThreshold: 40 }),
    );

    expect(links).toHaveLength(0);
    expect(stats.suggestions[0]).toMatchObject({
      identityId: 'youssef',
      signals: ['surnameInitial'],
      reason: 'ambiguousName',
      matchLevel: 'surnameInitial',
      rivals: [{ identityId: 'yassin', identityName: 'Yassin El Mahdi' }],
    });
  });

  it('records the level on a match held only for want of a second signal', () => {
    // The level is a property of the match, not of the hold, so it is recorded for
    // both reasons — the card renders it only where it names rivals.
    const account = { id: 'o5', displayName: 'Youssef El Mahdi', email: null };
    const { stats } = buildLinks([account], [youssef], rules({ allowNameOnlyLinks: false }));

    expect(stats.suggestions[0]).toMatchObject({ reason: 'uncorroborated', matchLevel: 'full' });
  });
});
