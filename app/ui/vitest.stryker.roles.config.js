import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the business-role mutation run
// (stryker.roles.config.json).
//
// Standalone rather than spreading vite.config.js, for the same reason as
// vitest.stryker.hooks.config.js: Stryker sandboxes app/ui alone, so the normal
// test `include` reaching ../../tools/crawlers/** resolves nothing there and
// aborts the run before a mutant is evaluated.
//
// WIDER THAN THE TWO MODULES' OWN TESTS, BY TRACING THE IMPORTERS. Both modules
// are consumed by components as well as covered directly, and a mutant whose
// only killer sits in a component test would otherwise come back a SURVIVOR —
// a wrong number, which is worse than a smaller true one:
//
//   coverageDeviation.js   -> MatrixGroupRow (per-cell markers),
//                             MatrixView (the Gaps row filter + folded tallies)
//   useBusinessRoleFold.js -> useMatrixBusinessRoleLayer, and through it MatrixView
//                             (row layout, export rows, toolbar)
//                             SortableMatrixBody (which rows stay draggable)
//   useMatrixBusinessRoleLayer.js -> MatrixView only: it IS the switch
//
// Nothing else imports either module, so the list below is the complete set of
// places a mutant can be killed. Re-trace it when adding a module here.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/matrix/coverageDeviation.test.js',
      'src/hooks/useBusinessRoleFold.test.jsx',
      'src/hooks/useMatrixBusinessRoleLayer.test.jsx',
      'src/components/matrix/MatrixGroupRow.mount.test.jsx',
      'src/components/matrix/SortableMatrixBody.test.js',
      'src/components/MatrixView.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
