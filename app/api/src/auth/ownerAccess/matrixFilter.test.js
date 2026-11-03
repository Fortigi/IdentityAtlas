// The team matrix filter. Each refused case is a real way to widen the rows
// past the owner's team; each allowed case shows what is run instead.

import { describe, it, expect } from 'vitest';
import { ownerMatrixVerdict, ownerContextIds, AGGREGATE_FIELDS } from './matrixFilter.js';

const MINE = 'aaaaaaaa-0000-4000-8000-000000000001';
const MY_RESOURCES = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTHER_APP = 'aaaaaaaa-0000-4000-8000-000000000004';
const MY_SYSTEM = 'aaaaaaaa-0000-4000-8000-000000000005';
const SCOPE = new Set([MINE, MY_RESOURCES, MY_SYSTEM]);
const TYPES = new Map([[MINE, 'Identity'], [MY_RESOURCES, 'Resource'], [OTHER, 'Principal'], [OTHER_APP, 'Resource'], [MY_SYSTEM, 'System']]);

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

describe('ownerMatrixVerdict — the application matrix (bounded on the resource axis)', () => {
  const app = (resource, subject = { include: [], exclude: [] }) => ({ filter: { rowType: 'principal', orientation: 'rows-as-subjects', subject, resource } });

  it('runs with their own context of resources as the column anchor, rows unfiltered (the holders)', () => {
    const v = verdict(app({ include: [ctx(MY_RESOURCES)], exclude: [] }));
    expect(v.ok).toBe(true);
    expect(v.filter.resource.include).toEqual([{ kind: 'context', contextId: MY_RESOURCES, includeChildren: false }]);
    expect(v.filter.subject).toEqual({ include: [], exclude: [] });
  });

  it.each([
    ['another application', app({ include: [ctx(OTHER_APP)] })],
    ['their application AND another one', app({ include: [ctx(MY_RESOURCES), ctx(OTHER_APP)] })],
    ['their application only in the resource exclude (columns unbounded)', app({ include: [], exclude: [ctx(MY_RESOURCES)] })],
    ['a context of systems in scope as the column anchor (not a resource context)', app({ include: [ctx(MY_SYSTEM)] })],
    ['only an attribute on the resource axis', app({ include: [{ kind: 'attribute', field: 'resourceType', values: ['Group'] }] })],
    ['their application with another unit on the subject axis', app({ include: [ctx(MY_RESOURCES)] }, { include: [ctx(OTHER)] })],
    ['their application as the subject anchor (dropped there)', app({ include: [] }, { include: [ctx(MY_RESOURCES)] })],
  ])('refuses %s', (_label, body) => {
    expect(verdict(body)).toEqual({ ok: false });
  });

  it('strips the aggregate modes here too', () => {
    const v = verdict({ filter: { resource: { include: [ctx(MY_RESOURCES)] }, rollup: 'department', includeInheritedAccess: true } });
    expect(v.ok).toBe(true);
    expect(v.filter).not.toHaveProperty('rollup');
    expect(v.filter).not.toHaveProperty('includeInheritedAccess');
  });
});

describe('ownerMatrixVerdict — with sub-contexts', () => {
  it('runs their unit with its children, naming it for the descendant check', () => {
    const v = verdict(team({ subject: { include: [ctx(MINE.toUpperCase(), { includeChildren: true })], exclude: [] } }));
    expect(v.ok).toBe(true);
    expect(v.filter.subject.include).toEqual([{ kind: 'context', contextId: MINE, includeChildren: true }]);
    expect(v.childrenOf).toEqual([MINE]);
  });

  it('names every context read with children, on both axes, once', () => {
    const v = verdict({ filter: {
      subject: { include: [ctx(MINE, { includeChildren: true })], exclude: [ctx(MINE, { includeChildren: true })] },
      resource: { include: [ctx(MY_RESOURCES, { includeChildren: true })] },
    } });
    expect(v.childrenOf).toEqual([MINE, MY_RESOURCES]);
  });

  it('names nothing without includeChildren', () => {
    expect(verdict(team()).childrenOf).toEqual([]);
  });

  it('an out-of-scope unit with children is still refused outright', () => {
    expect(verdict(team({ subject: { include: [ctx(MINE), ctx(OTHER, { includeChildren: true })] } }))).toEqual({ ok: false });
  });
});
