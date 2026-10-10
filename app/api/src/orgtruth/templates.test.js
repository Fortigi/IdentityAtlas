import { describe, it, expect } from 'vitest';
import { TEMPLATES, ENTITY_TEMPLATE_SQL } from './templates.js';

describe('templates', () => {
  it('are the four fixed kinds, collection first', () => {
    expect(TEMPLATES).toEqual(['collection', 'enrichment', 'activity', 'relation']);
    expect(Object.isFrozen(TEMPLATES)).toBe(true);
  });

  it('reads an entity\'s template through its profile, collection when there is none', () => {
    expect(ENTITY_TEMPLATE_SQL()).toBe(`COALESCE((SELECT p."template" FROM "OrgImportProfiles" p WHERE p."id" = e."profileId"), 'collection')`);
    expect(ENTITY_TEMPLATE_SQL('x')).toContain('p."id" = x."profileId"');
  });
});
