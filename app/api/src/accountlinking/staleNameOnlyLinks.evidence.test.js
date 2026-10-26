// The retroactive cleanup and the evidence that settled a shared name (#1455).
//
// The guard may attach an account whose name two people answer to, where a
// department or a manager singles exactly one of them out. The cleanup then has
// to judge that link on the same two questions the engine asked — the name, and
// the evidence beside it — because the name on its own points at nobody by
// construction. Reading only the name, the cleanup sees a link resting on a
// namesake, detaches it, and the same run re-creates it from the orphan pool:
// `linksRemoved` never settles and the account's history churns for ever.
//
// It is invisible to a fixture that gives each name one claimant — where `sole`
// answers, the two readings cannot differ — so every case here seeds a genuine
// namesake and then changes only what settles between them.
//
// Each case is paired with its opposite, because "keep the link" is also
// satisfied by a cleanup that detaches nothing at all and "detach it" by one
// that detaches everything.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeStaleNameOnlyLinks } from './staleNameOnlyLinks.js';
import { DEFAULT_RULES } from './defaultRules.js';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';

/** Two people really called Anna Vos, which is what makes the name settle nothing. */
const twin = (id, extra = {}) =>
  ({ id, displayName: 'Anna Vos', givenName: 'Anna', surname: 'Vos', ...extra });

/** A person nobody in these cases is named after — context without a claim. */
const OUTSIDER = {
  id: 'piet', displayName: 'Piet Smit', givenName: 'Piet', surname: 'Smit', department: 'Finance',
};

/** The member row the engine wrote, as the cleanup reads it back. */
const member = (identityId, signals, account = {}) => ({
  identityId,
  principalId: 'p-erp',
  linkSignals: signals,
  displayName: 'Anna Vos',
  email: null,
  department: null,
  managerIdentityId: null,
  ...account,
});

/** The shipped dictionary with one signal's weight replaced. */
const reweighted = (name, weight) => ({
  ...DEFAULT_RULES,
  signals: DEFAULT_RULES.signals.map(s => (s.name === name ? { ...s, weight } : s)),
});

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

describe('removeStaleNameOnlyLinks — a link the department settled', () => {
  it('leaves it attached, although the name alone points at nobody', async () => {
    // The churn case. Finance is Anna #1's and nobody else's, so this is the link
    // the engine makes today and would make again on the next run.
    stageMembers([member('a', 'fullName,department', { department: 'finance' })]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [
      twin('a', { department: 'Finance' }), twin('b', { department: 'HR' }),
    ])).toBe(0);
    expect(detached()).toEqual([]);
  });

  it('detaches it once both namesakes are in that department', async () => {
    // The paired case, same stored link: a department two claimants share says
    // nothing about which of them the account is, so nothing settles it any more
    // and the run holds the match for review instead.
    stageMembers([member('a', 'fullName,department', { department: 'finance' })]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [
      twin('a', { department: 'Finance' }), twin('b', { department: 'Finance' }),
    ])).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });

  it('detaches it when the department singles out the other namesake', async () => {
    // The uniqueness half is untouched by any of this: a link hanging off the
    // wrong person goes, whatever settled it when it was made.
    stageMembers([member('b', 'fullName,department', { department: 'finance' })]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [
      twin('a', { department: 'Finance' }), twin('b', { department: 'HR' }),
    ])).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });

  it('detaches it when the account carries no department at all', async () => {
    // A source that stopped sending the column leaves the name alone deciding,
    // and the name decides nothing. No churn follows: the re-scored match is held
    // for review rather than re-linked.
    stageMembers([member('a', 'fullName,department', { department: null })]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [
      twin('a', { department: 'Finance' }), twin('b', { department: 'HR' }),
    ])).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });

  it('weighs the department over the name’s claimants only', async () => {
    // Context narrows the people the NAME allows; it never picks somebody the
    // name never offered. Piet Smit is the only Finance person here and is no
    // Anna Vos, so the two Annas still tie and the link is stale.
    stageMembers([member('a', 'fullName,department', { department: 'finance' })]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [
      twin('a'), twin('b'), OUTSIDER,
    ])).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });

  it('detaches it once the dictionary switches the department evidence off', async () => {
    // The boundary of P7, which says re-weighting the evidence detaches nothing:
    // that holds for a link whose NAME still points at its one person. Here the
    // name points at two, so weight 0 leaves nothing settling the account and the
    // engine would no longer make this link either.
    stageMembers([member('a', 'fullName,department', { department: 'finance' })]);
    expect(await removeStaleNameOnlyLinks(reweighted('department', 0), [
      twin('a', { department: 'Finance' }), twin('b', { department: 'HR' }),
    ])).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });
});

describe('removeStaleNameOnlyLinks — a link the manager settled', () => {
  it('leaves it attached while the manager still singles one namesake out', async () => {
    stageMembers([member('a', 'fullName,manager', { managerIdentityId: 'mgr-1' })]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [
      twin('a', { managerIdentityId: 'mgr-1' }), twin('b', { managerIdentityId: 'mgr-2' }),
    ])).toBe(0);
    expect(detached()).toEqual([]);
  });

  it('detaches it when the namesakes report to the same person', async () => {
    stageMembers([member('a', 'fullName,manager', { managerIdentityId: 'mgr-1' })]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [
      twin('a', { managerIdentityId: 'mgr-1' }), twin('b', { managerIdentityId: 'mgr-1' }),
    ])).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });

  it('detaches it where the account’s manager is no longer linked to a person', async () => {
    // `managerIdentityId` resolves through the manager's OWN account, so it goes
    // null again if that account is unlinked. Nothing then settles the name.
    stageMembers([member('a', 'fullName,manager', { managerIdentityId: null })]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [
      twin('a', { managerIdentityId: 'mgr-1' }), twin('b', { managerIdentityId: 'mgr-2' }),
    ])).toBe(1);
    expect(detached()).toEqual(['p-erp']);
  });
});

describe('removeStaleNameOnlyLinks — the evidence is read off the account row', () => {
  it('asks for the department and the manager’s identity in the member scan', async () => {
    // The two columns the cases above are decided on are not in the base member
    // scan: without them every evidence-settled link reads as stale on a real
    // database while every test here still passes on its staged rows.
    stageMembers([]);
    await removeStaleNameOnlyLinks(DEFAULT_RULES, [twin('a')]);

    const [sql] = query.mock.calls.find(c => /FROM "IdentityMembers" m/.test(c[0]));
    expect(sql).toMatch(/p\."department"/);
    expect(sql).toMatch(/AS "managerIdentityId"/);
    // Resolved through the manager's own account, not off the Principals row —
    // `managerId` names a principal and the guard compares the person behind it.
    expect(sql).toMatch(/im\."principalId" = p\."managerId"/);
  });
});
