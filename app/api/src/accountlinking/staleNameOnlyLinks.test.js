// Unit tests for the retroactive cleanup behind the name-only guard.
//
// This is the only code in account linking that DELETES a member row, so the cases that
// matter most are the ones where it must do nothing: a rule set with no name signals at
// all (every stored link would otherwise look name-only and the whole table would be
// detached), a link that carries a second signal, and — under the shipped policy — a
// name-only link whose name still points at exactly the identity it is attached to, which
// is the bulk of them on any real tenant. The run-level wiring is covered in
// engine.runLinking.test.js; this file drives the helper directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeStaleNameOnlyLinks } from './staleNameOnlyLinks.js';
import { DEFAULT_RULES } from './defaultRules.js';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';

const STRICT = { ...DEFAULT_RULES, allowNameOnlyLinks: false };

// Two people whose given names share an initial, and one nobody is near.
const IDENTITIES = [
  { id: 'jan', displayName: 'Jan Jansen' },
  { id: 'johannes', displayName: 'Johannes Jansen' },
  { id: 'euson', displayName: 'Euson, Robin' },
];

/** Stage the member scan; every later write resolves empty. */
function stageMembers(rows) {
  query.mockImplementation(async (sql) => {
    if (/FROM "IdentityMembers" m/.test(sql)) return { rows };
    return { rows: [] };
  });
}

const deletes = () => query.mock.calls.filter(c => /DELETE FROM "IdentityMembers"/.test(c[0]));
const countRecomputes = () =>
  query.mock.calls.filter(c => /UPDATE\s+"Identities"/.test(c[0]) && /"accountCount"/.test(c[0]));

beforeEach(() => { query.mockReset(); });

describe('removeStaleNameOnlyLinks - the shipped policy', () => {
  it('detaches a link whose name a second person also answers to', () => {
    // 'Jan Jansen' is also a plausible spelling of Johannes, so the engine would no
    // longer make this link: it is exactly the wrong link #1440 reported, and leaving
    // it attached would mean the guard only ever applied to new data.
    stageMembers([{ identityId: 'jan', principalId: 'p-amb', linkSignals: 'fullName', displayName: 'Jan Jansen' }]);
    return removeStaleNameOnlyLinks(DEFAULT_RULES, IDENTITIES).then((removed) => {
      expect(removed).toBe(1);
      expect(deletes().map(c => c[1])).toEqual([['jan', 'p-amb']]);
      expect(countRecomputes().map(c => c[1][0])).toEqual(['jan']);
    });
  });

  it('leaves a link whose name still points at the identity it is attached to', () => {
    // The paired case, and the common one: nobody else answers to this name, so the
    // link is one the engine would make today. Detaching and re-creating it would churn
    // every display-name-only account on the tenant for nothing.
    stageMembers([{ identityId: 'euson', principalId: 'p-ok', linkSignals: 'fullName', displayName: 'Euson, Robin' }]);
    return removeStaleNameOnlyLinks(DEFAULT_RULES, IDENTITIES).then((removed) => {
      expect(removed).toBe(0);
      expect(deletes()).toHaveLength(0);
      expect(countRecomputes()).toHaveLength(0);
    });
  });

  it('detaches a link whose name points at somebody ELSE', async () => {
    // Unique, but not to the identity it hangs off — an older run's mistake, or an
    // analyst-free move. Asking only "is this name unique" would keep it attached.
    stageMembers([{ identityId: 'jan', principalId: 'p-mis', linkSignals: 'fullName', displayName: 'Euson, Robin' }]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, IDENTITIES)).toBe(1);
    expect(deletes().map(c => c[1])).toEqual([['jan', 'p-mis']]);
  });

  it('weighs each link on its own', async () => {
    stageMembers([
      { identityId: 'jan', principalId: 'p-amb', linkSignals: 'fullName', displayName: 'Jan Jansen' },
      { identityId: 'euson', principalId: 'p-ok', linkSignals: 'fullName', displayName: 'Euson, Robin' },
    ]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, IDENTITIES)).toBe(1);
    expect(deletes().map(c => c[1])).toEqual([['jan', 'p-amb']]);
  });
});

describe('removeStaleNameOnlyLinks - rivalry at the matched level (#1460)', () => {
  // Three unrelated people sharing a surname whose given names all start with Y.
  const EL_MAHDI = [
    { id: 'youssef', displayName: 'Youssef El Mahdi' },
    { id: 'yasmina', displayName: 'Yasmina El Mahdi' },
    { id: 'yassin', displayName: 'Yassin El Mahdi' },
  ];

  it('leaves a link whose name is the exact spelling of only its own identity', async () => {
    // This is the retroactive half of the regression: the same reading that holds
    // the new match detaches the stored one, so the first run after an upgrade
    // strips the whole class off the identities that already had them.
    stageMembers([{
      identityId: 'youssef', principalId: 'p-you', linkSignals: 'fullName', displayName: 'Youssef El Mahdi',
    }]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, EL_MAHDI)).toBe(0);
    expect(deletes()).toHaveLength(0);
    expect(countRecomputes()).toHaveLength(0);
  });

  it('still detaches a link whose name a second person is spelled exactly too', async () => {
    // The paired case: a real namesake means the engine would not make this link
    // today, so leaving it attached would keep the guard new-data-only.
    const twin = { id: 'twin', displayName: 'Youssef El Mahdi' };
    stageMembers([{
      identityId: 'youssef', principalId: 'p-twin', linkSignals: 'fullName', displayName: 'Youssef El Mahdi',
    }]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, [...EL_MAHDI, twin])).toBe(1);
    expect(deletes().map(c => c[1])).toEqual([['youssef', 'p-twin']]);
  });
});

describe('removeStaleNameOnlyLinks - allowNameOnlyLinks: false', () => {
  it('removes a name-only link and recomputes its identity account count once', () => {
    // Under the stricter policy the engine makes no name-only link at all, so even the
    // unambiguous ones go — including the surnameInitial-only link a lowered threshold
    // once allowed.
    stageMembers([
      { identityId: 'euson', principalId: 'p1', linkSignals: 'fullName', displayName: 'Euson, Robin' },
      { identityId: 'euson', principalId: 'p2', linkSignals: 'surnameInitial', displayName: 'Euson, R' },
    ]);
    return removeStaleNameOnlyLinks(STRICT, IDENTITIES).then((removed) => {
      expect(removed).toBe(2);
      expect(deletes().map(c => c[1])).toEqual([['euson', 'p1'], ['euson', 'p2']]);
      // Both rows hung off one identity -- recomputing per identity, not per row.
      expect(countRecomputes()).toHaveLength(1);
    });
  });

  it('recomputes the count for every affected identity', async () => {
    stageMembers([
      { identityId: 'jan', principalId: 'p1', linkSignals: 'fullName', displayName: 'Jan Jansen' },
      { identityId: 'euson', principalId: 'p2', linkSignals: 'fullName', displayName: 'Euson, Robin' },
    ]);
    await removeStaleNameOnlyLinks(STRICT, IDENTITIES);
    expect(countRecomputes().map(c => c[1][0]).sort()).toEqual(['euson', 'jan']);
  });

  it('does not need the identities to decide', async () => {
    // Nothing about this policy depends on who else answers to the name, so it must not
    // quietly keep a link when the identity list is empty.
    stageMembers([{ identityId: 'euson', principalId: 'p1', linkSignals: 'fullName', displayName: 'Euson, Robin' }]);
    expect(await removeStaleNameOnlyLinks(STRICT, [])).toBe(1);
  });
});

describe('removeStaleNameOnlyLinks - what it never touches', () => {
  it('leaves a link alone once a non-name signal corroborates it', async () => {
    // True under either policy: the engine still makes these links.
    stageMembers([
      { identityId: 'jan', principalId: 'p1', linkSignals: 'email,fullName', displayName: 'Jan Jansen' },
      { identityId: 'jan', principalId: 'p2', linkSignals: 'employeeId', displayName: 'Jan Jansen' },
      { identityId: 'jan', principalId: 'p3', linkSignals: 'emailPrefix,fullName', displayName: 'Jan Jansen' },
    ]);
    expect(await removeStaleNameOnlyLinks(STRICT, IDENTITIES)).toBe(0);
    expect(deletes()).toHaveLength(0);
    expect(countRecomputes()).toHaveLength(0);
  });

  it('leaves a row with no recorded signals alone', async () => {
    // An empty signal list is not "all signals are names" -- it is no information, and
    // deleting on no information would detach rows nobody can explain.
    stageMembers([
      { identityId: 'jan', principalId: 'p1', linkSignals: null, displayName: 'Jan Jansen' },
      { identityId: 'jan', principalId: 'p2', linkSignals: '', displayName: 'Jan Jansen' },
    ]);
    expect(await removeStaleNameOnlyLinks(STRICT, IDENTITIES)).toBe(0);
    expect(deletes()).toHaveLength(0);
  });

  it('does nothing — and does not even scan — when the rules define no name signals', async () => {
    // Without the guard, nameSigs is empty, isNameOnly is false for every row anyway, but
    // the scan would still run on every linking run of a tenant that removed its name
    // signals. More importantly it pins the intent: no name signals, nothing to clean up.
    stageMembers([{ identityId: 'jan', principalId: 'p1', linkSignals: 'fullName', displayName: 'Jan Jansen' }]);
    expect(await removeStaleNameOnlyLinks({ signals: [{ type: 'exact', name: 'email' }] }, IDENTITIES)).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('reports zero when nothing is linked at all', async () => {
    stageMembers([]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES, IDENTITIES)).toBe(0);
    expect(deletes()).toHaveLength(0);
  });

  it('reads the account name from the member scan, so every row can be weighed', async () => {
    // The names come from the JOIN onto Principals. Dropped from the SELECT, every row
    // reads as a nameless account, points at nobody, and the whole table is detached.
    stageMembers([]);
    await removeStaleNameOnlyLinks(DEFAULT_RULES, IDENTITIES);
    const scan = query.mock.calls[0][0];
    expect(scan).toMatch(/JOIN "Principals" p ON p\."id" = m\."principalId"/);
    expect(scan).toMatch(/p\."displayName", p\."givenName", p\."surname"/);
  });
});
