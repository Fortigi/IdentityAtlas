import { describe, it, expect } from 'vitest';
import { TEMPLATES, ENTITY_TEMPLATE_SQL, templateOf } from './templates.js';

describe('templates', () => {
  it('lists exactly the four fixed templates, collection first (the default)', () => {
    expect(TEMPLATES).toEqual(['collection', 'enrichment', 'activity', 'relation']);
  });

  it('reads an entity\'s template through its profile, defaulting to collection, on the alias given', () => {
    expect(ENTITY_TEMPLATE_SQL()).toBe(`COALESCE((SELECT p."template" FROM "OrgImportProfiles" p WHERE p."id" = e."profileId"), 'collection')`);
    expect(ENTITY_TEMPLATE_SQL('x')).toContain('WHERE p."id" = x."profileId"');
  });

  it('templateOf: the recipe\'s template, collection when absent or unknown', () => {
    expect(templateOf({ template: 'activity' })).toBe('activity');
    expect(templateOf({ template: 'relation' })).toBe('relation');
    expect(templateOf({})).toBe('collection');
    expect(templateOf({ template: 'timesheet' })).toBe('collection');
    expect(templateOf(null)).toBe('collection');
  });
});
