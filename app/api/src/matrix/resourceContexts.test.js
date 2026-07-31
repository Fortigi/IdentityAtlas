import { describe, it, expect } from 'vitest';
import { buildResourceContextsSql, groupResourceContexts } from './resourceContexts.js';

describe('buildResourceContextsSql', () => {
  it('embeds the caller predicate and keeps the Resource memberType guard', () => {
    const sql = buildResourceContextsSql('cm."memberId"::text = $1');
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(sql).toContain('cm."memberId"::text = $1');
    expect(sql).toContain('JOIN "Contexts" c ON c.id = cm."contextId"');
  });

  it('orders per resource by contextType then displayName (stable first-2 chips)', () => {
    const sql = buildResourceContextsSql('TRUE');
    expect(sql).toContain('ORDER BY cm."memberId"::text, c."contextType", c."displayName"');
  });

  it('supports an IN (subquery) predicate for the batched matrix sidecar', () => {
    const sql = buildResourceContextsSql('cm."memberId" IN (SELECT id FROM "Resources")');
    expect(sql).toContain('cm."memberId" IN (SELECT id FROM "Resources")');
  });
});

describe('groupResourceContexts', () => {
  const row = (resourceId, id, displayName, contextType, variant = 'generated') =>
    ({ resourceId, id, displayName, contextType, targetType: 'Resource', variant });

  it('groups rows per resource, preserving the server sort order', () => {
    const grouped = groupResourceContexts([
      row('r1', 'c1', 'Microsoft 365', 'entra-group-category', 'generated'),
      row('r1', 'c2', 'Finance', 'Tag', 'manual'),
      row('r2', 'c1', 'Microsoft 365', 'entra-group-category', 'generated'),
    ]);
    expect(grouped).toEqual([
      {
        resourceId: 'r1',
        contexts: [
          { id: 'c1', displayName: 'Microsoft 365', contextType: 'entra-group-category', variant: 'generated' },
          { id: 'c2', displayName: 'Finance', contextType: 'Tag', variant: 'manual' },
        ],
      },
      {
        resourceId: 'r2',
        contexts: [
          { id: 'c1', displayName: 'Microsoft 365', contextType: 'entra-group-category', variant: 'generated' },
        ],
      },
    ]);
  });

  it('skips rows without a resourceId and tolerates null/undefined input', () => {
    expect(groupResourceContexts([row(null, 'c1', 'X', 'Tag'), row('', 'c2', 'Y', 'Tag')])).toEqual([]);
    expect(groupResourceContexts(null)).toEqual([]);
    expect(groupResourceContexts(undefined)).toEqual([]);
    expect(groupResourceContexts([])).toEqual([]);
  });
});
