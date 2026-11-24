// GENERATED from stryker.roles.config.json by `npm run mutation-scopes:generate`
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
