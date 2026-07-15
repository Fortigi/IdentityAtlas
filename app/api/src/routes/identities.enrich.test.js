/**
 * Unit test for enrichMembers() in identities.js.
 *
 * Regression: the identity-detail handler keyed its risk and group-count maps by
 * `userId` — a column none of the source queries select (they select principalId)
 * — so member group counts always rendered 0 and risk score/tier never attached.
 * enrichMembers keys by principalId; these tests pin that and guard the old bug.
 */
import { describe, it, expect, vi } from 'vitest';

// Keep the module import side-effect-free (no pool creation / timers).
vi.mock('../db/connection.js', () => ({ getPool: vi.fn(), queryOne: vi.fn(), query: vi.fn() }));
vi.mock('../perf/sqlTimer.js', () => ({
  timedQuery: async () => ({ rows: [] }),
  getQueryTimings: () => [],
}));

const { enrichMembers } = await import('./identities.js');

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';

describe('enrichMembers', () => {
  it('attaches group counts + risk keyed by principalId', () => {
    const members = [{ principalId: P1 }, { principalId: P2 }];
    const riskRows = [{ principalId: P1, riskScore: 80, riskTier: 'High' }];
    const groupRows = [{ principalId: P1, groupCount: 7 }, { principalId: P2, groupCount: 3 }];

    enrichMembers(members, riskRows, groupRows);

    expect(members[0].groupCount).toBe(7);
    expect(members[0].riskScore).toBe(80);
    expect(members[0].riskTier).toBe('High');
    // P2 has a group count but no risk row → count attached, risk left unset.
    expect(members[1].groupCount).toBe(3);
    expect(members[1].riskScore).toBeUndefined();
  });

  it('defaults group count to 0 and leaves risk unset when nothing matches', () => {
    const members = [{ principalId: P1 }];
    enrichMembers(members, [], []);
    expect(members[0].groupCount).toBe(0);
    expect(members[0].riskScore).toBeUndefined();
  });

  it('does NOT enrich from a userId field (regression guard for the original bug)', () => {
    const members = [{ principalId: P1, userId: P1 }];
    // Rows in the OLD, wrong shape (only userId) must not match → no enrichment.
    enrichMembers(members, [{ userId: P1, riskScore: 99, riskTier: 'High' }], [{ userId: P1, groupCount: 5 }]);
    expect(members[0].groupCount).toBe(0);
    expect(members[0].riskScore).toBeUndefined();
  });
});
