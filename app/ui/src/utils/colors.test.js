import { describe, it, expect } from 'vitest';
import { TYPE_COLORS, TAG_COLORS, AP_COLORS, tagPillStyle, contrastRatio } from './colors.js';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

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

describe('tagPillStyle — contrast-safe tag/category pills (#759)', () => {
  // Colours a tag pill can actually be handed: the TAG_COLORS picker palette,
  // the pastel access-package palette, and a couple of arbitrary imported hexes.
  const samples = [...TAG_COLORS, ...AP_COLORS, '#ef4444', '#ffffff', '#000000', '#84cc16'];

  for (const isDark of [false, true]) {
    it(`text clears WCAG AA (4.5:1) against the pill background in ${isDark ? 'dark' : 'light'} mode`, () => {
      for (const hex of samples) {
        const s = tagPillStyle(hex, isDark);
        expect(s.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
        expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(s.borderColor).toMatch(/^#[0-9a-f]{6}$/);
        const ratio = contrastRatio(hexToRgb(s.color), hexToRgb(s.backgroundColor));
        expect(ratio, `${hex} (${isDark ? 'dark' : 'light'}) → ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('never returns the raw color+"20" alpha string', () => {
    const s = tagPillStyle('#1d4ed8', false);
    expect(s.backgroundColor).not.toContain('20');
    expect(s.backgroundColor.length).toBe(7); // #rrggbb, not #rrggbbaa
  });

  it('falls back to a neutral grey for an invalid hex instead of throwing', () => {
    for (const bad of [null, undefined, '', 'not-a-color', '#12']) {
      const s = tagPillStyle(bad, false);
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
      const ratio = contrastRatio(hexToRgb(s.color), hexToRgb(s.backgroundColor));
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('produces different backgrounds for light vs dark mode', () => {
    const light = tagPillStyle('#1d4ed8', false);
    const dark = tagPillStyle('#1d4ed8', true);
    expect(light.backgroundColor).not.toBe(dark.backgroundColor);
  });
});
