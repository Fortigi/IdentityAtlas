import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the hooks mutation run (stryker.hooks.config.json).
//
// Standalone rather than spreading vite.config.js, for the same reasons as
// vitest.stryker.config.js: Stryker sandboxes app/ui alone, so the normal test
// `include` reaching ../../tools/crawlers/** resolves nothing there and aborts the
// run before a mutant is evaluated, and the tailwind plugin plus the '@crawlers'
// alias are build concerns that buy the mutation run nothing.
//
// WIDER THAN THE FOUR HOOKS' OWN TESTS, AND MEASURED RATHER THAN GUESSED. The
// obvious include — the four *.test.jsx files next to the hooks — leaves branches
// unexercised that the component mount tests do reach, and every one of those
// would have come back a SURVIVOR that no test could ever kill. Measured before
// choosing: coverage of the four hooks under the hooks' own tests alone is
// 70.63% branch, under the full UI suite 75.46%, and under the list below 75.46%
// — identical to the full suite, with the same uncovered lines. So the narrowing
// costs nothing.
//
//   EntityListPage.mount.test.jsx   drives useEntityPage through the real list page
//   MatrixView.mount.test.jsx       drives useMatrixRowOrder + useNestedGroupExpand
//   App.mount.test.jsx              the only test that mounts the useMatrix caller
//   nestedRows.helpers.test.js      the row builder that consumes the expand cache
//
// pageRegistry.test.jsx is deliberately absent: it was measured too and moved none
// of these numbers, so it cannot be any mutant's only killer here.
//
// Re-measure this comparison when adding a hook to the `mutate` list — the answer
// is per-file, not a property of the directory.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/hooks/useMatrix.test.jsx',
      'src/hooks/useNestedGroupExpand.test.jsx',
      'src/hooks/useEntityPage.test.jsx',
      'src/hooks/useMatrixRowOrder.test.js',
      'src/components/EntityListPage.mount.test.jsx',
      'src/components/MatrixView.mount.test.jsx',
      'src/App.mount.test.jsx',
      'src/components/matrix/nestedRows.helpers.test.js',
    ],
    exclude: ['**/node_modules/**'],
  },
});
