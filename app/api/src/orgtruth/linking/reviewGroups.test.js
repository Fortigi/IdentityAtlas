import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { groupCandidates, listReviewGroups, decideGroup } from './reviewGroups.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const row = (value, targetId, confidence, entities, extra = {}) => ({ entityType: 'Uren', via: 'klant', value, targetType: 'OrgEntity', targetId, confidence, entities, ...extra });

beforeEach(() => query.mockReset());

describe('groupCandidates', () => {
  it('one group per entity type, attribute, value and target type, weakest first; candidates strongest first', () => {
    const labels = new Map([[`OrgEntity|${T1}`, 'Contoso Harbour'], [`OrgEntity|${T2}`, 'Contoso Port']]);
    const groups = groupCandidates([
      row('Contoso Haven B.V.', T1, 50, 42),
      row('Contoso Haven B.V.', T2, 55, 42),
      row('Northwind', T1, 30, 3),
      row('Contoso Haven B.V.', T1, 80, 7, { targetType: 'Resource' }),
    ], labels);
    expect(groups.map(g => [g.value, g.targetType, g.entities, g.bestConfidence])).toEqual([
      ['Northwind', 'OrgEntity', 3, 30],
      ['Contoso Haven B.V.', 'OrgEntity', 42, 55],
      ['Contoso Haven B.V.', 'Resource', 7, 80],
    ]);
    expect(groups[1].candidates).toEqual([
      { targetId: T2, label: 'Contoso Port', confidence: 55, entities: 42 },
      { targetId: T1, label: 'Contoso Harbour', confidence: 50, entities: 42 },
    ]);
  });

  it('on equal confidence the group with more rows comes first, and an unknown label is null', () => {
    const g = groupCandidates([row('A', T1, 50, 2), row('B', T1, 50, 9)], new Map());
    expect(g.map(x => x.value)).toEqual(['B', 'A']);
    expect(g[0].candidates[0].label).toBeNull();
  });
});

describe('listReviewGroups', () => {
  it('reads proposed rows (default), labels them and pages the groups', async () => {
    query.mockImplementation(async (sql) => (String(sql).includes('GROUP BY 1, 2, 3, 4, 5')
      ? { rows: [row('Contoso Haven B.V.', T1, 50, 42)] }
      : { rows: [{ id: T1, displayName: 'Contoso Harbour' }] }));
    const out = await listReviewGroups({});
    expect(query.mock.calls[0][1]).toEqual(['proposed', null]);
    expect(out).toMatchObject({ kind: 'groups', status: 'proposed', total: 1, page: 1 });
    expect(out.rows[0].candidates[0].label).toBe('Contoso Harbour');
  });
});

describe('decideGroup', () => {
  const base = { entityType: 'Uren', via: 'klant', value: 'Contoso Haven B.V.', targetType: 'OrgEntity' };

  it('confirmed: accepts that target for the whole group and rejects the group\'s other targets, in one tx', async () => {
    query.mockResolvedValueOnce({ rowCount: 42 }).mockResolvedValueOnce({ rowCount: 42 });
    const out = await decideGroup({ ...base, targetId: T1, action: 'confirmed' }, { preferred_username: 'analyst@contoso.com' });
    expect(out).toEqual({ accepted: 42, rejected: 42 });
    const [acceptSql, acceptParams] = query.mock.calls[0];
    expect(acceptSql).toMatch(/SET "status" = 'accepted', "analystOverride" = 'confirmed'/);
    expect(acceptSql).toMatch(/"targetId" = \$6/);
    expect(acceptParams).toEqual(['Uren', 'klant', 'Contoso Haven B.V.', 'OrgEntity', 'analyst@contoso.com', T1]);
    expect(query.mock.calls[1][0]).toMatch(/"targetId" <> \$6/);
  });

  it('rejected without a target rejects every proposal in the group; with a target only that one', async () => {
    query.mockResolvedValueOnce({ rowCount: 3 });
    expect(await decideGroup({ ...base, action: 'rejected' })).toEqual({ accepted: 0, rejected: 3 });
    expect(query.mock.calls[0][1]).toEqual(['Uren', 'klant', 'Contoso Haven B.V.', 'OrgEntity', 'anonymous']);
    query.mockResolvedValueOnce({ rowCount: 1 });
    await decideGroup({ ...base, targetId: T2, action: 'rejected' });
    expect(query.mock.calls[1][1][5]).toBe(T2);
  });

  it('404 when nothing in the group is open; 400 on bad input', async () => {
    query.mockResolvedValue({ rowCount: 0 });
    await expect(decideGroup({ ...base, targetId: T1, action: 'confirmed' })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(decideGroup({ ...base, action: 'rejected' })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(decideGroup({ ...base, action: 'confirmed' })).rejects.toMatchObject({ httpStatus: 400, message: 'Confirming needs the targetId of the candidate.' });
    await expect(decideGroup({ ...base, action: 'moved', targetId: T1 })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(decideGroup({ ...base, value: '', action: 'rejected' })).rejects.toMatchObject({ httpStatus: 400, message: 'value is required.' });
    await expect(decideGroup({ ...base, targetId: 'x', action: 'rejected' })).rejects.toMatchObject({ httpStatus: 400 });
  });
});
