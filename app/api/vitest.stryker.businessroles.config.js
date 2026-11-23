import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the business-role mutation run (stryker.businessroles.config.json).
// An explicit list, as in the sibling configs: Stryker runs in a sandbox copy of
// app/api, so a test that reads a file outside it would fail the dry run.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/lib/businessRoleAccessModel.test.js',
      'src/lib/businessRoleOwners.test.js',
      'src/lib/businessRoleOwnerSuggestion.test.js',
      'src/routes/details/businessRoleOwners.test.js',
      'src/lib/businessRoleOwnerImport.test.js',
      'src/routes/details/businessRoleOwnerImport.test.js',
      'src/routes/ingest/businessRoleOwners.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
