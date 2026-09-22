// Which contexts a matrix depends on, and which of them are gone. Pure; no DB.

import { describe, it, expect } from 'vitest';
import { referencedContextIds, missingContextIds, contextHealthPlan } from './filterContexts.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

const ctx = (id) => ({ kind: 'context', contextId: id });

describe('referencedContextIds', () => {
  it('collects context conditions from both blocks and both sides', () => {
    const ids = referencedContextIds({
      subject: { include: [ctx(A)], exclude: [ctx(B)] },
      resource: { include: [ctx(C)], exclude: [] },
    });
    expect(new Set(ids)).toEqual(new Set([A, B, C]));
  });

  it('counts the tree a matrix is rolled up by', () => {
    expect(referencedContextIds({ rollupKind: 'context', rollupContextId: A })).toEqual([A]);
  });

  it('ignores a leftover roll-up context when the matrix rolls up by an attribute', () => {
    // Switching the roll-up back to an attribute leaves the id behind in the
    // stored filter; that matrix does not depend on the tree and must not be
    // flagged when somebody deletes it.
    expect(referencedContextIds({ rollupKind: 'attribute', rollup: 'department', rollupContextId: A })).toEqual([]);
  });

  it('counts the tree a matrix is sorted by', () => {
    expect(referencedContextIds({ sortHierarchy: { contextId: B } })).toEqual([B]);
  });

  it('reports each context once however many places name it', () => {
    expect(referencedContextIds({
      subject: { include: [ctx(A)], exclude: [ctx(A)] },
      rollupKind: 'context', rollupContextId: A,
      sortHierarchy: { contextId: A },
    })).toEqual([A]);
  });

  it('drops a condition id that is not a uuid, which could never be looked up', () => {
    expect(referencedContextIds({ subject: { include: [ctx('not-a-uuid'), ctx(A)] } })).toEqual([A]);
  });

  it('answers an absent or contextless filter with nothing', () => {
    expect(referencedContextIds(undefined)).toEqual([]);
    expect(referencedContextIds({ subject: { include: [{ kind: 'attribute', field: 'department' }] } })).toEqual([]);
  });
});

describe('missingContextIds', () => {
  it('returns only the ids the lookup did not find', () => {
    expect(missingContextIds([A, B], new Set([A]))).toEqual([B]);
  });

  it('accepts the Map a context-type lookup hands back', () => {
    expect(missingContextIds([A, B], new Map([[A, 'Identity']]))).toEqual([B]);
  });

  it('reports nothing missing when every context resolved', () => {
    expect(missingContextIds([A, B], new Set([A, B]))).toEqual([]);
  });
});

describe('contextHealthPlan', () => {
  const rows = [
    { id: 'sf-1', name: 'Healthy', filter: { subject: { include: [ctx(A)] } } },
    { id: 'sf-2', name: 'Broken', filter: { subject: { include: [ctx(B)] }, rollupKind: 'context', rollupContextId: C } },
    { id: 'sf-3', name: 'Contextless', filter: { subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }] } } },
  ];

  it('asks about every context the list names, once', () => {
    expect(new Set(contextHealthPlan(rows).lookup)).toEqual(new Set([A, B, C]));
    expect(contextHealthPlan(rows).lookup).toHaveLength(3);
  });

  it('flags only the rows whose own contexts are gone', () => {
    const plan = contextHealthPlan(rows);
    // A survives; B and C were deleted. A plan that judged every row by the
    // whole list's missing ids would flag the healthy one too.
    const labelled = plan.label(new Set([A]));
    expect(labelled.map(r => [r.name, r.missingContextIds])).toEqual([
      ['Healthy', []],
      ['Broken', [B, C]],
      ['Contextless', []],
    ]);
  });

  it('keeps everything the row already carried', () => {
    const [first] = contextHealthPlan([{ id: 'sf-1', name: 'Healthy', shared: true, recipientCount: 2, filter: {} }])
      .label(new Set());
    expect(first).toMatchObject({ id: 'sf-1', name: 'Healthy', shared: true, recipientCount: 2 });
  });

  it('asks about nothing for a list that names no context', () => {
    expect(contextHealthPlan([{ id: 'sf-3', filter: {} }]).lookup).toEqual([]);
  });

  it('survives an empty or absent list', () => {
    expect(contextHealthPlan([]).lookup).toEqual([]);
    expect(contextHealthPlan(undefined).label(new Set())).toEqual([]);
  });
});
