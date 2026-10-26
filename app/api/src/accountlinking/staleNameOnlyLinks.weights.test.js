// The retroactive cleanup and the dictionary's weights (#1455).
//
// Weight 0 is documented as the per-signal off-switch, but until this change it
// only ever switched a signal off for NEW matches. Measured on the dataset:
// setting `loginNameForm` to 0 and re-running left all 13 links it had made
// attached, `linksRemoved` 0 — because staleness was judged by uniqueness alone
// and the uniqueness reading counted login forms whatever their weight. An
// administrator switching a signal off therefore saw nothing change.
//
// Both halves are tested here, and both need their opposite asserted beside
// them or the fix reads as "detach more":
//
//   rule (a)   a link resting on nothing the dictionary still scores is stale...
//              ...and one whose signal is still weighted is not.
//   P7         re-weighting the guard's own evidence (`nameUnique`,
//              `department`, `manager`) detaches nothing, because it is not
//              independent evidence — it says the NAME singled somebody out. A
//              cleanup reading it as a carrying signal would detach every link
//              the guard has ever made as soon as a tenant retuned a tie-break.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeStaleNameOnlyLinks } from './staleNameOnlyLinks.js';
import { DEFAULT_RULES } from './defaultRules.js';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';

/** The shipped dictionary with one signal's weight replaced. */
const reweighted = (name, weight) => ({
  ...DEFAULT_RULES,
  signals: DEFAULT_RULES.signals.map(s => (s.name === name ? { ...s, weight } : s)),
});

// One person per name, so uniqueness is never what detaches anything here: only
// the weights can be, which is what makes these cases discriminate.
const IDENTITIES = [
  { id: 'fay', displayName: 'Fay Hogenbirk', givenName: 'Fay', surname: 'Hogenbirk',
    email: 'f.h.hogenbirk@corp.example' },
  { id: 'robin', displayName: 'Robin van Mourik', givenName: 'Robin', surname: 'van Mourik' },
  { id: 'laura', displayName: 'Laura Renee Buskes', givenName: 'Laura Renee', surname: 'Buskes' },
];

/** A member row the engine scored, as the cleanup reads it. */
const member = (identityId, principalId, linkSignals, account) =>
  ({ identityId, principalId, linkSignals, ...account });

const ADM_FAY = { displayName: 'Admin account 042', email: 'adm-fhogenbirk@corp.example' };
const ERP_ROBIN = { displayName: 'van Mourik, R.', email: null };
const ERP_LAURA = { displayName: 'Buskes, L.R.', email: null };

function stageMembers(rows) {
  query.mockImplementation(async (sql) => {
    if (/FROM "IdentityMembers" m/.test(sql)) return { rows };
    return { rows: [] };
  });
}

const detached = () => query.mock.calls
  .filter(c => /DELETE FROM "IdentityMembers"/.test(c[0]))
  .map(c => c[1][1]);

beforeEach(() => { query.mockReset(); });

describe('removeStaleNameOnlyLinks — a signal switched off at weight 0', () => {
  it('detaches the links resting on it, and only those', () => {
    // The measured case. Three links, one per signal; zeroing `loginNameForm`
    // must take exactly the login one. Asserting the count alone would pass on a
    // cleanup that detached all three.
    stageMembers([
      member('fay', 'p-adm', 'loginNameForm,nameUnique', ADM_FAY),
      member('robin', 'p-erp', 'surnameInitial,nameUnique', ERP_ROBIN),
      member('laura', 'p-erp2', 'surnameInitials,nameUnique', ERP_LAURA),
    ]);
    return removeStaleNameOnlyLinks(reweighted('loginNameForm', 0), IDENTITIES).then((removed) => {
      expect(removed).toBe(1);
      expect(detached()).toEqual(['p-adm']);
    });
  });

  it('leaves all three attached while every signal is still weighted', async () => {
    // The paired case, same input bar the weights: under the shipped dictionary
    // each name still points at its one person, so nothing churns.
    stageMembers([
      member('fay', 'p-adm', 'loginNameForm,nameUnique', ADM_FAY),
      member('robin', 'p-erp', 'surnameInitial,nameUnique', ERP_ROBIN),
      member('laura', 'p-erp2', 'surnameInitials,nameUnique', ERP_LAURA),
    ]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, IDENTITIES)).toBe(0);
    expect(detached()).toEqual([]);
  });

  it('detaches an initials link when surnameInitials goes to 0', async () => {
    stageMembers([
      member('laura', 'p-erp2', 'surnameInitials,nameUnique', ERP_LAURA),
      member('robin', 'p-erp', 'surnameInitial,nameUnique', ERP_ROBIN),
    ]);
    expect(await removeStaleNameOnlyLinks(reweighted('surnameInitials', 0), IDENTITIES)).toBe(1);
    expect(detached()).toEqual(['p-erp2']);
  });

  it('detaches a single-initial link when surnameInitial goes to 0', async () => {
    stageMembers([
      member('robin', 'p-erp', 'surnameInitial,nameUnique', ERP_ROBIN),
      member('laura', 'p-erp2', 'surnameInitials,nameUnique', ERP_LAURA),
    ]);
    expect(await removeStaleNameOnlyLinks(reweighted('surnameInitial', 0), IDENTITIES)).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });

  it('detaches a link resting on a signal the dictionary no longer defines', async () => {
    // A signal cannot be scored if it is not in the dictionary at all, so a link
    // resting only on it is as stale as one resting on a zeroed signal.
    stageMembers([member('robin', 'p-erp', 'retiredSignal', ERP_ROBIN)]);
    expect(await removeStaleNameOnlyLinks(
      { ...DEFAULT_RULES, signals: [...DEFAULT_RULES.signals, { name: 'retiredSignal', type: 'name', level: 'gone', weight: 0 }] },
      IDENTITIES,
    )).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });
});

describe('removeStaleNameOnlyLinks — the guard’s evidence is not independent (P7)', () => {
  it('treats an evidence-carrying link as name-only', () => {
    // The trap: classified any other way, `isNameOnly` answers false for every
    // link this guard makes and the cleanup can never revisit one of them,
    // permanently. Zeroing the signal it rests on proves the row was in scope.
    stageMembers([member('robin', 'p-erp', 'surnameInitial,nameUnique,department', ERP_ROBIN)]);
    return removeStaleNameOnlyLinks(reweighted('surnameInitial', 0), IDENTITIES).then((removed) => {
      expect(removed).toBe(1);
      expect(detached()).toEqual(['p-erp']);
    });
  });

  it('detaches nothing when only the evidence is re-weighted', async () => {
    // The paired case and the actual rule: the name still points at its one
    // person, so the link stands. Only the confidence a future run records
    // changes — which is what a weight is for.
    const rows = [
      member('robin', 'p-erp', 'surnameInitial,nameUnique,department', ERP_ROBIN),
      member('laura', 'p-erp2', 'surnameInitials,nameUnique,manager', ERP_LAURA),
    ];
    for (const name of ['nameUnique', 'department', 'manager']) {
      query.mockReset();
      stageMembers(rows);
      expect(await removeStaleNameOnlyLinks(reweighted(name, 0), IDENTITIES), name).toBe(0);
      expect(detached()).toEqual([]);
    }
  });

  it('still detaches an evidence-carrying link whose name points elsewhere', async () => {
    // The uniqueness half is untouched by any of this: a link hanging off the
    // wrong person goes, whatever it records.
    stageMembers([member('laura', 'p-erp', 'surnameInitial,nameUnique,department', ERP_ROBIN)]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, IDENTITIES)).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });

  it('never touches a link carrying a signal that is not name-class', async () => {
    // Unchanged, and the reason the evidence classification is safe: a link with
    // a real second signal is not name-only, so none of this applies to it.
    stageMembers([member('robin', 'p-erp', 'email,surnameInitial,nameUnique', ERP_ROBIN)]);
    expect(await removeStaleNameOnlyLinks(reweighted('surnameInitial', 0), IDENTITIES)).toBe(0);
    expect(detached()).toEqual([]);
  });
});
