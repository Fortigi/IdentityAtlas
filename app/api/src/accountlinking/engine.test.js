import { describe, it, expect } from 'vitest';
import { scoreMatch, buildLinks } from './engine.js';
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
  it('links all of a person’s accounts (admin + alternate-domain) to one identity', () => {
    const identities = [{ id: 'euson', displayName: 'Euson, Robin', email: 'r.euson@por.com', employeeId: 'E9' }];
    const orphans = [
      { id: 'adm', displayName: '(ADM-azure) Euson, Robin', email: 'R.Euson@por.onmicrosoft.com' },
      { id: 'ogd', displayName: 'Euson, Robin (OGD)', email: 'robin.euson@ogd.nl' },
      { id: 'admogd', displayName: '(ADM-azure) Euson, Robin (OGD)', email: 'robin.euson@por.onmicrosoft.com' },
      { id: 'svc', displayName: 'svc-backup', email: 'svc-backup@por.com' }, // service → skipped
    ];
    const links = buildLinks(orphans, identities, DEFAULT_RULES);
    const linkedIds = links.map(l => l.principalId).sort();
    expect(linkedIds).toEqual(['adm', 'admogd', 'ogd']);
    expect(links.every(l => l.identityId === 'euson')).toBe(true);
    // The admin account that shares the email prefix scores highest.
    expect(links.find(l => l.principalId === 'adm').confidence).toBeGreaterThan(
      links.find(l => l.principalId === 'ogd').confidence
    );
  });

  it('does not auto-link an ambiguous name-only match (two identities, same name)', () => {
    const identities = [
      { id: 'a', displayName: 'Jansen, Jan', email: 'jan.jansen@x.com' },
      { id: 'b', displayName: 'Jansen, Jan', email: 'j.jansen@y.com' },
    ];
    const orphan = { id: 'o', displayName: 'Jansen, Jan', email: 'jjansen@z.com' };
    expect(buildLinks([orphan], identities, DEFAULT_RULES)).toHaveLength(0);
  });

  it('returns nothing when no identity matches', () => {
    const identities = [identity];
    const links = buildLinks([{ id: 'p-z', displayName: 'Zee, Zed', email: 'zzee@contoso.com' }], identities, DEFAULT_RULES);
    expect(links).toHaveLength(0);
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
    const links = buildLinks(
      [person('p1', 'John Doe')],
      [person('i1', 'John Doe')],
      r,
    );
    expect(links).toHaveLength(1);
    expect(links[0].confidence).toBe(60);
  });

  it('refuses a candidate just under the threshold', () => {
    const r = rules({ linkThreshold: 61 });
    expect(buildLinks([person('p1', 'John Doe')], [person('i1', 'John Doe')], r)).toHaveLength(0);
  });

  it('takes the HIGHEST scoring candidate, not the first one seen', () => {
    // Candidates are scored in insertion order, so the better match is listed SECOND on
    // purpose: without the > comparison the first plausible identity wins and the person
    // is linked to the weaker match.
    const r = rules();
    const links = buildLinks(
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
    expect(buildLinks([person('p1', 'svc-john doe')], [person('i1', 'John Doe')], r)).toHaveLength(0);
  });
});

describe('buildLinks - the ambiguity guard', () => {
  const nameOnlyRules = {
    signals: [
      { name: 'employeeId', type: 'exact', field: 'employeeId', weight: 95 },
      { name: 'fullName', type: 'name', level: 'full', weight: 60 },
    ],
    linkThreshold: 50,
    onlyLinkTypes: ['Secondary'],
    accountTypeRules: [],
  };

  it('refuses a NAME-ONLY match that ties across two identities', () => {
    // Two different people who genuinely share a name. Linking either one merges two
    // humans, and the tie means there is no evidence to prefer one -- so the safe answer
    // is to leave it orphan for review. This guard is the difference between "we do not
    // know" and a confident wrong answer.
    const links = buildLinks(
      [{ id: 'p1', displayName: 'John Doe' }],
      [{ id: 'i1', displayName: 'John Doe' }, { id: 'i2', displayName: 'John Doe' }],
      nameOnlyRules,
    );
    expect(links).toHaveLength(0);
  });

  it('links a NAME-ONLY match when there is exactly one candidate', () => {
    // The paired case: the guard must fire on ambiguity, not on name matches generally.
    const links = buildLinks(
      [{ id: 'p1', displayName: 'John Doe' }],
      [{ id: 'i1', displayName: 'John Doe' }],
      nameOnlyRules,
    );
    expect(links).toHaveLength(1);
    expect(links[0].identityId).toBe('i1');
  });

  it('links a tie that rests on a STRONG signal, not just a name', () => {
    // Same tie, but both candidates share the employee id -- that is a deliberate data
    // duplicate, not two people who happen to share a name, so the guard must not fire.
    const links = buildLinks(
      [{ id: 'p1', displayName: 'John Doe', employeeId: 'E1' }],
      [
        { id: 'i1', displayName: 'John Doe', employeeId: 'E1' },
        { id: 'i2', displayName: 'John Doe', employeeId: 'E1' },
      ],
      nameOnlyRules,
    );
    expect(links).toHaveLength(1);
  });

  it('links when nothing matched at all only if above threshold - otherwise stays orphan', () => {
    expect(buildLinks(
      [{ id: 'p1', displayName: 'Nobody Here' }],
      [{ id: 'i1', displayName: 'Someone Else' }],
      nameOnlyRules,
    )).toHaveLength(0);
  });
});
