import { describe, it, expect } from 'vitest';
import { catalogJoinSql, CATALOG_CATEGORY } from './businessRoleCatalog.js';
import { CONTEXT_CATEGORIES } from '../ingest/validation.js';

describe('catalogJoinSql', () => {
  it('names a template the ingest accepts', () => {
    expect(CONTEXT_CATEGORIES).toContain(CATALOG_CATEGORY);
  });

  it('joins the role by the given expression and exposes the alias', () => {
    const sql = catalogJoinSql('br.id', 'cat');
    expect(sql).toMatch(/^LEFT JOIN LATERAL \(/);
    expect(sql).toContain('cm."memberId" = br.id');
    expect(sql).toMatch(/\) cat ON true$/);
    expect(sql).toContain(`cx."contextCategory" = 'Catalog'`);
  });

  it('defaults the alias to c, which the routes read as c.id / c."displayName"', () => {
    expect(catalogJoinSql('ap.id')).toMatch(/\) c ON true$/);
  });

  it('only counts resource memberships and picks one catalog, synced first', () => {
    const sql = catalogJoinSql('ap.id');
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(sql).toContain(`ORDER BY (cx.variant = 'synced') DESC, cx."displayName", cx.id`);
    expect(sql).toContain('LIMIT 1');
  });
});
