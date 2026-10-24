import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the Adjust tree mutation run (stryker.adjusttree.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it fails the dry run. These tests read only their own module's
// neighbour (the migration test reads 102_context_tree_adjustments.sql inside the sandbox).

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/contexts/adjustments/*.test.js',
      'src/contexts/plugins/manager-hierarchy.layout.test.js',
      'src/contexts/plugins/manager-hierarchy.test.js',
      'src/routes/contexts/trees.test.js',
      'src/db/migrations/102_context_tree_adjustments.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
