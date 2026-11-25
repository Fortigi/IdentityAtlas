// GENERATED from stryker.reports.config.json by `npm run mutation-scopes:generate`
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
      'src/components/ReportsPage.mount.test.jsx',
      'src/components/inputs/EntityLookup.mount.test.jsx',
      'src/components/reports/ListReportRenderer.mount.test.jsx',
      'src/components/reports/ReportViewPage.mount.test.jsx',
      'src/components/reports/formRenderers.test.js',
      'src/components/reports/reportExport.test.js',
      'src/utils/download.test.js',
      'src/components/reports/ask/CompareCondition.test.js',
      'src/components/reports/ask/ConfirmChoices.mount.test.jsx',
      'src/hooks/useCanBuildReports.test.js',
      'src/components/reports/ask/AskAssistant.mount.test.jsx',
      'src/components/reports/ask/AskAssistant.text.test.js',
      'src/components/reports/ask/useAskConversation.test.jsx',
      'src/components/reports/ask/useReportPreview.test.jsx',
      'src/components/reports/ask/useSavedReportActions.test.jsx',
      'src/components/SchemaConfigForm.mount.test.jsx',
      'src/components/UserActivitySection.mount.test.jsx',
      'src/components/reports/ReportNotices.mount.test.jsx',
      'src/components/reports/reportParams.test.js',
      'src/components/reports/ReportViewWizard.mount.test.jsx',
      'src/components/reports/reportViewSteps.test.js',
      'src/components/reports/ReportSummary.mount.test.jsx',
      'src/components/reports/summaryData.test.js',
    ],
    exclude: ['**/node_modules/**'],
  },
});
