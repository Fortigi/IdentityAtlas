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
      'src/components/orgtruth/orgFormat.test.js',
      'src/components/orgtruth/modelGraph.test.js',
      'src/components/orgtruth/reviewRows.test.js',
      'src/components/orgtruth/sourceDownload.test.js',
      'src/components/orgtruth/useLinkOverride.test.js',
      'src/components/orgtruth/SourcesTab.mount.test.jsx',
      'src/components/orgtruth/ModelTab.mount.test.jsx',
      'src/components/orgtruth/EntitiesTab.mount.test.jsx',
      'src/components/orgtruth/ReviewTab.mount.test.jsx',
      'src/components/orgtruth/OrgEntityDetailPage.mount.test.jsx',
      'src/components/orgtruth/evidence.test.js',
      'src/components/orgtruth/OrgEvidenceSection.mount.test.jsx',
      'src/components/orgtruth/reviewGroups.test.js',
      'src/components/orgtruth/OrgLinkTable.mount.test.jsx',
      'src/components/orgtruth/linkRulesDraft.test.js',
      'src/components/orgtruth/modelCanvas.test.js',
      'src/components/orgtruth/LinkRulesEditor.mount.test.jsx',
      'src/components/orgtruth/orgGraphBranch.test.js',
      'src/components/orgtruth/useOrgLinked.test.js',
      'src/components/orgtruth/orgCondition.test.js',
      'src/components/orgtruth/OrgConditionPicker.mount.test.jsx',
      'src/components/entityGraphShape.test.js',
      'src/components/IdentityDetailPage.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
