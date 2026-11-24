# Mutation scope history

Why files joined a JavaScript mutation scope after it was first set up. Moved here verbatim
from the `_comment` of each scope's `stryker.<scope>.config.json` (#1696), so the config keeps
what the next editor needs at the point of edit (the mutator set, the floor and its reasoning,
exclusions, equivalent mutants) and the growth log lives in one place.

A scope's current files and tests are its config's `mutate` and `tests` lists; this page is
the record of how they got there. Entries marked NOT YET MEASURED were added without a
Stryker run of that scope, so the floor in the config predates them.

Add to this page, not to `_comment`, when a file joins an existing scope for a reason worth
keeping.

"Below" and "above" in an entry refer to the config it came from: an exclusion mentioned
that way is in that config's `mutationExclusions`. How scopes are declared is in
[Writing tests that actually assert](writing-tests-that-assert.md#javascript-stryker).

## API auth (`app/api/stryker.auth.config.json`) {#api-auth}

SCOPE GREW FOR #1166: src/auth/shareTokens.js and src/routes/matrix/shareRecipients.js joined it. Both are the same kind of code this config already measures — a token's shape and a caller's identity, decided by pure functions with their own fully-mocked unit tests — and together they are the WHOLE access decision for a shared matrix: shareTokens says which snapshot a URL resolves to, shareRecipients says who is allowed to open it. shareRecipients lives under src/routes/matrix/ rather than src/auth/ because it is the matrix share route's own rule, but it touches no database and no request object, so it runs clean in the sandbox exactly like the src/auth files; vitest.stryker.auth.config.js names its test file explicitly rather than widening the include to src/routes/**, which would drag the filesystem-reading route tests back in. The route that USES them, src/routes/matrix/shares.js, is excluded with a reason below rather than mutated.

SCOPE GREW FOR SEC-2026-09 M-06: src/routes/crawlers/crawlerGuards.js joined it. It is the whole decision for which crawler permissions an admin may grant (the worker-class admin permission is bootstrap-only) and which edits the built-in worker row refuses — pure functions plus one lookup through an injected pool, with a fully-mocked unit test (crawlerGuards.test.js) that touches no filesystem, so it runs clean in the sandbox like the files above.

SCOPE GREW FOR SEC-2026-09 (M-08, I-04): src/secrets/masterKeyStore.js and src/config/fileSecrets.js joined it. They decide which secret the process runs with — where the vault master key is loaded from, when a legacy key file may be deleted, when a new key may be generated, and when a *_FILE secret replaces an environment variable. Their unit tests are self-contained (mocked database and vault, files only under os.tmpdir()), so they run clean in the sandbox; vitest.stryker.auth.config.js names both test files. src/config/loadFileSecrets.js is excluded with a reason below.

SCOPE GREW FOR SEC-2026-09 (request hardening): src/middleware/requestOriginGuard.js (auth-off Host allow-list and cross-site write decision), src/middleware/rateLimitKeys.js (trusted-proxy setting and whose bucket a request is charged to) and src/middleware/crawlerAuthFailureLimiter.js (when a failing crawler-key client is cut off) joined it. They are the same kind of code — pure request-identity decisions with their own fully-mocked unit tests and no filesystem or database access — so they run clean in the sandbox; vitest.stryker.auth.config.js names their test files explicitly. Their SQL/filesystem siblings from the same change are excluded with reasons below.

SCOPE GREW FOR PROFILE PHOTOS: src/auth/resolveMe.js joined it. It decides WHICH crawled principal the signed-in token belongs to — an identity decision of exactly the kind this config measures, and one whose failure mode is showing one person another person's data (hence the two-row email guard). It reaches the database only through an injected pool, so resolveMe.test.js mocks db/connection.js and touches no filesystem, running clean in the sandbox. It is not only the header avatar's source: any first-person feature ("my groups", "my employees") resolves the caller through this file, which is why it is measured rather than left to the route that calls it.

SCOPE GREW FOR ONE JOB PER CRAWLER: src/lib/crawlerJobQueue.js joined it. It decides whether a crawler configuration may start another run while one is queued or running (the scheduler, Run Now and the worker claim all ask it) — a guard of the same kind as crawlerGuards.js, reached only through an injected query function, so crawlerJobQueue.test.js runs clean in the sandbox. Its claim statement is SQL and is proven by contract-tests/crawlerJobQueue.contract.test.js, not here.

## API reports (`app/api/stryker.reports.config.json`) {#api-reports}

SCOPE GROWTH (#1222): the eight standard audit report templates, the measurement-moment helper they share (activityWindow.js), the activity primitives behind the user-list column and detail page (lib/principalActivity.js, lib/lastSignInFilter.js, lib/dateOnly.js) and the per-principal activity query (routes/details/userActivity.js) joined `mutate` when they landed, with their unit tests added to the vitest include list. They carry the orphan report's risk shape: a wrong window or join returns a plausible, silently wrong list, and their SQL is likewise only string-asserted here. NOT YET MEASURED with them in scope: the score quoted below predates them, so re-measure before relying on the floor.

SCOPE GROWTH (application access review): the application-access-review template joined `mutate` with its own unit test in the vitest include list. It carries a risk shape the other templates do not: the section rule (role membership beats requestable) and the direct/via-role split are arithmetic an owner acts on, and both fail silently — a swapped column or an inverted rule produces a table that renders. NOT YET MEASURED with it in scope.

SCOPE GROWTH (entity lookup): the lookup registry, its one built-in source and the route that serves them joined `mutate` with their unit tests in the vitest include list. Same risk shape as the report templates: a lookup that silently returns the wrong set, or drops the ESCAPE from its LIKE, offers a plausible list and nobody notices — nothing throws. The SQL itself is only string-asserted here; contract-tests/lookups.contract.test.js is what runs it. NOT YET MEASURED with them in scope.

SCOPE GROWTH (xlsx pivots): xlsxPivots.js joined `mutate` with its unit test. Same silent failure as the serializers: a cache record pointing at the wrong item changes a number Excel then sums, and the file still opens. Its XML is StringLiteral territory and so unmutated here; the tests decode the cache back into rows instead. NOT YET MEASURED with it in scope.

SCOPE GROWTH (Entitlement Pivot attributes, owners and context blocks): attributeColumns.js, lib/resourceOwners.js, contextDetails.js and contexts/resourceMemberFacts.js (the same owner resolution behind the context page member list) joined the mutate list with their unit tests. Same silent shape: a cap that keeps the wrong keys, an owner fallback that wins over the link, or a suggestion shown beside an Accountable all render a plausible workbook. Their SQL is only string-asserted here; contract-tests/applicationAccessReview.contract.test.js runs it. NOT YET MEASURED with them in scope.

SCOPE GROWTH (unit report): the unit-members template, its reads (unitMembers.js), and the unit-contexts lookup with the contextLookup factory it shares with resource-contexts joined `mutate` with their unit tests; contract-tests/unitMembers.contract.test.js runs the SQL. Its organisational-claim columns (unitClaims.js: the People overview's status, role and source per row, and the people the list does not list) joined with their unit test. NOT YET MEASURED. high-risk application permissions): the template, its shortlist and key helpers (appPermissionRisk.js) and the application-permissions lookup joined `mutate` with their unit tests. Same silent shape: a shortlist matched on the value alone, or a key that drops the API, lists a third-party role as Microsoft Graph access and the table still renders. NOT YET MEASURED with them in scope.

SCOPE GROWTH (risky applications): the score rules (appRiskRules.js), the permission tier that joins the two permission lists (appRiskPermissions.js), the fact folding (appRiskData.js) and the template joined `mutate` with their unit tests. Same silent shape, sharper: a rule on the wrong side of its threshold, or a tier that trusts a permission name on an unknown API, changes a score an analyst acts on and every row still renders. NOT YET MEASURED with them in scope.

SCOPE GROWTH (row scope for context owners over MCP): nlreports/scope.js joined `mutate` with scope.test.js, compile.scope.test.js and references.scope.test.js in the vitest include list. Its failure is the worst silent kind in this config: a predicate on the wrong column, or a table that falls through unscoped, hands an owner data outside their contexts and every answer still looks right. The SQL itself is run against PostgreSQL by contract-tests/authzSecurity.integration.test.js, which also kills hand-applied mutants of compile.js and references.js scoping. NOT YET MEASURED with it in scope.

SPLIT (Nov 2026, #1548): src/nlreports/** and routes/nlReports.js moved to stryker.nlreports.config.json. With them this scope was 13,638 mutants and could not finish inside the weekly job's 60 minutes; the workflow's rule is to split a scope that approaches the limit, not to raise it. Each half now pays only for its own tests on the static mutants, which cost a full run of the include list each.

## UI reports (`app/ui/stryker.reports.config.json`) {#ui-reports}

SCOPE GROWTH (#1222): the report notices and parameter helpers, the schema-driven parameter form the report tab now renders (SchemaConfigForm.jsx, shared with the plugins page) and the user-detail activity section joined `mutate` when they landed, each with its own test in the vitest include list. Not yet measured with them in scope.

SCOPE GROWTH (report paging): Pagination.jsx joined `mutate` when the list renderer started paging. It was accessPackages/AccessPackagesPagination.jsx, untested and grandfathered; moving it to components/ for the second caller is what made it reachable from a test, and ListReportRenderer.mount.test.jsx now drives Prev/Next, the short last page and the single-page case. NOT YET MEASURED with it in scope.

SCOPE GROWTH (entity lookup): EntityLookup.jsx joined `mutate` with its mount test. Its failure mode is the silent kind this config exists for — a control that emitted the LABEL instead of the id would look identical on screen and quietly reintroduce the ambiguity the picker was built to remove, and one that ignored the servers echoed term would draw results for a term the user has already typed past. NOT YET MEASURED with it in scope.
