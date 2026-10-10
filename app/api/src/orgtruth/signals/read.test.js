import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { getSignals } from './read.js';

beforeEach(() => query.mockReset());

describe('getSignals', () => {
  it('reads the type\'s collection entities, the activity on them, their members, the people\'s identities and labels', async () => {
    query.mockImplementation(async (raw) => {
      const sql = String(raw);
      if (sql.includes('"WorkerConfig"')) return { rows: [{ configValue: JSON.stringify({ Klant: { inactiveAfterMonths: 2 } }) }] };
      if (sql.includes('FROM "OrgActivities" a')) return { rows: [{ subjectId: 'c1', actorType: 'Identity', actorId: 'iA', lastOn: '2026-09-01', total: 4, rowCount: 1 }] };
      if (sql.includes('FROM "OrgLinks" l')) return { rows: [{ orgEntityId: 'c1', via: 'team', targetType: 'Principal', targetId: 'b1' }] };
      if (sql.includes('"IdentityMembers"')) return { rows: [] };
      if (sql.includes('FROM "OrgEntities" e')) return { rows: [{ id: 'c1', displayName: 'Contoso', attributes: {} }] };
      return { rows: [] };
    });
    const out = await getSignals('Klant');
    expect(out).toMatchObject({ type: 'Klant', settings: { inactiveAfterMonths: 2 }, asOf: '2026-09-01' });
    expect(out.findings.memberWithoutActivity).toEqual([
      { entityId: 'c1', label: 'Contoso', member: { targetType: 'Principal', targetId: 'b1', label: null }, role: 'team', lastOn: null },
    ]);
    expect(out.findings.activeWithoutMembership.map(f => f.actor.targetId)).toEqual(['iA']);
    const ent = query.mock.calls.find(([s]) => String(s).includes('ORDER BY e."displayName"'));
    expect(ent[0]).toMatch(/COALESCE\(\(SELECT p\."template"[\s\S]*\), 'collection'\) = 'collection'/);
    expect(ent[1]).toEqual(['Klant']);
    const act = query.mock.calls.find(([s]) => String(s).includes('FROM "OrgActivities" a'));
    expect(act[0]).toMatch(/sk\."targetType" = 'OrgEntity' AND se\."entityType" = \$1 AND se\."status" = 'accepted' AND se\."validTo" IS NULL/);
    const fam = query.mock.calls.find(([s]) => String(s).includes('"IdentityMembers"'));
    expect(fam[1]).toEqual([['iA', 'b1']]);
  });
});
