// Unit tests for the retroactive cleanup behind the name-only corroboration guard.
//
// This is the only code in account linking that DELETES a member row, so the cases that
// matter most are the ones where it must do nothing: a rule set with no name signals at
// all (every stored link would otherwise look name-only and the whole table would be
// detached), and a link that carries a second signal. The run-level wiring is covered in
// engine.runLinking.test.js; this file drives the helper directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeStaleNameOnlyLinks } from './staleNameOnlyLinks.js';
import { DEFAULT_RULES } from './defaultRules.js';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';

/** Stage the member scan; every later write resolves empty. */
function stageMembers(rows) {
  query.mockImplementation(async (sql) => {
    if (/SELECT "identityId", "principalId", "linkSignals"/.test(sql)) return { rows };
    return { rows: [] };
  });
}

const deletes = () => query.mock.calls.filter(c => /DELETE FROM "IdentityMembers"/.test(c[0]));
const countRecomputes = () =>
  query.mock.calls.filter(c => /UPDATE\s+"Identities"/.test(c[0]) && /"accountCount"/.test(c[0]));

beforeEach(() => { query.mockReset(); });

describe('removeStaleNameOnlyLinks', () => {
  it('removes a name-only link and recomputes its identity account count once', () => {
    stageMembers([
      { identityId: 'i1', principalId: 'p1', linkSignals: 'fullName' },
      { identityId: 'i1', principalId: 'p2', linkSignals: 'surnameInitial' },
    ]);
    return removeStaleNameOnlyLinks(DEFAULT_RULES).then((removed) => {
      expect(removed).toBe(2);
      expect(deletes().map(c => c[1])).toEqual([['i1', 'p1'], ['i1', 'p2']]);
      // Both rows hung off one identity -- recomputing per identity, not per row.
      expect(countRecomputes()).toHaveLength(1);
    });
  });

  it('recomputes the count for every affected identity', async () => {
    stageMembers([
      { identityId: 'i1', principalId: 'p1', linkSignals: 'fullName' },
      { identityId: 'i2', principalId: 'p2', linkSignals: 'fullName' },
    ]);
    await removeStaleNameOnlyLinks(DEFAULT_RULES);
    expect(countRecomputes().map(c => c[1][0]).sort()).toEqual(['i1', 'i2']);
  });

  it('leaves a link alone once a non-name signal corroborates it', async () => {
    stageMembers([
      { identityId: 'i1', principalId: 'p1', linkSignals: 'email,fullName' },
      { identityId: 'i1', principalId: 'p2', linkSignals: 'employeeId' },
      { identityId: 'i1', principalId: 'p3', linkSignals: 'emailPrefix,fullName' },
    ]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES)).toBe(0);
    expect(deletes()).toHaveLength(0);
    expect(countRecomputes()).toHaveLength(0);
  });

  it('leaves a row with no recorded signals alone', async () => {
    // An empty signal list is not "all signals are names" -- it is no information, and
    // deleting on no information would detach rows nobody can explain.
    stageMembers([
      { identityId: 'i1', principalId: 'p1', linkSignals: null },
      { identityId: 'i1', principalId: 'p2', linkSignals: '' },
    ]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES)).toBe(0);
    expect(deletes()).toHaveLength(0);
  });

  it('does nothing — and does not even scan — when the rules define no name signals', async () => {
    // Without the guard, nameSigs is empty, isNameOnly is false for every row anyway, but
    // the scan would still run on every linking run of a tenant that removed its name
    // signals. More importantly it pins the intent: no name signals, nothing to clean up.
    stageMembers([{ identityId: 'i1', principalId: 'p1', linkSignals: 'fullName' }]);
    expect(await removeStaleNameOnlyLinks({ signals: [{ type: 'exact', name: 'email' }] })).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('reports zero when nothing is linked at all', async () => {
    stageMembers([]);
    expect(await removeStaleNameOnlyLinks(DEFAULT_RULES)).toBe(0);
    expect(deletes()).toHaveLength(0);
  });
});
