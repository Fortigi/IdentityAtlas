// GENERATED from stryker.contextinterviews.config.json by `npm run mutation-scopes:generate`
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
      'src/components/contexts/page/unitProposals.test.js',
      'src/components/contexts/page/ProposedRolesSection.mount.test.jsx',
      'src/components/matrix/MatrixCell.mount.test.jsx',
      'src/components/matrix/MatrixLegend.test.js',
      'src/components/matrix/proposedLens.test.js',
      'src/components/matrix/ProposedMatrix.mount.test.jsx',
      'src/components/contexts/interviews/orgKnowledgeOff.mount.test.jsx',
      'src/components/EntityTimeline.helpers.test.js',
      'src/components/EntityTimeline.test.jsx',
      'src/components/EntityTimeline.filter.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
