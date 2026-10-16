// Unit tests for the access-review-fields lookup source.
//
// The db mock is SQL-blind, so the two discovery reads are told apart by a
// fragment only one of them contains, and the assertions are on what the source
// binds and on the options it shapes. Running the statements is the contract
// test's job.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import source, { clearFieldCache, matches } from './access-review-fields.js';
import { coreFields } from '../../reports/accessReviewFields.js';

const C1 = '11111111-1111-1111-1111-111111111111';
const C2 = '22222222-2222-2222-2222-222222222222';

function stage({ context = [], entitlement = [] } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('"ContextMembers"')) return { rows: entitlement };
    return { rows: context };
  });
}

const values = options => options.map(o => o.value);

beforeEach(() => {
  query.mockReset();
  clearFieldCache();
  stage();
});

describe('access-review-fields lookup — search', () => {
  it('offers the built-in fields without a context, and asks the database nothing', async () => {
    const options = await source.search({ q: '', limit: 50 });
    expect(values(options)).toEqual(coreFields().map(f => f.key));
    expect(options.find(o => o.value === 'context.name').hint).toBe('Context field');
    expect(options.find(o => o.value === 'entitlement.system').hint).toBe('Entitlement field');
    expect(query).not.toHaveBeenCalled();
  });

  it('adds the attributes the picked contexts and their resources carry, with how widely', async () => {
    stage({
      context: [{ key: 'cmdbReference', n: 1, total: 2 }],
      entitlement: [{ key: 'certfrequency', n: 38201, total: 39072 }, { key: 'costcentercode', n: 3, total: 39072 }],
    });
    const options = await source.search({ q: '', limit: 50, params: { contexts: [C1, C2] } });

    // Built-ins first, then the context's attributes, then the resources'.
    expect(values(options).slice(-3)).toEqual([
      'context.ext.cmdbReference', 'entitlement.ext.certfrequency', 'entitlement.ext.costcentercode',
    ]);
    expect(options.find(o => o.value === 'context.ext.cmdbReference')).toEqual({
      value: 'context.ext.cmdbReference', label: 'Context · cmdbReference',
      hint: 'Context attribute · on 1 of 2 contexts',
    });
    expect(options.find(o => o.value === 'entitlement.ext.certfrequency').hint)
      .toBe('Entitlement attribute · on 38,201 of 39,072 resources');
    // Both reads are scoped to the picked contexts and capped.
    for (const [, params] of query.mock.calls) expect(params).toEqual([[C1, C2], 300]);
  });

  it('never offers an attribute whose key could not travel in a comma-joined list', async () => {
    stage({ entitlement: [{ key: 'a,b', n: 1, total: 1 }, { key: 'ok', n: 1, total: 1 }] });
    const options = await source.search({ q: '', limit: 50, params: { contexts: [C1] } });
    expect(values(options)).toContain('entitlement.ext.ok');
    expect(values(options).some(v => v.includes('a,b'))).toBe(false);
  });

  it('ignores a context that is not a uuid instead of sending it to postgres', async () => {
    await source.search({ q: '', limit: 50, params: { contexts: ['Ledger', C1] } });
    expect(query.mock.calls[0][1][0]).toEqual([C1]);

    query.mockClear();
    await source.search({ q: '', limit: 50, params: { contexts: ['Ledger'] } });
    expect(query).not.toHaveBeenCalled();
  });

  it('filters on what was typed and honours the limit', async () => {
    stage({ entitlement: [{ key: 'certfrequency', n: 1, total: 1 }] });
    const params = { contexts: [C1] };
    expect(values(await source.search({ q: 'FREQ', limit: 50, params }))).toEqual(['entitlement.ext.certfrequency']);
    expect(await source.search({ q: '', limit: 3, params })).toHaveLength(3);
  });

  it('discovers once per set of contexts while someone is typing', async () => {
    const params = { contexts: [C2, C1] };
    await source.search({ q: 'c', limit: 50, params });
    await source.search({ q: 'co', limit: 50, params: { contexts: [C1, C2] } });
    // Two reads for the first keystroke, none for the second: same set, other order.
    expect(query).toHaveBeenCalledTimes(2);

    await source.search({ q: 'co', limit: 50, params: { contexts: [C1] } });
    expect(query).toHaveBeenCalledTimes(4);
  });
});

describe('access-review-fields lookup — resolve', () => {
  it('names stored keys without a query, and drops a key that is not a field', async () => {
    const options = await source.resolve({
      ids: ['entitlement.owner', 'context.ext.cmdbReference', 'nonsense', 'entitlement.ext.a,b'],
    });
    expect(options).toEqual([
      { value: 'entitlement.owner', label: 'Entitlement owner', hint: 'Entitlement field' },
      { value: 'context.ext.cmdbReference', label: 'Context · cmdbReference', hint: 'Context attribute' },
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves nothing to nothing', async () => {
    expect(await source.resolve({})).toEqual([]);
  });
});

describe('matches', () => {
  const option = { value: 'entitlement.ext.costcentercode', label: 'costcentercode' };
  it('matches on the heading or the key, case-insensitively, and everything on an empty term', () => {
    expect(matches(option, 'COST')).toBe(true);
    expect(matches(option, 'entitlement.ext')).toBe(true);
    expect(matches(option, '  ')).toBe(true);
    expect(matches(option, 'owner')).toBe(false);
  });
});
