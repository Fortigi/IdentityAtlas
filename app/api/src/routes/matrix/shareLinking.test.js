import { describe, it, expect, vi } from 'vitest';
import { HttpError, savedMatrixShape, insertRecipients } from './shareLinking.js';

describe('HttpError', () => {
  it('carries the status the route maps onto the response', () => {
    const err = new HttpError(409, 'A saved matrix with that name already exists');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
    expect(err.message).toBe('A saved matrix with that name already exists');
  });
});

describe('savedMatrixShape', () => {
  const filter = { resourceTypes: ['Group'], orientation: 'rows' };

  it('folds the governed toggle into the filter when one was shared', () => {
    expect(savedMatrixShape(filter, 'Gaps')).toEqual({ resourceTypes: ['Group'], orientation: 'rows', managed: 'Gaps' });
  });

  it('leaves the filter without a managed key when no toggle was shared', () => {
    const shaped = savedMatrixShape(filter, undefined);
    expect(shaped).toEqual(filter);
    expect('managed' in shaped).toBe(false);
  });

  it('drops the loaded-from tag, which points at a saved matrix rather than being part of one', () => {
    const tagged = { ...filter, savedFilterId: 'sf-original' };
    expect(savedMatrixShape(tagged, 'Gaps')).toEqual({ resourceTypes: ['Group'], orientation: 'rows', managed: 'Gaps' });
    expect(savedMatrixShape(tagged)).toEqual(filter);
    expect(tagged.savedFilterId).toBe('sf-original'); // the caller's object is untouched
  });

  it('returns a copy, never the caller\'s object', () => {
    const shaped = savedMatrixShape(filter, 'Governed');
    shaped.orientation = 'columns';
    expect(filter.orientation).toBe('rows');
    expect(filter).not.toHaveProperty('managed');
    expect(savedMatrixShape(filter, null)).not.toBe(filter);
  });
});

describe('insertRecipients', () => {
  it('numbers the placeholders per recipient and passes values in the same order', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await insertRecipients(client, 'share-1', [
      { principalId: 'p-a', userKey: 'a@x.test', displayName: 'Ann' },
      { principalId: null, userKey: 'b@x.test', displayName: 'Bob' },
    ]);
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    // Recipient 2 must start at $5, not $4 — an off-by-one here would bind Bob's key as Ann's name.
    expect(sql).toContain('VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)');
    expect(sql).toContain('ON CONFLICT ("shareId", "userKey") DO UPDATE');
    expect(params).toEqual(['share-1', 'p-a', 'a@x.test', 'Ann', null, 'b@x.test', 'Bob']);
  });
});
