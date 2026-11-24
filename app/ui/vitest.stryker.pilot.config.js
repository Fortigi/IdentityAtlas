// GENERATED from stryker.pilot.config.json by `npm run mutation-scopes:generate`
// (app/api). Do not edit: that file's `tests` list is the one declaration of what
// runs against its `mutate` list, and its `tests_comment` says why.
//
// A narrow include, not a growing exclude list: Stryker runs in a sandbox copy of
// app/ui, where a test reading files outside it fails the dry run, and an
// excluded test that was some mutant's only killer would read as a false survivor.
//
// Standalone rather than spreading vite.config.js: its include reaches
// ../../tools/crawlers/**, outside the sandbox, and its tailwind plugin and
// '@crawlers' alias are build concerns the mutation run does not need.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/auth/usePermissions.test.jsx',
      'src/auth/authFetchHeaders.test.js',
      'src/auth/authMeState.test.js',
      'src/utils/matrixFilter.test.js',
      'src/components/shared/sharedSnapshot.test.js',
      'src/hooks/useHashPage.test.jsx',
      'src/hooks/useFeatureToggle.test.jsx',
      'src/hooks/useCanShareMatrix.test.jsx',
      'src/components/crawler/saveCrawlerConfig.test.js',
      'src/components/crawler/crawlerWizardHooks.test.jsx',
      'src/utils/attributeLabels.test.js',
      'src/hooks/useAttributeLabels.test.jsx',
      'src/components/matrix/shareState.test.js',
      'src/components/matrix/useSavedMatrixNaming.test.js',
      'src/components/matrix/sortStepState.test.js',
      'src/components/matrix/saveStepState.test.js',
      'src/components/matrix/matrixRequests.test.js',
      'src/components/matrix/matrixHistoryText.test.js',
      'src/components/inputs/PeoplePicker.mount.test.jsx',
      'src/utils/exportRotatedToExcel.test.js',
    ],
    exclude: ['**/node_modules/**'],
  },
});
