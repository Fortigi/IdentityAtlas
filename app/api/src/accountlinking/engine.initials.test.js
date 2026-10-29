// buildLinks over accounts that show only "Surname, Initials" (#1455).
//
// The source this is about — ERP, finance, payroll — carries a display name and
// nothing else: no address, no employee number, no login. Measured on a
// synthetic 7,000-identity dataset, its ≈2,100 accounts linked **zero** times,
// because the strongest evidence such a name can produce (surname + one initial,
// weight 45) sits below the shipped threshold of 50 and the account is not even
// a scoring candidate. Every fixture here therefore carries `email: null` and
// `employeeId: null` — with either of them present the test would pass on the
// strong signals and say nothing about this feature.
//
// The cases come in pairs on purpose. "Links an unambiguous initials match" is
// also satisfied by linking every initials match, which is the outcome the issue
// explicitly rejects ("the fix is a lower default threshold, so ambiguous
// initials link to whoever scores first") — so each link is asserted beside the
// ambiguity that must still be held, and each hold beside the match that must
// still be placed.

import { describe, it, expect } from 'vitest';
import { buildLinks, MAX_NAME_ONLY_SUGGESTIONS } from './engine.js';
import { DEFAULT_RULES } from './defaultRules.js';

/** An account from a source that carries nothing but a display name. */
const account = (id, displayName, extra = {}) =>
  ({ id, displayName, email: null, employeeId: null, accountEnabled: true, ...extra });

/** A person as an HR feed records them: display name plus official given names. */
const person = (id, displayName, givenName, surname, extra = {}) =>
  ({ id, displayName, givenName, surname, email: null, employeeId: null, ...extra });

const linksOf = (orphans, identities, rules = DEFAULT_RULES) =>
  buildLinks(orphans, identities, rules).links
    .map(l => ({ identityId: l.identityId, confidence: l.confidence, signals: l.signals }));

const held = (orphans, identities, rules = DEFAULT_RULES) =>
  buildLinks(orphans, identities, rules).stats;

const ROBIN = person('robin', 'Robin van Mourik', 'Robin', 'van Mourik');
const LAURA = person('laura', 'Laura Renee Buskes', 'Laura Renee', 'Buskes');
const LARS = person('lars', 'Lars Buskes', 'Lars', 'Buskes');

describe('buildLinks — a unique "Surname, Initials" account links, a contested one does not', () => {
  it('links a unique single-initial account at 55, on initials and uniqueness', () => {
    // 45 for the surname + initial, 10 for nobody else answering to it. The
    // signals are the point: an analyst reading this link can see it rests on
    // initials, which is the issue's own reject criterion if it does not.
    expect(linksOf([account('p', 'van Mourik, R.')], [ROBIN])).toEqual([
      { identityId: 'robin', confidence: 55, signals: ['surnameInitial', 'nameUnique'] },
    ]);
  });

  it('holds a contested single-initial account and names the rival', () => {
    // The paired case. Two people answer to `Jansen, J.`, so the account is
    // reviewable rather than linked — and reviewable means the run says who.
    const jan = person('jan', 'Jan Jansen', 'Jan', 'Jansen');
    const johannes = person('joh', 'Johannes Jansen', 'Johannes', 'Jansen');
    const stats = held([account('p', 'Jansen, J.')], [jan, johannes]);

    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions).toHaveLength(1);
    const [s] = stats.suggestions;
    expect(s).toMatchObject({
      principalId: 'p', reason: 'ambiguousName', matchLevel: 'surnameInitial', rivalCount: 1,
    });
    // `rivalCount` is the OTHER claimants, so two claimants is one rival.
    expect([s.identityId, ...s.rivals.map(r => r.identityId)].sort()).toEqual(['jan', 'joh']);
    expect(linksOf([account('p', 'Jansen, J.')], [jan, johannes])).toEqual([]);
  });
});

describe('buildLinks — all the initials count, not just the first', () => {
  it('singles out the person whose given names match both initials', () => {
    // `L.R.` against Laura Renee and Lars: one letter leaves both, two letters
    // leave one. This is the case a lower threshold would decide by luck.
    expect(linksOf([account('p', 'Buskes, L.R.')], [LAURA, LARS])).toEqual([
      { identityId: 'laura', confidence: 65, signals: ['surnameInitials', 'nameUnique'] },
    ]);
  });

  it('still holds two people who state the same initials', () => {
    // The paired case: more letters is not the same as unambiguous.
    const other = person('rosa', 'Laura Rosa Buskes', 'Laura Rosa', 'Buskes');
    const stats = held([account('p', 'Buskes, L.R.')], [LAURA, other]);
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions[0]).toMatchObject({ matchLevel: 'surnameInitials', rivalCount: 1 });
  });

  it('is neutral about initials one side does not state, in both directions (R1)', () => {
    // An HR record holding only "Lucas" says nothing about a second initial, and
    // neither does an account showing only `L.` Both still link on one letter.
    const lucas = person('lucas', 'Lucas Buskes', 'Lucas', 'Buskes');
    expect(linksOf([account('p', 'Buskes, L.R.')], [lucas])).toEqual([
      { identityId: 'lucas', confidence: 55, signals: ['surnameInitial', 'nameUnique'] },
    ]);
    const lucasRobert = person('lr', 'Lucas Robert Buskes', 'Lucas Robert', 'Buskes');
    expect(linksOf([account('p2', 'Buskes, L.')], [lucasRobert])).toEqual([
      { identityId: 'lr', confidence: 55, signals: ['surnameInitial', 'nameUnique'] },
    ]);
  });
});

describe('buildLinks — contradicting initials block, they do not hold (R1b/P2)', () => {
  const LUCAS_W = person('lucasw', 'Lucas Willem Buskes', 'Lucas Willem', 'Buskes');

  it('neither links nor suggests the sole person the initials rule out', () => {
    // No link AND no suggestion: a hold would send a reviewer after a match the
    // evidence has already answered.
    const { links, stats } = buildLinks([account('p', 'Buskes, L.R.')], [LUCAS_W], DEFAULT_RULES);
    expect(links).toEqual([]);
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });

  it('resolves an ambiguity the single initial could not', () => {
    // The paired case, and what says the block is scoped: both are L. Buskes, so
    // on one letter this is held; the second letter places it.
    const lucasR = person('lucasr', 'Lucas Robert Buskes', 'Lucas Robert', 'Buskes');
    expect(linksOf([account('p', 'Buskes, L.R.')], [lucasR, LUCAS_W])).toEqual([
      { identityId: 'lucasr', confidence: 65, signals: ['surnameInitials', 'nameUnique'] },
    ]);
    expect(held([account('p', 'Buskes, L.')], [lucasR, LUCAS_W]).nameOnlyMatches).toBe(1);
  });

  it('blocks on every route, including a login that fits him (P5)', () => {
    // `adm-lbuskes` is his login form, and it carries one initial, so read on
    // its own it hands him the account his own name rules him out of.
    const lucas = { ...LUCAS_W, email: 'lucas.buskes@corp.example' };
    const orphan = account('p-adm', 'Buskes, L.R.', { email: 'adm-lbuskes@corp.example' });
    const { links, stats } = buildLinks([orphan], [lucas], DEFAULT_RULES);
    expect(links).toEqual([]);
    expect(stats).toEqual({ nameOnlyMatches: 0, suggestions: [] });
  });
});

describe('buildLinks — where the initials rung sits in the ladder (P6)', () => {
  it('gives the name to somebody spelled it exactly over an all-initials claimant', () => {
    const spelled = person('spelled', 'L.R. Jansen', 'L.R.', 'Jansen');
    const laura = person('lauraj', 'Laura Renee Jansen', 'Laura Renee', 'Jansen');
    expect(linksOf([account('p', 'Jansen, L.R.')], [spelled, laura])).toEqual([
      { identityId: 'spelled', confidence: 70, signals: ['fullName', 'nameUnique'] },
    ]);
  });

  it('gives it to the all-initials claimant over a single-initial rival', () => {
    const laura = person('lauraj', 'Laura Renee Jansen', 'Laura Renee', 'Jansen');
    const lars = person('larsj', 'Lars Jansen', 'Lars', 'Jansen');
    expect(linksOf([account('p', 'Jansen, L.R.')], [laura, lars])).toEqual([
      { identityId: 'lauraj', confidence: 65, signals: ['surnameInitials', 'nameUnique'] },
    ]);
  });

  it('records surnameInitials, not the login, where both fire for one pair', () => {
    // Equal weights (55), so the shipped ladder's order is the precedence: the
    // display name's initials are the richer reading and theirs is the rival set
    // the guard uses.
    const laura = { ...LAURA, email: 'laura.buskes@corp.example' };
    const orphan = account('p', 'Buskes, L.R.', { email: 'adm-lbuskes@corp.example' });
    expect(linksOf([orphan], [laura])).toEqual([
      { identityId: 'laura', confidence: 65, signals: ['surnameInitials', 'nameUnique'] },
    ]);
  });
});

describe('buildLinks — context narrows, it never picks (R2)', () => {
  const twin = (id, dept, mgr) => person(id, 'Anna Jansen', 'Anna', 'Jansen',
    { department: dept, managerIdentityId: mgr });

  it('lets a shared department settle two namesakes', () => {
    // Compared after lower-casing and trimming, and no further.
    const a = twin('a', 'Finance');
    const b = twin('b', 'HR');
    expect(linksOf([account('p', 'Anna Jansen', { department: ' finance ' })], [a, b])).toEqual([
      { identityId: 'a', confidence: 70, signals: ['fullName', 'department'] },
    ]);
  });

  it('holds them where both share it', () => {
    // The paired case: a department two claimants share says nothing about which
    // of them the account is, so it must not pick the first one.
    const stats = held([account('p', 'Anna Jansen', { department: 'Finance' })],
      [twin('a', 'Finance'), twin('b', 'Finance')]);
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions[0]).toMatchObject({ reason: 'ambiguousName', matchLevel: 'full' });
  });

  it('lets a shared manager settle them where no department is recorded', () => {
    // The 107 links measured on the dataset's manager-carrying ERP accounts.
    const a = twin('a', null, 'mgr-1');
    const b = twin('b', null, 'mgr-2');
    expect(linksOf([account('p', 'Anna Jansen', { managerIdentityId: 'mgr-1' })], [a, b])).toEqual([
      { identityId: 'a', confidence: 75, signals: ['fullName', 'manager'] },
    ]);
  });

  it('does not fire the manager evidence before the manager’s own account is linked', () => {
    // The bootstrap gap, stated as behaviour: the account's manager is a
    // principal, so the identity behind it is null on the first run after an
    // import. A later run picks it up; this run holds the match.
    const a = twin('a', null, 'mgr-1');
    const b = twin('b', null, 'mgr-2');
    expect(held([account('p', 'Anna Jansen', { managerIdentityId: null })], [a, b]).nameOnlyMatches)
      .toBe(1);
  });
});

describe('buildLinks — the certainty slider still decides how much is enough', () => {
  const at = (linkThreshold) => ({ ...DEFAULT_RULES, linkThreshold });
  const UNIQUE_INITIAL = [[account('p', 'van Mourik, R.')], [ROBIN]];
  const UNIQUE_FULL = [[account('p2', 'Robin van Mourik')], [ROBIN]];

  it('links a unique single-initial match at the shipped 50 and stops at 60', () => {
    // 55 is the whole number this feature turns on, so the slider is where a
    // tenant refuses it — not a new config knob (R3).
    expect(linksOf(...UNIQUE_INITIAL, at(50))).toHaveLength(1);
    expect(buildLinks(...UNIQUE_INITIAL, at(60))).toEqual({
      links: [], stats: { nameOnlyMatches: 0, suggestions: [] },
    });
  });

  it('links a unique full-name match at 60 and stops at 75', () => {
    // The side effect of corroboration: a unique full name is now stored at 70
    // rather than 60, so a slider between 61 and 70 links what it used to hold.
    expect(linksOf(...UNIQUE_FULL, at(60))).toEqual([
      { identityId: 'robin', confidence: 70, signals: ['fullName', 'nameUnique'] },
    ]);
    expect(linksOf(...UNIQUE_FULL, at(75))).toEqual([]);
  });

  it('holds back even a unique initials match under allowNameOnlyLinks: false', () => {
    const stats = held(...UNIQUE_INITIAL, { ...DEFAULT_RULES, allowNameOnlyLinks: false });
    expect(stats.nameOnlyMatches).toBe(1);
    expect(stats.suggestions[0]).toMatchObject({
      identityId: 'robin', reason: 'uncorroborated', rivalCount: 0, confidence: 55,
    });
  });

  it('claims nothing from a rung the dictionary switched off', () => {
    // Weight 0 is the off-switch: with `surnameInitial` at 0 the account is
    // neither linked nor held, and the paired assertion above shows the same
    // input does link with the signal on.
    const off = {
      ...DEFAULT_RULES,
      signals: DEFAULT_RULES.signals.map(s => (s.name === 'surnameInitial' ? { ...s, weight: 0 } : s)),
    };
    expect(buildLinks(...UNIQUE_INITIAL, off)).toEqual({
      links: [], stats: { nameOnlyMatches: 0, suggestions: [] },
    });
  });
});

describe('buildLinks — half of an account’s double surname is not a name level', () => {
  // Pins today's behaviour so the follow-up that may introduce it has a
  // baseline: the account's surname is read whole, the identity holds only the
  // first half, and no name pair matches at any rung. No link, no suggestion —
  // not a wrong link either.
  it('places nothing for an account whose surname the identity holds half of', () => {
    const jorn = person('jorn', 'Jorn Cornelius Hoftijzer', 'Jorn Cornelius', 'Hoftijzer');
    expect(buildLinks([account('p', 'Hoftijzer-Nijland, J.C. (admin)')], [jorn], DEFAULT_RULES))
      .toEqual({ links: [], stats: { nameOnlyMatches: 0, suggestions: [] } });
  });

  it('places nothing for the same shape with a particle surname', () => {
    const jan = person('jan', 'Jan de Zwart', 'Jan', 'de Zwart');
    expect(buildLinks([account('p', 'de Zwart-Zomerdijk, J. (admin)')], [jan], DEFAULT_RULES))
      .toEqual({ links: [], stats: { nameOnlyMatches: 0, suggestions: [] } });
  });
});

describe('buildLinks — nothing to go on', () => {
  it('claims nothing from a bare surname', () => {
    // A surname is not a name match at any rung, and an account showing only one
    // would otherwise claim every person in the family.
    expect(buildLinks([account('p', 'Buskes')], [LAURA, LARS], DEFAULT_RULES))
      .toEqual({ links: [], stats: { nameOnlyMatches: 0, suggestions: [] } });
  });

  it('links nothing against an empty directory, and does not throw', () => {
    expect(buildLinks([account('p', 'Buskes, L.R.')], [], DEFAULT_RULES))
      .toEqual({ links: [], stats: { nameOnlyMatches: 0, suggestions: [] } });
  });

  it('caps the stored suggestions while counting all of them', () => {
    // A tenant whose ERP shows initials can hold far more than the cap, and the
    // count is what the card reports against.
    const identities = [];
    const orphans = [];
    for (let i = 0; i < MAX_NAME_ONLY_SUGGESTIONS + 3; i++) {
      const surname = `Ambig${i}`;
      identities.push(person(`a${i}`, `Jan ${surname}`, 'Jan', surname));
      identities.push(person(`b${i}`, `Johannes ${surname}`, 'Johannes', surname));
      orphans.push(account(`p${i}`, `${surname}, J.`));
    }
    const { links, stats } = buildLinks(orphans, identities, DEFAULT_RULES);
    expect(links).toEqual([]);
    expect(stats.nameOnlyMatches).toBe(MAX_NAME_ONLY_SUGGESTIONS + 3);
    expect(stats.suggestions).toHaveLength(MAX_NAME_ONLY_SUGGESTIONS);
  });
});
