// The initials rung of the claim ladder, and the rungs a dictionary switches
// off (#1455).
//
// Three separate mechanisms meet here and each has a silent failure mode:
//
//   the index      an account carrying only "Surname, Initials" matches no exact
//                  name key, no address and no employee number, so if
//                  `collectCandidates` does not reach the initials indexes it is
//                  never scored and the whole feature links nothing — with no
//                  error anywhere.
//   the cascade    the middle rung has to sit BETWEEN the two old ones: above
//                  one letter (or Lars Buskes contests Laura Renée's account)
//                  and below an exact spelling (or somebody actually called the
//                  name loses it).
//   the rung set   a rung whose signal sits at weight 0 must claim nothing, or
//                  zeroing a signal switches it off for new matches only and
//                  leaves every link it already made attached.
//
// Kept out of engine.helpers.test.js, which is already 1,400 lines.

import { describe, it, expect } from 'vitest';
import { indexIdentities, collectCandidates, activeNameRungs } from './engine.helpers.js';
import { nameInitialsVariants } from './nameKeys.js';
import { nameClaim, ALL_CLAIM_RUNGS } from './nameClaim.js';
import { DEFAULT_RULES } from './defaultRules.js';

const person = (id, displayName, givenName, surname, extra = {}) =>
  ({ id, displayName, givenName, surname, ...extra });
const account = (id, displayName, extra = {}) => ({ id, displayName, ...extra });

const LAURA = person('laura', 'Laura Renée Buskes', 'Laura Renée', 'Buskes');
const LARS = person('lars', 'Lars Buskes', 'Lars', 'Buskes');
const LUCAS_W = person('lucasw', 'Lucas Willem Buskes', 'Lucas Willem', 'Buskes');
const LUCAS_R = person('lucasr', 'Lucas Robert Buskes', 'Lucas Robert', 'Buskes');
const SPELLED = person('spelled', 'L.R. Buskes', 'L.R.', 'Buskes');

const candidateIds = (orphan, identities) =>
  [...collectCandidates(orphan, indexIdentities(identities), { prefixes: [], suffixes: [] }).keys()].sort();

describe('nameInitialsVariants — what an identity is keyed under', () => {
  it('keys a person stating two or more initials under their first two', () => {
    // Two, so that an account stating `L.R.` still reaches a person recorded
    // with three given names — the ERP shows fewer initials than HR holds.
    expect([...nameInitialsVariants(LAURA).keys()]).toEqual(['buskes|lr']);
    expect([...nameInitialsVariants(person('x', 'Laura Renée Elisabeth Buskes',
      'Laura Renée Elisabeth', 'Buskes')).keys()]).toEqual(['buskes|lr']);
  });

  it('keys a person with one given name under nothing at this rung', () => {
    // The paired case. Keyed under `buskes|l`, Lars would tie with Laura Renée
    // at the initials rung and neither could be placed.
    expect([...nameInitialsVariants(LARS).keys()]).toEqual([]);
  });
});

describe('collectCandidates — the initials indexes are the only way in', () => {
  it('reaches a person through the initials sequence', () => {
    // Nothing else about this account matches her: no address, no employee id,
    // and `buskes|lr` is nobody's exact name key.
    expect(candidateIds(account('p', 'Buskes, L.R.'), [LAURA])).toEqual(['laura']);
  });

  it('reaches a person through the single initial too', () => {
    expect(candidateIds(account('p', 'van Mourik, R.'),
      [person('robin', 'Robin van Mourik', 'Robin', 'van Mourik')])).toEqual(['robin']);
  });

  it('reaches nobody whose surname differs', () => {
    // The control: the initials are not a wildcard over the directory.
    expect(candidateIds(account('p', 'Buskes, L.R.'),
      [person('other', 'Laura Renée Jansen', 'Laura Renée', 'Jansen')])).toEqual([]);
  });
});

describe('nameClaim — the initials rung sits between the other two', () => {
  it('settles the name over a single-initial rival', () => {
    // Lars is one letter away and is NOT a rival: he does not answer to the two
    // initials this account states.
    const claim = nameClaim(account('p', 'Buskes, L.R.'), indexIdentities([LAURA, LARS]));
    expect(claim.sole).toBe(LAURA);
    expect(claim.claimants).toEqual([LAURA]);
  });

  it('loses the name to somebody spelled it exactly', () => {
    // The paired case, and the ladder's top rung: `L.R. Buskes` IS the name, so
    // Laura Renée's agreeing initials do not contest it.
    const claim = nameClaim(account('p', 'Buskes, L.R.'), indexIdentities([LAURA, SPELLED]));
    expect(claim.sole).toBe(SPELLED);
    expect(claim.claimants).toEqual([SPELLED]);
  });

  it('ties between two people stating the same initials', () => {
    // The protection is unchanged at equal rung: nothing in `L.R.` says which
    // of two L.R. Buskes the account is.
    const other = person('lauraro', 'Laura Rosa Buskes', 'Laura Rosa', 'Buskes');
    const claim = nameClaim(account('p', 'Buskes, L.R.'), indexIdentities([LAURA, other]));
    expect(claim.sole).toBeNull();
    expect(claim.claimants.map(c => c.id).sort()).toEqual(['laura', 'lauraro']);
  });

  it('reads the claim whichever order the identities were indexed in', () => {
    expect(nameClaim(account('p', 'Buskes, L.R.'), indexIdentities([LARS, LAURA])).sole).toBe(LAURA);
  });
});

describe('nameClaim — a contradicted person is no claimant at all (R1b/P2)', () => {
  it('rules out the sole person whose initials contradict the account', () => {
    // Blocked, not held: he neither claims it nor is offered as a rival, so the
    // account is simply not his.
    const claim = nameClaim(account('p', 'Buskes, L.R.'), indexIdentities([LUCAS_W]));
    expect(claim.sole).toBeNull();
    expect(claim.claimants).toEqual([]);
  });

  it('lets the contradiction resolve an ambiguity the initial could not', () => {
    // Both are L. Buskes; only one is L.R. Buskes. Counting Lucas Willem as a
    // rival would hold a match the evidence settles.
    const claim = nameClaim(account('p', 'Buskes, L.R.'), indexIdentities([LUCAS_R, LUCAS_W]));
    expect(claim.sole).toBe(LUCAS_R);
    expect(claim.claimants).toEqual([LUCAS_R]);
  });

  it('removes him from the login’s claimants too (P5)', () => {
    // Route-independence. The login carries one initial, so `adm-lbuskes` fits
    // him; read on its own it would hand him the very account his own initials
    // rule him out of.
    const lucas = { ...LUCAS_W, email: 'lucas.buskes@corp.example' };
    const claim = nameClaim(
      account('p', 'Buskes, L.R.', { email: 'adm-lbuskes@corp.example' }),
      indexIdentities([lucas]),
      { loginPrefixes: ['adm-'] },
    );
    expect(claim.sole).toBeNull();
    expect(claim.claimants).toEqual([]);
  });

  it('still lets the login place an account its name does not contradict', () => {
    // The paired case that stops the block reducing to "a login never places
    // anybody": Laura Renée's initials agree, so her login form stands.
    const laura = { ...LAURA, email: 'laura.buskes@corp.example' };
    const claim = nameClaim(
      account('p', 'Buskes, L.R.', { email: 'adm-lbuskes@corp.example' }),
      indexIdentities([laura]),
      { loginPrefixes: ['adm-'] },
    );
    expect(claim.sole).toBe(laura);
  });
});

describe('activeNameRungs — weight 0 switches a rung off', () => {
  const zeroed = (name) => ({
    ...DEFAULT_RULES,
    signals: DEFAULT_RULES.signals.map(s => (s.name === name ? { ...s, weight: 0 } : s)),
  });

  it('reads the shipped dictionary as every rung on', () => {
    expect(activeNameRungs(DEFAULT_RULES)).toEqual(ALL_CLAIM_RUNGS);
    expect([...ALL_CLAIM_RUNGS].sort()).toEqual(['full', 'initial', 'initials', 'login']);
  });

  it('drops exactly the rung whose signal is at 0', () => {
    expect([...activeNameRungs(zeroed('surnameInitial'))].sort()).toEqual(['full', 'initials', 'login']);
    expect([...activeNameRungs(zeroed('surnameInitials'))].sort()).toEqual(['full', 'initial', 'login']);
    expect([...activeNameRungs(zeroed('loginNameForm'))].sort()).toEqual(['full', 'initial', 'initials']);
    expect([...activeNameRungs(zeroed('fullName'))].sort()).toEqual(['initial', 'initials', 'login']);
  });

  it('reads the legacy fuzzy signal as the full rung', () => {
    expect([...activeNameRungs({ signals: [{ name: 'legacy', type: 'fuzzy', weight: 60 }] })])
      .toEqual(['full']);
  });

  it('reads no dictionary as no rung', () => {
    expect(activeNameRungs({})).toEqual(new Set());
  });

  it('makes a switched-off rung claim nothing', () => {
    // The point of threading it through: with `surnameInitial` off, the single
    // initial that used to point at Robin points at nobody, which is what makes
    // the links resting on it stale.
    const robin = person('robin', 'Robin van Mourik', 'Robin', 'van Mourik');
    const orphan = account('p', 'van Mourik, R.');
    const indexes = indexIdentities([robin]);
    expect(nameClaim(orphan, indexes, { activeRungs: activeNameRungs(DEFAULT_RULES) }).sole).toBe(robin);
    expect(nameClaim(orphan, indexes, { activeRungs: activeNameRungs(zeroed('surnameInitial')) }).sole)
      .toBeNull();
  });

  it('makes a switched-off login rung claim nothing', () => {
    const fay = person('fay', 'Fay Hogenbirk', 'Fay', 'Hogenbirk',
      { email: 'f.h.hogenbirk@corp.example' });
    const orphan = account('p-adm', 'Admin account 042', { email: 'adm-fhogenbirk@corp.example' });
    const indexes = indexIdentities([fay]);
    const opts = { loginPrefixes: ['adm-'] };
    expect(nameClaim(orphan, indexes, opts).sole).toBe(fay);
    expect(nameClaim(orphan, indexes, { ...opts, activeRungs: activeNameRungs(zeroed('loginNameForm')) }).sole)
      .toBeNull();
  });
});
