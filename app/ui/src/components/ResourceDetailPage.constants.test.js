import { describe, it, expect } from 'vitest';
import { RESOURCE_TYPE_COLORS } from './ResourceDetailPage.constants.js';

// Regression guard for #719.
//
// The map keyed app roles as 'EntraAppRole' — a type only the demo dataset ever
// produced. The Entra crawler emits the unprefixed 'AppRole'
// (EntraIDCrawler.Phases.ps1), so against a real tenant every app role fell
// through to the grey default and rendered uncoloured. The demo data hid it:
// the UI was, in effect, written against the fixture rather than the product.
//
// This deliberately does NOT assert the map is exhaustive. resourceType is an
// OPEN vocabulary (CSV / custom-connector / OData / Omada / midPoint / Azure all
// supply their own names), so an unknown key is legal and the grey default is
// the correct fallback. What it pins is the two directions that were wrong:
// the types the Entra crawler really emits must be coloured, and the retired
// system-prefixed literals must never be keys again.
describe('ResourceDetailPage — resource-type colours', () => {
  it('colours the resourceTypes the Entra crawler emits', () => {
    for (const t of ['Group', 'AppRole', 'EntraDirectoryRole']) {
      expect(RESOURCE_TYPE_COLORS[t], `${t} should have a colour`).toBeTruthy();
    }
  });

  it('never keys on a retired system-prefixed literal', () => {
    // Renamed by migrations 052 (EntraGroup, EntraRole) and 058 (EntraAppRole);
    // rejected at the DB by 054's CHECK, so a key here could never match a row.
    for (const t of ['EntraGroup', 'EntraRole', 'EntraAppRole']) {
      expect(RESOURCE_TYPE_COLORS, `${t} must not be a colour key`).not.toHaveProperty(t);
    }
  });
});
