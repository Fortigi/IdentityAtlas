import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Guard against the matrix double-scrollbar regression.
//
// The bug: the grid used a fixed `max-h-[calc(100vh-280px)]` that GUESSES the
// height of the chrome above it. The real chrome (auth banner + scope-statistics
// panel + "How to read") is taller than 280px, so the grid was too tall and the
// page got a second scrollbar next to the grid's own. The fix caps the grid with
// a measured inline maxHeight — from the shared useResizableGridHeight hook,
// which wraps useViewportFitHeight — in EVERY matrix orientation. The hooks'
// own behaviour (including that the fit never returns more than the available
// space) is covered by src/hooks/useViewportFitHeight.test.jsx and
// src/hooks/useResizableGridHeight.test.jsx.

const here = dirname(fileURLToPath(import.meta.url));
const sources = {
  MatrixView: readFileSync(join(here, 'MatrixView.jsx'), 'utf8'),
  RotatedMatrixView: readFileSync(join(here, 'RotatedMatrixView.jsx'), 'utf8'),
  RollupMatrixView: readFileSync(join(here, 'RollupMatrixView.jsx'), 'utf8'),
};

describe('matrix grid height — no double scrollbar', () => {
  for (const [name, src] of Object.entries(sources)) {
    describe(name, () => {
      it('does not use the fixed max-h-[calc(100vh-280px)] magic number', () => {
        expect(src).not.toContain('max-h-[calc(100vh-280px)]');
      });
      it('takes its cap from the shared measuring hook', () => {
        expect(src).toContain("import useResizableGridHeight from '@ui/hooks/useResizableGridHeight'");
        expect(src).toMatch(/const gridHeight = useResizableGridHeight\(/);
        expect(src).toMatch(/const gridMaxH = gridHeight\.height/);
      });
      it('caps the grid with a measured inline maxHeight', () => {
        expect(src).toMatch(/maxHeight: gridMaxH/);
      });
      // Requestor feedback on #370: the measured fit is a default, not a
      // verdict — every orientation offers the same grip to resize it.
      it('offers the shared resize grip', () => {
        expect(src).toContain("import GridResizeHandle from './matrix/GridResizeHandle'");
        expect(src).toMatch(/<GridResizeHandle/);
      });
      it('does not re-introduce a hand-rolled height floor', () => {
        expect(src).not.toMatch(/Math\.max\(\s*\d+\s*,\s*(vh|avail)/);
      });
    });
  }
});
