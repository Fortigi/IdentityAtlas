// The unit-contexts lookup: the same picker as resource-contexts
// (contextLookup.js, tested through resourceContexts.test.js), over
// organisational units of accounts or people only.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import source from './unit-contexts.js';

const UNIT_WHERE = `c."contextCategory" = 'OrganizationalUnit' AND c."targetType" IN ('Principal', 'Identity')`;

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

describe('unit-contexts lookup', () => {
  it('searches organisational units of accounts or people only', async () => {
    query.mockResolvedValue({ rows: [{ id: 'u1', displayName: 'Finance', contextType: 'Department', members: 12, systemName: 'HR' }] });
    expect(await source.search({ q: 'fin' })).toEqual([{ value: 'u1', label: 'Finance', hint: 'Department · 12 members · HR' }]);
    expect(source.name).toBe('unit-contexts');
    expect(query.mock.calls[0][0]).toContain(`WHERE ${UNIT_WHERE}`);
  });

  it('resolves stored ids within the same slice', async () => {
    await source.resolve({ ids: ['11111111-1111-1111-1111-111111111111'] });
    expect(query.mock.calls[0][0]).toContain(`c.id = ANY($1::uuid[]) AND ${UNIT_WHERE}`);
  });
});
