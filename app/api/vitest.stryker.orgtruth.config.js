import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the organisation-truth mutation run (stryker.orgtruth.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it resolves a path that does not exist there, fails the dry run, and
// aborts the whole run before a single mutant is evaluated.
//
// Every workstream that adds a file to `mutate` adds its killing tests here.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/orgtruth/contracts.test.js',
      'src/orgtruth/linking/run.test.js',
      'src/orgtruth/linking/stats.test.js',
      'src/orgtruth/projection/plugin.test.js',
      'src/routes/orgTruth.test.js',
      'src/orgtruth/http/propose.test.js',
      'src/orgtruth/propose/heuristic.test.js',
      'src/orgtruth/propose/names.test.js',
      'src/orgtruth/propose/prompt.test.js',
      'src/orgtruth/propose/service.test.js',
      'src/orgtruth/propose/probe.test.js',
      'src/orgtruth/projection/project.test.js',
      'src/orgtruth/projection/projectionSql.test.js',
      'src/orgtruth/projection/pluginPrincipals.test.js',
      'src/orgtruth/projection/refresh.test.js',
      'src/orgtruth/model/metaGraph.test.js',
      'src/orgtruth/model/entities.test.js',
      'src/orgtruth/model/graph.test.js',
      'src/orgtruth/model/evidence.test.js',
      'src/orgtruth/model/linkedTo.test.js',
      'src/orgtruth/model/filterOptions.test.js',
      'src/orgtruth/http/model.test.js',
      'src/orgtruth/linking/signals.test.js',
      'src/orgtruth/linking/candidates.test.js',
      'src/orgtruth/linking/score.test.js',
      'src/orgtruth/linking/plan.test.js',
      'src/orgtruth/linking/detect.test.js',
      'src/orgtruth/linking/sourceEntities.test.js',
      'src/orgtruth/linking/review.test.js',
      'src/orgtruth/linking/reviewGroups.test.js',
      'src/orgtruth/http/links.test.js',
      'src/orgtruth/import/parse.test.js',
      'src/orgtruth/import/profileColumns.test.js',
      'src/orgtruth/import/applyRecipe.test.js',
      'src/orgtruth/import/writeRun.test.js',
      'src/orgtruth/import/runImport.test.js',
      'src/orgtruth/import/dryRun.test.js',
      'src/orgtruth/import/sourceStore.test.js',
      'src/orgtruth/import/profileStore.test.js',
      'src/orgtruth/import/httpHelpers.test.js',
      'src/orgtruth/http/sources.test.js',
      'src/orgtruth/http/profiles.test.js',
      'src/orgtruth/http/runs.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
