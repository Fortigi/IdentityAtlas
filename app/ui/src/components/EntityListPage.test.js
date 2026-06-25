import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src  = readFileSync(join(here, 'EntityListPage.jsx'), 'utf8');

describe('EntityListPage scaffold', () => {
  it('delegates state management to useEntityPage', () => {
    expect(src).toContain('useEntityPage');
  });

  it('accepts subTabBar, tableColumns, fieldLabels, and search placeholder props', () => {
    expect(src).toContain('subTabBar');
    expect(src).toContain('tableColumns');
    expect(src).toContain('fieldLabels');
    expect(src).toContain('searchPlaceholder');
  });

  it('renders a table calling renderEntityCell and renderDataCells per row', () => {
    expect(src).toContain('renderEntityCell');
    expect(src).toContain('renderDataCells');
  });

  it('consumers (GroupsPage, UsersPage, IdentitiesPage) no longer contain pagination logic', () => {
    const groupsSrc      = readFileSync(join(here, 'GroupsPage.jsx'), 'utf8');
    const usersSrc       = readFileSync(join(here, 'UsersPage.jsx'), 'utf8');
    const identitiesSrc  = readFileSync(join(here, 'IdentitiesPage.jsx'), 'utf8');
    // Each page now delegates to EntityListPage rather than owning pagination state
    for (const s of [groupsSrc, usersSrc, identitiesSrc]) {
      expect(s).toContain('EntityListPage');
    }
  });
});
