import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { getActorActivity, shapeActor } from './actor.js';

const P = 'p0000000-0000-4000-8000-000000000001';
const I = 'i0000000-0000-4000-8000-000000000001';
const C1 = 'c0000000-0000-4000-8000-000000000001';
const C2 = 'c0000000-0000-4000-8000-000000000002';
const R1 = 'r0000000-0000-4000-8000-000000000001';

const row = (o) => ({ activityType: 'Uren', unit: 'h', subjectType: 'OrgEntity', subjectId: C1, subjectLabel: 'Contoso', actorType: 'Principal', actorId: P, rowCount: 1, total: 1, lastOn: '2026-03-01', ...o });

describe('shapeActor', () => {
  const out = shapeActor([
    row({ total: 8, lastOn: '2026-03-01' }),
    row({ actorType: 'Identity', actorId: I, total: 4, lastOn: '2026-09-01' }),   // same customer via the identity: merged
    row({ subjectId: C2, subjectLabel: 'Northwind', total: 20 }),
    row({ subjectId: null, subjectType: null, subjectLabel: null, rowCount: 6, total: 3 }),
    row({ activityType: 'Calls', unit: null, subjectType: 'Resource', subjectId: R1, subjectLabel: 'Finance share', total: 1 }),
  ], new Set([`OrgEntity:${C1}`, `Resource:${R1}`]));

  it('one group per activity type, alphabetical; unresolved subjects counted', () => {
    expect(out.groups.map(g => [g.type, g.unit, g.unresolvedRows])).toEqual([['Calls', null, 0], ['Uren', 'h', 6]]);
  });

  it('subjects merged across the person\'s records, most total first, with membership', () => {
    expect(out.groups[1].subjects).toEqual([
      { targetType: 'OrgEntity', targetId: C2, label: 'Northwind', total: 20, lastOn: '2026-03-01', isMember: false },
      { targetType: 'OrgEntity', targetId: C1, label: 'Contoso', total: 12, lastOn: '2026-09-01', isMember: true },
    ]);
    expect(out.groups[0].subjects[0]).toMatchObject({ targetType: 'Resource', isMember: true });
  });

  it('no rows, no groups', () => {
    expect(shapeActor([], new Set())).toEqual({ groups: [] });
  });
});

describe('getActorActivity', () => {
  beforeEach(() => query.mockReset());

  it('an identity widens to its accounts; membership through entity links and resource assignments', async () => {
    query.mockImplementation(async (raw) => {
      const sql = String(raw);
      if (sql.includes('FROM "IdentityMembers"')) return { rows: [{ principalId: P }] };
      if (sql.includes('FROM "OrgActivities" a')) return { rows: [row({}), row({ subjectType: 'Resource', subjectId: R1 })] };
      if (sql.includes('FROM "OrgLinks"')) return { rows: [{ id: C1 }] };
      if (sql.includes('"ResourceAssignments"')) return { rows: [] };
      return { rows: [] };
    });
    const out = await getActorActivity('Identity', I);
    const act = query.mock.calls.find(([s]) => s.includes('FROM "OrgActivities" a'));
    expect(act[1]).toEqual([['Identity', 'Principal'], [I, P]]);
    expect(query.mock.calls.find(([s]) => s.includes('FROM "OrgLinks"'))[1]).toEqual([[C1], ['Identity', 'Principal'], [I, P]]);
    expect(query.mock.calls.find(([s]) => s.includes('"ResourceAssignments"'))[1]).toEqual([[R1], [P]]);
    expect(out.groups[0].subjects.map(s => [s.targetId, s.isMember])).toEqual([[C1, true], [R1, false]]);
  });

  it('an identity without accounts asks no assignment question; no activity asks nothing more', async () => {
    query.mockImplementation(async (raw) => {
      const sql = String(raw);
      if (sql.includes('FROM "OrgActivities" a')) return { rows: [row({ subjectType: 'Resource', subjectId: R1 })] };
      return { rows: [] };
    });
    await getActorActivity('Identity', I);
    expect(query.mock.calls.some(([s]) => s.includes('"ResourceAssignments"'))).toBe(false);
    expect(query.mock.calls.some(([s]) => s.includes('FROM "OrgLinks"'))).toBe(false);
  });
});
