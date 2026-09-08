import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the matrix mutation run (stryker.matrix.config.json).
//
// Narrow include, for the same reason as the other vitest.stryker.* configs: Stryker
// copies app/api into a temp sandbox, so any test that reads the real filesystem or the
// crawler manifests at ../../tools/crawlers resolves a path that does not exist there,
// fails the dry run, and aborts the whole run before a single mutant is evaluated.
//
// WIDER THAN THE MUTATED DIRECTORY, ON PURPOSE. `src/matrix/**` alone would be the
// obvious include and would be wrong: six of the eight modules are also reached
// transitively through the route layer, and a mutant whose only killer sits in a route
// test would come back a SURVIVOR. That is the failure this narrowing is most likely to
// cause, and a wrong number is worse than a smaller true one — so every direct importer's
// tests are included:
//
//   src/routes/matrix/data.js      -> attrExpr, inheritedAccess, contextRollup,
//                                     attributeCut, resourceContexts, rollupBuilders
//   src/routes/matrix/scope.js     -> scopeHistory, attrExpr
//   src/routes/matrix/shared.js    -> filterSql   (and via it src/routes/permissions/)
//   src/routes/matrix/savedFilters.js, src/routes/matrix.js -> filterSql, inheritedAccess
//   src/routes/resources.js        -> resourceContexts
//
// Same rule for the attribute-label pair added to this scope:
//
//   src/routes/attributeLabels.js  -> lib/attributeLabels.js  (the endpoint)
//   src/routes/matrix.js, src/routes/resources.js, src/routes/permissions/**,
//   src/routes/tags/entities.js    -> lib/attributeLabels.js  (withAttributeLabels)
//
// attributeLabelChannel.test.js is what drives that last group — it asserts the `label`
// channel on the column-discovery responses, so a mutant in withAttributeLabels whose only
// killer lives there would otherwise read as a survivor. tags/entities.test.js is not
// included: it exercises the same withAttributeLabels call the channel test already pins,
// so it can kill nothing the others don't and only adds runtime.
//
// src/db/matrixHelpers.test.js is deliberately NOT here: matrixHelpers.js imports none of
// the eight, so its tests can kill nothing and would only add runtime.
//
// If you add a module to this scope's `mutate` list, trace its importers and widen this
// include to match, rather than assuming the co-located test is the only killer.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/matrix/**/*.test.js',
      'src/routes/matrix/**/*.test.js',
      'src/routes/matrix.*.test.js',
      'src/routes/resources.test.js',
      'src/routes/permissions/**/*.test.js',
      'src/lib/attributeLabels.test.js',
      'src/routes/attributeLabels.test.js',
      'src/routes/attributeLabelChannel.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
