import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the organisation-truth mutation run
// (stryker.orgtruth.config.json). Standalone for the same reasons as the sibling
// stryker vitest configs (Stryker sandboxes app/ui alone). Every workstream that
// adds a file to `mutate` adds its killing tests here.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/hooks/useCanImportOrgTruth.test.js',
      'src/components/orgtruth/OrgTruthPage.mount.test.jsx',
      'src/components/orgtruth/wizard/wizardDraft.test.js',
      'src/components/orgtruth/wizard/wizardApi.test.js',
      'src/components/orgtruth/wizard/useImportRun.test.jsx',
      'src/components/orgtruth/wizard/ImportWizard.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
