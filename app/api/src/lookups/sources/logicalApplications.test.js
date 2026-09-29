// Unit tests for the logical-applications lookup source.
//
// The db mock is SQL-blind, so these assert on the PARAMETERS the source binds
// and on the options it shapes — the two things a wrong answer here would come
// from. Whether the statement is valid against the real schema is the contract
// test's job.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import source from './logical-applications.js';

const row = (over = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  displayName: 'Ledger Engineering 0006',
  members: 2700,
  systemName: 'Catalogue',
  ...over,
});

const paramsOf = () => query.mock.calls[0][1];
const sqlOf = () => query.mock.calls[0][0];

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

describe('logical-applications lookup — search', () => {
  it('shapes a catalogue row into an option whose value is the id, not the name', async () => {
    query.mockResolvedValue({ rows: [row()] });
    expect(await source.search({ q: 'ledger' })).toEqual([{
      value: '11111111-1111-1111-1111-111111111111',
      label: 'Ledger Engineering 0006',
      hint: '2,700 members · Catalogue',
    }]);
  });

  it('puts the size in the hint even when there is no system to name', async () => {
    query.mockResolvedValue({ rows: [row({ systemName: null, members: 0 })] });
    expect((await source.search({ q: '' }))[0].hint).toBe('0 members');
  });

  it('formats the size for a reader, not as a raw integer', async () => {
    query.mockResolvedValue({ rows: [row({ members: 16387 })] });
    expect((await source.search({ q: '' }))[0].hint).toContain('16,387 members');
  });

  it('escapes the ILIKE wildcards, so an underscore means an underscore', async () => {
    // Entitlement and application names are full of underscores. Unescaped,
    // `MAI23_LEG` would match almost every row and the list would be useless.
    await source.search({ q: 'MAI23_LEG%X' });
    expect(paramsOf()[1]).toBe('MAI23\\_LEG\\%X');
    // …and the statement declares the escape character it just used. Escaping
    // the term without it would put a literal backslash into the match.
    expect(sqlOf()).toContain("ESCAPE '\\'");
  });

  it('asks for the biggest first, so an empty box offers something useful', async () => {
    await source.search({ q: '', limit: 5 });
    expect(paramsOf()).toEqual(['LogicalApplication', '', 5]);
    expect(sqlOf()).toMatch(/ORDER BY[\s\S]*"directMemberCount" DESC/);
  });

  it('filters to resource-targeted logical applications, never other contexts', async () => {
    await source.search({ q: 'x' });
    expect(paramsOf()[0]).toBe('LogicalApplication');
    expect(sqlOf()).toContain(`"targetType" = 'Resource'`);
  });
});

describe('logical-applications lookup — resolve', () => {
  it('turns stored ids back into labels', async () => {
    query.mockResolvedValue({ rows: [row()] });
    const options = await source.resolve({ ids: ['11111111-1111-1111-1111-111111111111'] });
    expect(options[0].label).toBe('Ledger Engineering 0006');
    expect(paramsOf()[0]).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('drops anything that is not a uuid instead of sending it to postgres', async () => {
    // A parameter may still hold a name typed by hand before the picker existed.
    // One bad value in a uuid[] fails the whole statement, so the good ones must
    // survive it.
    await source.resolve({ ids: ['Ledger Engineering 0006', '11111111-1111-1111-1111-111111111111'] });
    expect(paramsOf()[0]).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('does not query at all when nothing resolvable was asked for', async () => {
    expect(await source.resolve({ ids: ['not-a-uuid'] })).toEqual([]);
    expect(await source.resolve({})).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
