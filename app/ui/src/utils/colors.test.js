import { describe, it, expect } from 'vitest';
import { TYPE_COLORS } from './colors.js';

// Locks the matrix/legend badge palette to the current assignment model: the
// membership types that render as badges are exactly the three universal values.
// The retired types (Owner/Governed/OAuth2Grant/AppRole/AppRoleViaGroup/…) must
// never get a swatch back — they can no longer appear in the data (see
// app/api/src/ingest/assignmentTypes.guard.test.js). A regression here would
// reintroduce a badge for a value the matrix can never produce.
describe('TYPE_COLORS — matrix/legend badge palette', () => {
  it('has exactly the three universal membership types', () => {
    expect(Object.keys(TYPE_COLORS).sort()).toEqual(['Direct', 'Eligible', 'Indirect']);
  });

  it('carries no retired assignment type', () => {
    const retired = ['Owner', 'Governed', 'OAuth2Grant', 'AppRole', 'AppRoleViaGroup', 'DirectoryRole', 'DirectoryRoleEligible'];
    for (const t of retired) {
      expect(TYPE_COLORS[t], `${t} must not have a badge swatch`).toBeUndefined();
    }
  });

  it('gives each type a letter and valid hex bg/text colours', () => {
    for (const [type, s] of Object.entries(TYPE_COLORS)) {
      expect(s.letter, `${type}.letter`).toBeTruthy();
      expect(s.bg, `${type}.bg`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(s.text, `${type}.text`).toMatch(/^#[0-9a-fA-F]{3,6}$/);
    }
  });
});
