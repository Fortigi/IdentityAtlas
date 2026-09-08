import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the reports mutation run (stryker.reports.config.json).
//
// Standalone rather than spreading vite.config.js, for the same reasons as
// vitest.stryker.hooks.config.js: Stryker sandboxes app/ui alone, so the normal test
// `include` reaching ../../tools/crawlers/** resolves nothing there and aborts the run
// before a mutant is evaluated, and the tailwind plugin plus the '@crawlers' alias are
// build concerns that buy the mutation run nothing.
//
// The three mutated files are covered by exactly these three test files: the page's own
// mount test, the list renderer's, and the form-map unit test. pageRegistry.test.jsx only
// builds the route element (it never mounts ReportsPage), so it cannot be any mutant's
// killer here and is deliberately absent — every mutant pays for every test listed.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/ReportsPage.mount.test.jsx',
      'src/components/reports/ListReportRenderer.mount.test.jsx',
      'src/components/reports/formRenderers.test.js',
    ],
    exclude: ['**/node_modules/**'],
  },
});
