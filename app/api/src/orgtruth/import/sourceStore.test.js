import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { query, queryOne } from '../../db/connection.js';
import { getSource, getSourceWithContent, listSources, readSourceTable, insertSource } from './sourceStore.js';

const ID = '6f1c1c2e-8d3b-4a8e-9c1d-2b3c4d5e6f70';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('getSource / getSourceWithContent', () => {
  it('never asks the database for a malformed id', async () => {
    expect(await getSource('nope')).toBeNull();
    expect(await getSourceWithContent(undefined)).toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('reads the row without content, or with it only when asked', async () => {
    queryOne.mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce({ id: ID, content: Buffer.from('a') });
    expect(await getSource(ID)).toEqual({ id: ID });
    expect(queryOne.mock.calls[0][0]).not.toMatch(/"content"/);
    expect(queryOne.mock.calls[0][1]).toEqual([ID]);
    expect((await getSourceWithContent(ID)).content).toEqual(Buffer.from('a'));
    expect(queryOne.mock.calls[1][0]).toMatch(/"content" FROM/);
  });

  it('returns null for an unknown id', async () => {
    queryOne.mockResolvedValue(undefined);
    expect(await getSource(ID)).toBeNull();
    expect(await getSourceWithContent(ID)).toBeNull();
  });
});

describe('listSources', () => {
  it('returns the rows newest first with their run counts', async () => {
    query.mockResolvedValue({ rows: [{ id: ID, runCount: 2 }] });
    expect(await listSources()).toEqual([{ id: ID, runCount: 2 }]);
    expect(query.mock.calls[0][0]).toMatch(/ORDER BY s."createdAt" DESC/);
    expect(query.mock.calls[0][0]).not.toMatch(/"content"/);
  });
});

describe('readSourceTable', () => {
  it('parses the stored bytes, also when the driver hands back a Uint8Array', async () => {
    const out = await readSourceTable({ content: new Uint8Array(Buffer.from('a;b\n1;2')), fileName: 'x.csv', mimeType: 'text/csv' });
    expect(out).toEqual({ columns: ['a', 'b'], rows: [{ a: '1', b: '2' }], headerRow: 1 });
  });

  it('refuses a source without bytes or names with the parser sentence', async () => {
    await expect(readSourceTable({ content: null })).rejects.toThrow('The file is empty.');
  });
});

describe('insertSource', () => {
  it('stores the bytes with their size and sha256 under a new id', async () => {
    queryOne.mockResolvedValue({ id: 'new' });
    const buffer = Buffer.from('abc');
    const row = await insertSource({ kind: 'list', displayName: 'P', fileName: 'p.csv', mimeType: 'text/csv', buffer, observedAt: '2026-10-01', uploadedBy: 'ann' });
    expect(row).toEqual({ id: 'new' });
    const params = queryOne.mock.calls[0][1];
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params.slice(1)).toEqual(['list', 'P', 'p.csv', 'text/csv', 3,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', buffer, '2026-10-01', 'ann']);
  });
});
