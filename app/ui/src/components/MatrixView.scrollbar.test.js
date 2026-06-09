import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Guard against the matrix double-scrollbar regression.
//
// The bug: the grid used a fixed `max-h-[calc(100vh-280px)]` that GUESSES the
// height of the chrome above it. The real chrome (auth banner + scope-statistics
// panel + "How to read") is taller than 280px, so the grid was too tall and the
// page got a second scrollbar next to the grid's own. The fix measures the real
// remaining viewport (clientHeight minus the grid's document-top) and caps the
// grid's height with an inline maxHeight — in BOTH matrix orientations.

const here = dirname(fileURLToPath(import.meta.url));
const sources = {
  MatrixView: readFileSync(join(here, 'MatrixView.jsx'), 'utf8'),
  RotatedMatrixView: readFileSync(join(here, 'RotatedMatrixView.jsx'), 'utf8'),
};

describe('matrix grid height — no double scrollbar', () => {
  for (const [name, src] of Object.entries(sources)) {
    describe(name, () => {
      it('does not use the fixed max-h-[calc(100vh-280px)] magic number', () => {
        expect(src).not.toContain('max-h-[calc(100vh-280px)]');
      });
      it('measures the real layout height (documentElement.clientHeight)', () => {
        expect(src).toContain('document.documentElement.clientHeight');
      });
      it('caps the grid with a measured inline maxHeight', () => {
        expect(src).toMatch(/maxHeight: gridMaxH/);
      });
    });
  }
});
