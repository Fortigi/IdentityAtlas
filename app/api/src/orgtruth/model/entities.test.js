import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import {
  parseListQuery, listEntities, getEntity, resolveLabels, isUuid, isFlag,
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_Q_LENGTH,
} from './entities.js';

const ID = 'e0000000-0000-4000-8000-000000000001';
const SRC = 'a0000000-0000-4000-8000-0000000000aa';
const RUN = 'b0000000-0000-4000-8000-0000000000bb';
const OTHER = 'e0000000-0000-4000-8000-000000000011';
const P1 = 'c0000000-0000-4000-8000-000000000001';
const R1 = 'c0000000-0000-4000-8000-000000000002';
const R2 = 'c0000000-0000-4000-8000-000000000003';

beforeEach(() => { query.mockReset(); });

describe('isUuid / isFlag', () => {
  it('accepts only a well-formed uuid string', () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid([ID])).toBe(false);
  });
  it('treats only "1" and "true" as set', () => {
    expect(isFlag('1')).toBe(true);
    expect(isFlag('true')).toBe(true);
    expect(isFlag('0')).toBe(false);
    expect(isFlag(undefined)).toBe(false);
  });
});

describe('parseListQuery', () => {
  it('defaults: page 1, pageSize 50, open only, no filters', () => {
    expect(parseListQuery({})).toEqual({ ok: true, value: {
      type: null, q: null, status: null, sourceId: null, includeClosed: false, page: 1, pageSize: DEFAULT_PAGE_SIZE,
    } });
    expect(parseListQuery()).toEqual(parseListQuery({}));
  });

  it('trims and passes every filter through, capping the page size', () => {
    expect(parseListQuery({
      type: ' Project ', q: ' apo ', status: 'proposed', sourceId: SRC, includeClosed: '1', page: '3', pageSize: '1000',
    }).value).toEqual({
      type: 'Project', q: 'apo', status: 'proposed', sourceId: SRC, includeClosed: true, page: 3, pageSize: MAX_PAGE_SIZE,
    });
    expect(parseListQuery({ pageSize: '200' }).value.pageSize).toBe(200);
    expect(parseListQuery({ page: '', pageSize: '' }).value).toMatchObject({ page: 1, pageSize: 50 });
  });

  it.each([
    [{ status: 'open' }, 'status must be one of proposed, accepted, rejected'],
    [{ sourceId: 'x' }, 'sourceId must be a UUID'],
    [{ q: 'a'.repeat(MAX_Q_LENGTH + 1) }, 'q must be at most 200 characters'],
    [{ page: '0' }, 'page and pageSize must be positive integers'],
    [{ page: '1.5' }, 'page and pageSize must be positive integers'],
    [{ pageSize: '-1' }, 'page and pageSize must be positive integers'],
    [{ pageSize: 'ten' }, 'page and pageSize must be positive integers'],
  ])('rejects %j', (q, error) => {
    expect(parseListQuery(q)).toEqual({ ok: false, error });
  });

  it('accepts a q of exactly the maximum length and ignores a non-string filter', () => {
    expect(parseListQuery({ q: 'a'.repeat(MAX_Q_LENGTH) }).ok).toBe(true);
    expect(parseListQuery({ type: ['A', 'B'] }).value.type).toBeNull();
  });
});

describe('listEntities', () => {
  const row = { id: ID, entityType: 'Project', displayName: 'Apollo', linkCount: 2, relationCount: 1 };

  it('counts and pages in two queries with the same WHERE', async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 120 }] }).mockResolvedValueOnce({ rows: [row] });
    const out = await listEntities(parseListQuery({ page: '3', pageSize: '50' }).value);
    expect(out).toEqual({ data: [row], total: 120, page: 3, pageSize: 50 });
    const [countSql, countParams] = query.mock.calls[0];
    const [pageSql, pageParams] = query.mock.calls[1];
    expect(countSql).toMatch(/WHERE e\."validTo" IS NULL$/);
    expect(countParams).toEqual([]);
    expect(pageSql).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(pageParams).toEqual([50, 100]);
  });

  it('binds every filter and escapes LIKE metacharacters in q', async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    await listEntities(parseListQuery({ type: 'Project', status: 'accepted', sourceId: SRC, q: '50%_off\\' }).value);
    const [countSql, params] = query.mock.calls[0];
    expect(countSql).toContain(`e."entityType" = $1 AND e.status = $2 AND e."sourceId" = $3::uuid`);
    expect(countSql).toContain(`lower(e."displayName") LIKE lower($4) ESCAPE '\\'`);
    expect(params).toEqual(['Project', 'accepted', SRC, '%50\\%\\_off\\\\%']);
    expect(query.mock.calls[1][0]).toMatch(/LIMIT \$5 OFFSET \$6/);
    expect(query.mock.calls[1][1]).toEqual([...params, 50, 0]);
  });

  it('drops the open filter with includeClosed, and reports total 0 on an empty count', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const out = await listEntities(parseListQuery({ includeClosed: 'true' }).value);
    expect(query.mock.calls[0][0]).toMatch(/WHERE TRUE$/);
    expect(out.total).toBe(0);
  });
});

describe('resolveLabels', () => {
  it('runs one query per target type present and falls back to the id', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: P1, label: 'ada@contoso.example' }] })
      .mockResolvedValueOnce({ rows: [{ id: R1, label: 'SG-Apollo', resourceType: 'Group' }, { id: R2, label: null, resourceType: null }] });
    const labels = await resolveLabels([
      { targetType: 'Resource', targetId: R1 }, { targetType: 'Principal', targetId: P1 },
      { targetType: 'Resource', targetId: R1 }, { targetType: 'Resource', targetId: R2 },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toMatch(/FROM "Principals"/);
    expect(query.mock.calls[0][1]).toEqual([[P1]]);
    expect(query.mock.calls[1][0]).toMatch(/FROM "Resources"/);
    expect(query.mock.calls[1][1]).toEqual([[R1, R2]]);
    expect(labels.get(`Principal:${P1}`)).toEqual({ label: 'ada@contoso.example' });
    expect(labels.get(`Resource:${R1}`)).toEqual({ label: 'SG-Apollo', resourceType: 'Group' });
    expect(labels.get(`Resource:${R2}`)).toEqual({ label: R2 });
  });

  it('queries Identities and Contexts by their own tables, and nothing for no rows', async () => {
    expect((await resolveLabels([])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    await resolveLabels([{ targetType: 'OrgEntity', targetId: 'o' }, { targetType: 'Context', targetId: 'c' }, { targetType: 'Identity', targetId: 'i' }]);
    expect(query.mock.calls.map(c => c[0].match(/FROM "(\w+)"/)[1])).toEqual(['Identities', 'Contexts', 'OrgEntities']);
    expect(query.mock.calls[2][1]).toEqual([['o']]);
  });
});

describe('getEntity', () => {
  const entityRow = {
    id: ID, entityType: 'Project', displayName: 'Apollo', canonicalKey: 'PRJ-1', status: 'accepted', confidence: null,
    origin: 'import', observedAt: 'o', recordedAt: 'r', validFrom: null, validTo: null, sourceLocator: 'row 2', createdBy: 'analyst',
    attributes: '{"budget":100}',
    sourceId: SRC, sourceDisplayName: 'Projects 2026', sourceKind: 'list', sourceObservedAt: 'so', sourceFileName: 'projects.xlsx',
    runId: RUN, runMode: 'full', runFinishedAt: 'rf',
  };

  it('returns null for an unknown id after one query', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getEntity(ID)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([ID]);
  });

  it('assembles the row, source, run, relations split by direction, and labelled links', async () => {
    query
      .mockResolvedValueOnce({ rows: [entityRow] })
      .mockResolvedValueOnce({ rows: [
        { id: 'r1', predicate: 'owner', status: 'accepted', validTo: null, confidence: 90, direction: 'out', otherId: OTHER, otherType: 'Person', otherName: 'Ada Contoso' },
        { id: 'r2', predicate: 'partOf', status: 'proposed', validTo: null, confidence: 40, direction: 'in', otherId: 'e2', otherType: 'Programme', otherName: 'Northwind' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { id: 'l1', targetType: 'Resource', targetId: R1, confidence: 95, status: 'accepted', analystOverride: null, signals: 'exact', matchedField: 'displayName', matchedValue: 'SG-Apollo' },
        { id: 'l2', targetType: 'Principal', targetId: P1, confidence: 60, status: 'proposed', analystOverride: null, signals: null, matchedField: null, matchedValue: null },
      ] })
      .mockResolvedValueOnce({ rows: [] })                                                   // Principals: no label → id
      .mockResolvedValueOnce({ rows: [{ id: R1, label: 'SG-Apollo', resourceType: 'Group' }] });
    const out = await getEntity(ID);
    expect(out).toMatchObject({
      id: ID, entityType: 'Project', displayName: 'Apollo', canonicalKey: 'PRJ-1', origin: 'import', sourceLocator: 'row 2',
      attributes: { budget: 100 },
      source: { id: SRC, displayName: 'Projects 2026', kind: 'list', observedAt: 'so', fileName: 'projects.xlsx' },
      run: { id: RUN, mode: 'full', finishedAt: 'rf' },
    });
    expect(out.relations).toEqual({
      out: [{ id: 'r1', predicate: 'owner', status: 'accepted', validTo: null, confidence: 90, to: { id: OTHER, entityType: 'Person', displayName: 'Ada Contoso' } }],
      in: [{ id: 'r2', predicate: 'partOf', status: 'proposed', validTo: null, confidence: 40, from: { id: 'e2', entityType: 'Programme', displayName: 'Northwind' } }],
    });
    expect(out.links[0]).toEqual({
      id: 'l1', targetType: 'Resource', targetId: R1, label: 'SG-Apollo', resourceType: 'Group', confidence: 95, status: 'accepted',
      analystOverride: null, signals: 'exact', matchedField: 'displayName', matchedValue: 'SG-Apollo',
    });
    expect(out.links[1].label).toBe(P1);
    expect(out.links[1]).not.toHaveProperty('resourceType');
    expect(out).not.toHaveProperty('sourceKind');
  });

  it('has run null and empty attributes when the entity has neither', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ ...entityRow, runId: null, attributes: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const out = await getEntity(ID);
    expect(out.run).toBeNull();
    expect(out.attributes).toEqual({});
    expect(out.relations).toEqual({ out: [], in: [] });
    expect(out.links).toEqual([]);
  });
});
