import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('./activityResolve.js', async (importOriginal) => ({ ...(await importOriginal()), loadRoleIndexes: vi.fn() }));

import { query, queryOne } from '../../db/connection.js';
import { buildRuleIndex } from '../linking/candidates.js';
import { activityKeyRules } from '../referenceRules.js';
import { loadRoleIndexes } from './activityResolve.js';
import { listKeys, decideKeyReview, PAGE_SIZE } from './activityKeys.js';

const KEY = '0a0a0a0a-1111-4111-8111-111111111111';
const TARGET = '0b0b0b0b-2222-4222-8222-222222222222';
const recipe = {
  version: 1, template: 'activity',
  activity: { type: 'Hours', actor: { column: 'c3', targetTypes: ['Principal'] }, subject: { column: 'c4', targetType: 'OrgEntity' }, when: { dateColumn: 'c1' }, attributes: [] },
};
const key = (over) => ({ id: KEY, profileName: 'Hours', role: 'subject', rawValue: 'Northwind', targetType: null, targetId: null, confidence: 0, status: 'unmatched', rows: 4, targetLabel: null, total: 2, ...over });

beforeEach(() => {
  query.mockReset(); queryOne.mockReset(); loadRoleIndexes.mockReset();
  loadRoleIndexes.mockImplementation(async (rec, role) => activityKeyRules(rec, role).map(rule => buildRuleIndex([{ id: 'o-nw', displayName: 'Northwind Traders', entityType: 'Customer' }], rule)));
});

describe('listKeys', () => {
  it('passes the filters and the page offset; most referenced first; target labels from every target table', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await listKeys({ status: 'proposed', role: 'actor', profileName: 'Hours', page: 3 })).toEqual({ data: [], total: 0 });
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['proposed', 'actor', 'Hours', 2 * PAGE_SIZE]);
    expect(PAGE_SIZE).toBe(50);
    expect(sql).toMatch(/ORDER BY q\."rows" DESC, q\."rawValue", q\."id"\s+LIMIT 50 OFFSET \$4/);
    for (const table of ['Principals', 'Identities', 'Resources', 'OrgEntities']) expect(sql).toContain(`FROM "${table}" x WHERE x."id" = k."targetId"`);
    expect(sql).toMatch(/WHEN 'actor' THEN \(SELECT count\(\*\)::int FROM "OrgActivities" a WHERE a\."actorKeyId" = k\."id"\)/);
  });

  it('defaults: no filter, page 1', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await listKeys();
    expect(query.mock.calls[0][1]).toEqual([null, null, null, 0]);
  });

  it('offers candidates only on keys that are not accepted, from the latest version of their profile, loaded once per profile and role', async () => {
    query.mockResolvedValueOnce({ rows: [
      key({}),
      key({ id: 'k2', rawValue: 'Northwind Traders', status: 'proposed' }),
      key({ id: 'k3', rawValue: 'Contoso', status: 'accepted', targetType: 'OrgEntity', targetId: 'o-c', targetLabel: 'Contoso' }),
    ] });
    queryOne.mockResolvedValue({ recipe });
    const out = await listKeys({});
    expect(out.total).toBe(2);
    expect(out.data[0]).toEqual({
      id: KEY, profileName: 'Hours', role: 'subject', rawValue: 'Northwind', targetType: null, targetId: null, confidence: 0, status: 'unmatched', rows: 4, targetLabel: null,
      candidates: [{ targetType: 'OrgEntity', targetId: 'o-nw', label: 'Northwind Traders', confidence: 85 }],
    });
    expect(out.data[1].candidates[0]).toMatchObject({ targetId: 'o-nw', confidence: 100 });
    expect('candidates' in out.data[2]).toBe(false);
    expect('total' in out.data[2]).toBe(false);
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(queryOne.mock.calls[0]).toEqual([expect.stringMatching(/WHERE "name" = \$1 ORDER BY "version" DESC LIMIT 1/), ['Hours']]);
    expect(loadRoleIndexes).toHaveBeenCalledTimes(1);
  });

  it('a key whose profile is gone or no longer an activity gets no candidates', async () => {
    query.mockResolvedValueOnce({ rows: [key({})] });
    queryOne.mockResolvedValueOnce({ recipe: { version: 1, entities: [] } });
    const out = await listKeys({});
    expect('candidates' in out.data[0]).toBe(false);
    expect(loadRoleIndexes).not.toHaveBeenCalled();
  });
});

describe('decideKeyReview', () => {
  it('accepts with the target given: an analyst decision, checked to exist', async () => {
    queryOne
      .mockResolvedValueOnce({ id: KEY, targetType: null, targetId: null })
      .mockResolvedValueOnce({ found: 1 })
      .mockResolvedValueOnce({ id: KEY, status: 'accepted' });
    const out = await decideKeyReview(KEY, { status: 'accepted', targetType: 'OrgEntity', targetId: TARGET }, 'ann@contoso.com');
    expect(out).toEqual({ key: { id: KEY, status: 'accepted' } });
    expect(queryOne.mock.calls[1]).toEqual(['SELECT 1 AS "found" FROM "OrgEntities" WHERE "id" = $1', [TARGET]]);
    const [sql, params] = queryOne.mock.calls[2];
    expect(params).toEqual([KEY, 'accepted', 'OrgEntity', TARGET, 'ann@contoso.com']);
    expect(sql).toMatch(/"analystOverride" = true, "decidedBy" = \$5/);
    expect(sql).toMatch(/"confidence" = CASE WHEN "targetId" IS DISTINCT FROM \$4 THEN 100 ELSE "confidence" END/);
  });

  it('accepts the proposed target when none is given', async () => {
    queryOne
      .mockResolvedValueOnce({ id: KEY, targetType: 'Principal', targetId: TARGET })
      .mockResolvedValueOnce({ found: 1 })
      .mockResolvedValueOnce({ id: KEY });
    await decideKeyReview(KEY, { status: 'accepted' }, 'a');
    expect(queryOne.mock.calls[1][0]).toContain('FROM "Principals"');
    expect(queryOne.mock.calls[2][1]).toEqual([KEY, 'accepted', 'Principal', TARGET, 'a']);
  });

  it('rejects, keeping the target it had', async () => {
    queryOne.mockResolvedValueOnce({ id: KEY, targetType: 'Principal', targetId: TARGET }).mockResolvedValueOnce({ id: KEY });
    await decideKeyReview(KEY, { status: 'rejected', targetType: 'Resource', targetId: KEY }, 'a');
    expect(queryOne).toHaveBeenCalledTimes(2);
    expect(queryOne.mock.calls[1][1]).toEqual([KEY, 'rejected', 'Principal', TARGET, 'a']);
  });

  it.each([
    [{ status: 'proposed' }, 'status must be accepted or rejected.'],
    [undefined, 'status must be accepted or rejected.'],
  ])('400 for %j', async (body, error) => {
    expect(await decideKeyReview(KEY, body, 'a')).toEqual({ status: 400, error });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404 for an unknown or malformed key', async () => {
    queryOne.mockResolvedValueOnce(undefined);
    expect(await decideKeyReview(KEY, { status: 'rejected' }, 'a')).toEqual({ status: 404, error: 'Activity key not found.' });
    expect(await decideKeyReview('nope', { status: 'rejected' }, 'a')).toEqual({ status: 404, error: 'Activity key not found.' });
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 'accepted' }, 'Accepting a value needs a target: send targetType and targetId.'],
    [{ status: 'accepted', targetType: 'Context', targetId: TARGET }, 'targetType must be one of Principal, Identity, Resource, OrgEntity.'],
    [{ status: 'accepted', targetType: 'Resource', targetId: '42' }, 'targetId is not a valid id.'],
    [{ status: 'accepted', targetType: 'Resource', targetId: TARGET }, `No Resource with id ${TARGET} exists.`],
  ])('400 when accepting without a usable target: %j', async (body, error) => {
    queryOne.mockResolvedValueOnce({ id: KEY, targetType: null, targetId: null }).mockResolvedValueOnce(undefined);
    expect(await decideKeyReview(KEY, body, 'a')).toEqual({ status: 400, error });
    expect(queryOne.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(false);
  });
});
