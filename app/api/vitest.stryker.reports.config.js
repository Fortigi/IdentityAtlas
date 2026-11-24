// GENERATED from stryker.reports.config.json by `npm run mutation-scopes:generate`
// (app/api). Do not edit: that file's `tests` list is the one declaration of what
// runs against its `mutate` list, and its `tests_comment` says why.
//
// A narrow include, not a growing exclude list: Stryker runs in a sandbox copy of
// app/api, where a test reading files outside it fails the dry run, and an
// excluded test that was some mutant's only killer would read as a false survivor.

import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/reports/export.test.js',
      'src/reports/xlsxPivots.test.js',
      'src/reports/xlsxCharts.test.js',
      'src/reports/humanReview.test.js',
      'src/reports/templates/access-review-adoption.test.js',
      'src/reports/templates/access-reviewer-response.test.js',
      'src/reports/registry.test.js',
      'src/lookups/registry.test.js',
      'src/lookups/sources/accessReviewFields.test.js',
      'src/lookups/sources/resourceContexts.test.js',
      'src/lookups/sources/unitContexts.test.js',
      'src/reports/templates/unit-members.test.js',
      'src/reports/unitClaims.test.js',
      'src/lookups/sources/applicationPermissions.test.js',
      'src/reports/appPermissionRisk.test.js',
      'src/reports/templates/high-risk-application-permissions.test.js',
      'src/reports/appRiskPermissions.test.js',
      'src/reports/appRiskRules.test.js',
      'src/reports/appRiskData.test.js',
      'src/reports/templates/risky-applications.test.js',
      'src/reports/accessReviewFields.test.js',
      'src/reports/attributeColumns.test.js',
      'src/reports/contextDetails.test.js',
      'src/lib/resourceOwners.test.js',
      'src/lib/ownedResources.test.js',
      'src/lib/ownershipTypes.test.js',
      'src/contexts/resourceMemberFacts.test.js',
      'src/routes/lookups.test.js',
      'src/reports/templates/application-access-review.test.js',
      'src/reports/templates/orphaned-accounts.test.js',
      'src/routes/reports.test.js',
      'src/routes/reportViews.test.js',
      'src/reports/views.test.js',
      'src/accountlinking/orphanQuery.test.js',
      'src/contexts/plugins/orphaned-accounts.test.js',
      'src/lib/dateOnly.test.js',
      'src/lib/lastSignInFilter.test.js',
      'src/lib/principalActivity.test.js',
      'src/reports/activityWindow.test.js',
      'src/reports/templates/activityReports.test.js',
      'src/reports/templates/structuralReports.test.js',
      'src/routes/details/userActivity.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
