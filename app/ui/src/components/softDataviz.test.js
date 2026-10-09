import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Solid data-viz fills (bars, graph nodes) should use the app's soft pastel
// tiers, not the hard 500/600 saturation that reads as "bright". Thin marks
// (chart lines, strokes, text) keep their stronger colours. See the UI Style
// Guide § saturation. These guards stop a regression back to the hard values.
const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

describe('data-viz fills use soft tiers', () => {
  it('relationship graph node fills use soft tiers, never the saturated 500/600', () => {
    const src = read('graph/graphDraw.js');
    // The node circle palette (NODE_CLASS); thin marks like the arrowhead keep
    // their stronger colours.
    const start = src.indexOf('const NODE_CLASS');
    const palette = src.slice(start, src.indexOf('};', start));
    const fills = palette.match(/fill-[a-z]+-[0-9]{2,3}/g) || [];
    // Soft light fills (50-200), deep dark-mode fills (800-950).
    expect(fills.length).toBeGreaterThan(5);
    expect(fills.filter(f => /-(500|600)$/.test(f))).toEqual([]);
    expect(fills).toContain('fill-lime-200');
  });

  it('ConfidenceBar uses pastel fills', () => {
    const src = read('ConfidenceBar.jsx');
    expect(src).not.toContain('bg-green-500');
    expect(src).not.toContain('bg-orange-500');
    expect(src).toContain('bg-green-300');
  });

  it('GovernancePage compliance bar uses pastel fills', () => {
    const src = read('GovernancePage.jsx');
    expect(src).not.toContain('bg-green-500');
    expect(src).toContain('bg-green-300');
  });

  it('RiskScoringPage score bar softened to -400', () => {
    const src = read('RiskScoringPage.jsx');
    expect(src).not.toContain('bg-red-500');
    expect(src).toContain('bg-red-400');
  });

  it('DepartmentDetailPage tier bars softened (no -500 hex)', () => {
    // The tier fill palette lives in the extracted departmentTiers.js module.
    const src = read('departmentTiers.js');
    expect(src).not.toContain('#ef4444'); // red-500
    expect(src).toContain('#f87171'); // red-400
  });
});
