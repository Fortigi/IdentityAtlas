import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config for the list-page hook mutation run (stryker.listhooks.config.json).
//
// Standalone rather than spreading vite.config.js, for the same reason as the other
// vitest.stryker.* configs: Stryker sandboxes app/ui alone, so the normal test include
// reaching ../../tools/crawlers/** resolves nothing there and aborts the run.
//
// TWO TEST FILES, AND THAT IS THE POINT OF THIS CONFIG EXISTING. useEntityPage was
// originally measured alongside the matrix hooks, which meant every one of its ~320
// mutants also paid for MatrixView.mount and App.mount to load. Splitting on which
// mount test each hook actually needs cuts per-mutant cost rather than merely dividing
// the same work between two jobs.
//
// Parity checked, not assumed: coverage of useEntityPage under these two files is
// 79.69% stmts / 71.71% branch / 84.31% funcs / 80.24% lines, identical to the full UI
// suite with the same uncovered lines. It was 4 branches short until the sidecar-failure
// tests were added to useEntityPage.test.jsx — those arms had only ever been reached
// incidentally by a mount test elsewhere in the suite, which is both a poor place for
// the contract to live and exactly the kind of dependency that turns into a false
// survivor when a scope is narrowed.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/hooks/useEntityPage.test.jsx',
      'src/components/EntityListPage.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
