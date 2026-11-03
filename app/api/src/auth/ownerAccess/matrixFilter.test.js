// The team matrix filter. Each refused case is a real way to widen the rows
// past the owner's team; each allowed case shows what is run instead.

import { describe, it, expect } from 'vitest';
import { ownerMatrixVerdict, ownerContextIds, AGGREGATE_FIELDS } from './matrixFilter.js';

const MINE = 'aaaaaaaa-0000-4000-8000-000000000001';
const MY_RESOURCES = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const SCOPE = new Set([MINE, MY_RESOURCES]);
const TYPES = new Map([[MINE, 'Identity'], [MY_RESOURCES, 'Resource'], [OTHER, 'Principal']]);

const ctx = (contextId, extra = {}) => ({ kind: 'context', contextId, ...extra });
const team = (extra = {}) => ({
  filter: { rowType: 'principal', subject: { include: [ctx(MINE)], exclude: [] }, resource: { include: [], exclude: [] }, ...extra },
});
const verdict = (body) => ownerMatrixVerdict(body, SCOPE, TYPES);

describe('ownerMatrixVerdict — allowed', () => {
  it('the team matrix the owner page sends runs as sent', () => {
    const v = verdict(team({ orientation: 'rows-as-subjects' }));
    expect(v.ok).toBe(true);
    expect(v.filter.subject.include).toEqual([{ kind: 'context', contextId: MINE, includeChildren: false }]);
    expect(v.filter.orientation).toBe('rows-as-subjects');
  });

  it('extra subject conditions only narrow, so they are kept', () => {
    const body = team();
    body.filter.subject.include.push({ kind: 'attribute', field: 'department', values: ['Sales'] });
    body.filter.subject.exclude.push(ctx(MY_RESOURCES));
    const v = verdict(body);
    expect(v.ok).toBe(true);
    expect(v.filter.subject.include[1]).toEqual({ kind: 'attribute', field: 'department', values: ['Sales'] });
    expect(v.filter.subject.exclude).toHaveLength(1);
  });

  it('an upper-cased context id is run lower-cased (the subject query looks ids up exactly)', () => {
    const v = verdict({ filter: { subject: { include: [ctx(MINE.toUpperCase())] } } });
    expect(v.ok).toBe(true);
    expect(v.filter.subject.include[0].contextId).toBe(MINE);
    expect(v.filter.resource).toEqual({ include: [], exclude: [] });
  });

  it('the aggregate modes are removed rather than run', () => {
    const extra = Object.fromEntries(AGGREGATE_FIELDS.map(f => [f, f === 'rollupLevel' ? 3 : 'x']));
    const v = verdict(team({ ...extra, rollupKind: 'context', rollupContextId: OTHER, sortHierarchy: { contextId: OTHER }, foldAttributes: true }));
    expect(v.ok).toBe(true);
    for (const f of AGGREGATE_FIELDS) expect(v.filter).not.toHaveProperty(f);
  });
});

describe('ownerMatrixVerdict — refused (attempts to widen the rows)', () => {
  it.each([
    ['no subject condition at all — every account', { filter: { subject: { include: [] } } }],
    ['only an attribute condition', { filter: { subject: { include: [{ kind: 'attribute', field: 'department', values: ['Sales'] }] } } }],
    ['another unit', team({ subject: { include: [ctx(OTHER)] } })],
    ['their unit AND another one (the other one is out of scope)', team({ subject: { include: [ctx(MINE), ctx(OTHER)] } })],
    ['another unit in the exclude', team({ subject: { include: [ctx(MINE)], exclude: [ctx(OTHER)] } })],
    ['another context on the resource side', team({ resource: { include: [ctx(OTHER)] } })],
    ['their unit with its children (sub-units may be somebody else\'s)', team({ subject: { include: [ctx(MINE, { includeChildren: true })] } })],
    ['only a context of resources as the subject (the subject query drops it)', team({ subject: { include: [ctx(MY_RESOURCES)] } })],
    ['their own context only on the resource side', team({ subject: { include: [] }, resource: { include: [ctx(MINE)] } })],
    ['a context id that is not a uuid', team({ subject: { include: [ctx(`${MINE}x`)] } })],
    ['a context condition without an id', team({ subject: { include: [ctx(MINE), { kind: 'context' }] } })],
    ['a malformed include', team({ subject: { include: 'x' } })],
    ['a malformed block', team({ resource: 'x' })],
    ['no filter', {}],
    ['a filter array', { filter: [] }],
    ['no body', undefined],
  ])('%s', (_label, body) => {
    expect(verdict(body)).toEqual({ ok: false });
  });

  it('an in-scope unit whose type is unknown (does not exist) is no anchor', () => {
    expect(ownerMatrixVerdict(team(), SCOPE, new Map())).toEqual({ ok: false });
  });
});

describe('ownerContextIds', () => {
  it('lists every context the filter names, once, lower-cased', () => {
    const f = { subject: { include: [ctx(MINE.toUpperCase()), ctx(MINE)] }, resource: { exclude: [ctx(MY_RESOURCES)] } };
    expect(ownerContextIds(f, SCOPE)).toEqual([MINE, MY_RESOURCES]);
  });

  it('ignores null conditions and blocks that are absent', () => {
    expect(ownerContextIds({ subject: { include: [null] }, resource: null }, SCOPE)).toEqual([]);
  });
});
