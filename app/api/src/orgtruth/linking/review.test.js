import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { query, queryOne, tx } from '../../db/connection.js';
import {
  reviewParams, listReview, listClaims, overrideLink, clearOverride, setClaimStatus, loadLabels,
  actorOf, isUuid, ReviewError, PAGE_SIZE,
} from './review.js';

const L1 = '10000000-0000-4000-8000-000000000001';
const L2 = '10000000-0000-4000-8000-000000000002';
const E1 = '20000000-0000-4000-8000-000000000001';
const U1 = '30000000-0000-4000-8000-000000000001';
const U2 = '30000000-0000-4000-8000-000000000002';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); tx.mockClear(); });

const sqlCalls = (re) => query.mock.calls.filter(([sql]) => re.test(sql));

describe('small helpers', () => {
  it('isUuid accepts a uuid in any case and nothing else', () => {
    expect(isUuid(L1)).toBe(true);
    expect(isUuid(L1.toUpperCase())).toBe(true);
    expect(isUuid(`${L1}x`)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
  it('actorOf follows T1: preferred_username, then oid, then anonymous', () => {
    expect(actorOf({ preferred_username: 'ann@contoso.com', oid: 'o1' })).toBe('ann@contoso.com');
    expect(actorOf({ oid: 'o1' })).toBe('o1');
    expect(actorOf(undefined)).toBe('anonymous');
  });
});

describe('reviewParams', () => {
  it('defaults to proposed, page 1, no entity type', () => {
    expect(reviewParams()).toEqual({ status: 'proposed', entityType: null, page: 1, offset: 0 });
    expect(reviewParams({ entityType: '   ' }).entityType).toBeNull();
  });
  it('pages by fifty', () => {
    expect(PAGE_SIZE).toBe(50);
    expect(reviewParams({ page: '3', entityType: ' Person ', status: 'accepted' }))
      .toEqual({ status: 'accepted', entityType: 'Person', page: 3, offset: 100 });
  });
  it('rejects a status outside proposed/accepted/rejected', () => {
    expect(() => reviewParams({ status: 'deleted' })).toThrow(ReviewError);
  });
  it('rejects page 0, a fraction, and text', () => {
    for (const page of ['0', '1.5', 'abc', '', '-1']) {
      const err = (() => { try { reviewParams({ page }); } catch (e) { return e; } return null; })();
      expect(err?.httpStatus, page).toBe(400);
    }
  });
});

describe('loadLabels', () => {
  it('reads one query per target type, ids de-duplicated, unknown types skipped', async () => {
    query.mockImplementation(async (sql) => ({
      rows: sql.includes('"Principals"') ? [{ id: U1, displayName: 'Ann' }] : [{ id: 'r1', displayName: 'SG_X' }],
    }));
    const labels = await loadLabels([
      { targetType: 'Principal', targetId: U1 }, { targetType: 'Principal', targetId: U1 },
      { targetType: 'Resource', targetId: 'r1' }, { targetType: 'Systems', targetId: 'x' },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual(['SELECT "id", "displayName" FROM "Principals" WHERE "id" = ANY($1::uuid[])', [[U1]]]);
    expect(labels.get(`Principal|${U1}`)).toBe('Ann');
    expect(labels.get('Resource|r1')).toBe('SG_X');
  });
});

describe('listReview', () => {
  const link = (id, confidence) => ({
    id, orgEntityId: E1, targetType: 'Principal', targetId: id === L1 ? U1 : U2, confidence, status: 'proposed',
    entityType: 'Person', entityDisplayName: 'Ann Smith',
  });

  it('returns a page of links with entity, labelled target and the entity\'s other candidates', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('LIMIT $3 OFFSET $4')) return { rows: [link(L1, 40)] };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 51 }] };
      if (sql.includes('"orgEntityId" = ANY')) {
        return { rows: [
          { id: L1, orgEntityId: E1, targetType: 'Principal', targetId: U1, confidence: 40, status: 'proposed', analystOverride: null },
          { id: L2, orgEntityId: E1, targetType: 'Principal', targetId: U2, confidence: 40, status: 'proposed', analystOverride: null },
        ] };
      }
      return { rows: [{ id: U1, displayName: 'Ann Smith (acct)' }, { id: U2, displayName: 'Ann Smith (other)' }] };
    });
    const out = await listReview({ page: '2', entityType: 'Person' });
    expect(out).toMatchObject({ kind: 'links', status: 'proposed', entityType: 'Person', page: 2, pageSize: 50, total: 51 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].entity).toEqual({ id: E1, entityType: 'Person', displayName: 'Ann Smith' });
    expect(out.rows[0].target).toEqual({ targetType: 'Principal', id: U1, label: 'Ann Smith (acct)' });
    expect(out.rows[0].link).not.toHaveProperty('entityDisplayName');
    expect(out.rows[0].candidates).toEqual([
      { id: L2, targetType: 'Principal', targetId: U2, confidence: 40, status: 'proposed', analystOverride: null, label: 'Ann Smith (other)' },
    ]);
    const [pageSql, pageParams] = sqlCalls(/LIMIT \$3 OFFSET \$4/)[0];
    expect(pageSql).toMatch(/ORDER BY l\."confidence" ASC/);
    expect(pageSql).toMatch(/e\."validTo" IS NULL/);
    expect(pageParams).toEqual(['proposed', 'Person', 50, 50]);
  });

  it('an empty page reads no siblings and no labels', async () => {
    query.mockImplementation(async (sql) => (sql.includes('COUNT(*)') ? { rows: [{ total: 3 }] } : { rows: [] }));
    const out = await listReview({ page: '9' });
    expect(out).toMatchObject({ total: 3, rows: [] });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('a missing count row is a total of zero', async () => {
    query.mockResolvedValue({ rows: [] });
    expect((await listReview({})).total).toBe(0);
  });
});

describe('listClaims', () => {
  it('pages proposed entities and relations, weakest first, with totals', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: sql.includes('"OrgRelations"') ? 1 : 2 }] };
      if (sql.includes('FROM "OrgRelations"')) return { rows: [{ id: 'r1', predicate: 'owner' }] };
      return { rows: [{ id: 'e1' }, { id: 'e2' }] };
    });
    const out = await listClaims({ entityType: 'Project' });
    expect(out).toMatchObject({
      kind: 'claims', status: 'proposed', page: 1, pageSize: 50,
      entities: { total: 2, rows: [{ id: 'e1' }, { id: 'e2' }] },
      relations: { total: 1, rows: [{ id: 'r1', predicate: 'owner' }] },
    });
    const [entSql, entParams] = sqlCalls(/FROM "OrgEntities" WHERE "status" = \$1.*LIMIT/s)[0];
    expect(entSql).toMatch(/ORDER BY "confidence" ASC NULLS FIRST/);
    expect(entParams).toEqual(['proposed', 'Project', 50, 0]);
  });

  it('a missing count row is a total of zero', async () => {
    query.mockResolvedValue({ rows: [] });
    const out = await listClaims({});
    expect(out.entities.total).toBe(0);
    expect(out.relations.total).toBe(0);
  });
});

describe('overrideLink', () => {
  const stored = { id: L1, orgEntityId: E1, targetType: 'Principal', targetId: U1, status: 'proposed' };

  beforeEach(() => {
    queryOne.mockImplementation(async (sql) => (sql.includes('FROM "OrgLinks"') ? stored : { id: U2 }));
    query.mockImplementation(async (sql, params) => ({ rows: [{ id: params[0], marker: sql.slice(0, 20) }] }));
  });

  it('400 on an unknown action, before any read', async () => {
    await expect(overrideLink(L1, { action: 'approve' })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(overrideLink(L1)).rejects.toMatchObject({ httpStatus: 400 });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('400 on a malformed id, 404 on an unknown one', async () => {
    await expect(overrideLink('nope', { action: 'confirmed' })).rejects.toMatchObject({ httpStatus: 400 });
    queryOne.mockResolvedValueOnce(null);
    await expect(overrideLink(L1, { action: 'confirmed' })).rejects.toMatchObject({ httpStatus: 404, message: 'Link not found.' });
  });

  it('confirmed: accepted + override confirmed, stamped by the caller, open siblings rejected in one tx', async () => {
    await overrideLink(L1, { action: 'confirmed' }, { preferred_username: 'ann@contoso.com' });
    expect(tx).toHaveBeenCalledTimes(1);
    const [setSql, setParams] = sqlCalls(/^UPDATE "OrgLinks" SET "status" = \$3/)[0];
    expect(setSql).toMatch(/"overriddenBy" = \$2, "overriddenAt" = now\(\)/);
    expect(setParams).toEqual([L1, 'ann@contoso.com', 'accepted', 'confirmed']);
    const [sibSql, sibParams] = sqlCalls(/"id" <> ALL/)[0];
    expect(sibSql).toMatch(/"status" = 'proposed' AND "analystOverride" IS NULL/);
    expect(sibParams).toEqual([E1, [L1]]);
  });

  it('rejected: status and override rejected, siblings untouched', async () => {
    const out = await overrideLink(L1, { action: 'rejected' });
    expect(sqlCalls(/^UPDATE "OrgLinks" SET "status" = \$3/)[0][1]).toEqual([L1, 'anonymous', 'rejected', 'rejected']);
    expect(sqlCalls(/"id" <> ALL/)).toHaveLength(0);
    expect(out.link.id).toBe(L1);
  });

  it('moved: needs a uuid targetId other than the current target, of an existing row of the same type', async () => {
    await expect(overrideLink(L1, { action: 'moved' })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(overrideLink(L1, { action: 'moved', targetId: U1.toUpperCase() })).rejects.toMatchObject({ httpStatus: 400 });
    queryOne.mockImplementation(async (sql) => (sql.includes('FROM "OrgLinks"') ? stored : null));
    await expect(overrideLink(L1, { action: 'moved', targetId: U2 })).rejects.toMatchObject({ httpStatus: 400, message: 'targetId is not a known Principal.' });
    expect(queryOne.mock.calls.at(-1)).toEqual(['SELECT "id" FROM "Principals" WHERE "id" = $1', [U2]]);
    expect(query).not.toHaveBeenCalled();
  });

  it('moved: upserts the new target as accepted/moved, rejects the original and the open siblings', async () => {
    const out = await overrideLink(L1, { action: 'moved', targetId: U2 }, { oid: 'o-1' });
    const [insSql, insParams] = sqlCalls(/^INSERT INTO "OrgLinks"/)[0];
    expect(insSql).toMatch(/'accepted', 'moved'/);
    expect(insSql).toMatch(/ON CONFLICT \("orgEntityId", "targetType", "targetId"\) DO UPDATE/);
    expect(insParams.slice(1)).toEqual(['o-1', E1, 'Principal', U2]);
    expect(insParams[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sqlCalls(/^UPDATE "OrgLinks" SET "status" = \$3/)[0][1]).toEqual([L1, 'o-1', 'rejected', 'rejected']);
    const newId = insParams[0];
    expect(sqlCalls(/"id" <> ALL/)[0][1]).toEqual([E1, [newId, L1]]);
    expect(out.link.id).toBe(newId);
    expect(out.original.id).toBe(L1);
  });
});

describe('clearOverride', () => {
  it('clears the three override fields and returns the row; status untouched', async () => {
    queryOne.mockResolvedValueOnce({ id: L1, status: 'accepted', analystOverride: null });
    expect(await clearOverride(L1)).toEqual({ id: L1, status: 'accepted', analystOverride: null });
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toMatch(/"analystOverride" = NULL, "overriddenBy" = NULL, "overriddenAt" = NULL/);
    expect(sql).not.toMatch(/"status"/);
    expect(params).toEqual([L1]);
  });
  it('400 on a malformed id, 404 on an unknown one', async () => {
    await expect(clearOverride('x')).rejects.toMatchObject({ httpStatus: 400 });
    queryOne.mockResolvedValueOnce(null);
    await expect(clearOverride(L1)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('setClaimStatus', () => {
  it('updates only the status of an entity or a relation', async () => {
    queryOne.mockResolvedValue({ id: E1, status: 'accepted' });
    expect(await setClaimStatus('entities', E1, 'accepted')).toEqual({ id: E1, status: 'accepted' });
    expect(queryOne.mock.calls[0]).toEqual(['UPDATE "OrgEntities" SET "status" = $2 WHERE "id" = $1 RETURNING "id", "status"', [E1, 'accepted']]);
    await setClaimStatus('relations', E1, 'rejected');
    expect(queryOne.mock.calls[1][0]).toMatch(/^UPDATE "OrgRelations"/);
  });
  it('400 on a bad kind, id or status; 404 naming the kind', async () => {
    await expect(setClaimStatus('links', E1, 'accepted')).rejects.toMatchObject({ httpStatus: 400 });
    await expect(setClaimStatus('entities', 'x', 'accepted')).rejects.toMatchObject({ httpStatus: 400 });
    await expect(setClaimStatus('entities', E1, 'proposed')).rejects.toMatchObject({ httpStatus: 400 });
    queryOne.mockResolvedValue(null);
    await expect(setClaimStatus('entities', E1, 'rejected')).rejects.toMatchObject({ httpStatus: 404, message: 'Entity not found.' });
    await expect(setClaimStatus('relations', E1, 'rejected')).rejects.toMatchObject({ httpStatus: 404, message: 'Relation not found.' });
  });
});
