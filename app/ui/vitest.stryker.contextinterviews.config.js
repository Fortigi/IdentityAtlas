import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the context-interviews mutation run
// (stryker.contextinterviews.config.json). Standalone for the same sandbox reason as
// vitest.stryker.roles.config.js. The include is the helpers tests and the mount
// tests that drive the People overview, What we know, Sources, the review drawer
// and the unit page body.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/contexts/interviews/claims.helpers.test.js',
      'src/components/contexts/interviews/interviews.mount.test.jsx',
      'src/components/contexts/interviews/interviewForms.mount.test.jsx',
      'src/components/contexts/interviews/interviewKnowledge.mount.test.jsx',
      'src/components/contexts/interviews/transcript.helpers.test.js',
      'src/components/contexts/interviews/memberInterview.helpers.test.js',
      'src/components/contexts/interviews/whatWeKnowFacts.mount.test.jsx',
      'src/components/contexts/interviews/contradictions.mount.test.jsx',
      'src/components/contexts/changeRequests/changeRequests.mount.test.jsx',
      'src/components/contexts/people/people.helpers.test.js',
      'src/components/contexts/people/PeopleSection.mount.test.jsx',
      'src/components/contexts/people/PersonClaims.mount.test.jsx',
      'src/components/contexts/page/ProfileBody.mount.test.jsx',
      'src/components/workbench/workbench.model.test.js',
      'src/components/workbench/workbench.labels.test.js',
      'src/components/workbench/workbench.roles.test.js',
      'src/components/workbench/workbench.columns.test.js',
      'src/components/workbench/workbench.rule.test.js',
      'src/components/workbench/WorkbenchPage.mount.test.jsx',
      'src/components/workbench/WorkbenchPage.save.mount.test.jsx',
      'src/components/workbench/workbench.save.test.js',
      'src/components/workbench/useWorkbench.loadSaved.test.js',
      // The shared matrix badges (MatrixBadges.jsx), as the matrix renders them.
      'src/components/matrix/MatrixCell.mount.test.jsx',
      'src/components/matrix/MatrixLegend.test.js',
    ],
    exclude: ['**/node_modules/**'],
  },
});
