// Shared staging for the `removeStaleNameOnlyLinks` unit tests.
//
// Every one of those tests asks the same two things of the mocked database —
// "here are the member rows the cleanup reads back" and "which principals did it
// detach?" — and most of them also need the shipped dictionary with one signal's
// weight replaced. Each test file had its own copy, which is a jscpd clone and,
// worse, three places for the `FROM "IdentityMembers" m` / `DELETE FROM
// "IdentityMembers"` SQL shapes to drift apart from the module under test.
//
// `query` is imported from `../src/db/connection.js` — the same module the test
// files mock as `../db/connection.js`. Vitest keys `vi.mock` on the RESOLVED
// path, so the spy this module closes over is the test's spy, and the hoisting
// problem that keeps `vi.mock(...)` itself in each test file (see
// routeTestKit.js) does not apply here.

import { DEFAULT_RULES } from '../src/accountlinking/defaultRules.js';
import { query } from '../src/db/connection.js';

/**
 * The shipped dictionary with one signal's weight replaced — the off-switch
 * (weight 0) and the re-tuning cases both go through this.
 */
export const reweighted = (name, weight) => ({
  ...DEFAULT_RULES,
  signals: DEFAULT_RULES.signals.map(s => (s.name === name ? { ...s, weight } : s)),
});

/**
 * Stage the member rows the cleanup reads back; every other query answers empty.
 * Call after `query.mockReset()`.
 */
export function stageMembers(rows) {
  query.mockImplementation(async (sql) => {
    if (/FROM "IdentityMembers" m/.test(sql)) return { rows };
    return { rows: [] };
  });
}

/**
 * The principals the cleanup detached, in the order it detached them — so a test
 * asserts *which* links went, not merely how many. A count alone passes on a
 * cleanup that detaches everything.
 */
export const detached = () => query.mock.calls
  .filter(c => /DELETE FROM "IdentityMembers"/.test(c[0]))
  .map(c => c[1][1]);
