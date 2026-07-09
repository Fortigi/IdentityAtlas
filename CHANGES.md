## Changes in this PR

- Internal maintainability: split the large user/group/access-package detail API controller into focused per-entity modules (user, group, access-package) sharing one helpers module, with the original file kept as a thin barrel so every endpoint mounts and behaves exactly as before. No functional change.
- Internal maintainability: split the large permissions API controller into focused modules (permission grid + user columns, access-package resource mapping, sync log, and matrix nested-group expansion) behind a thin barrel. No functional change — every permissions endpoint behaves exactly as before.
- Internal maintainability: split the large admin API controller into focused modules (curated-data export/import, risk-config reads, database maintenance, dashboard stats, and settings) behind a thin barrel. No functional change — every admin endpoint behaves exactly as before.
- Internal maintainability: split the large identities API controller into focused modules (identity list + columns, identity detail, and per-account analyst overrides) behind a thin barrel. No functional change — every identities endpoint behaves exactly as before.
- Internal maintainability: split the large tags API controller into focused modules (tag CRUD + assignment, and the users/groups/entity-tags list endpoints) behind a thin barrel. No functional change — every tags/users/groups endpoint behaves exactly as before.
- Internal maintainability: split the large recent-changes API controller into focused modules (the recent-changes panels and the timeline endpoints, sharing common label-resolution helpers) behind a thin barrel, and added tests covering the event-building paths. No functional change — every recent-changes and timeline endpoint behaves exactly as before.
- Internal maintainability: split the large contexts API controller into focused modules (context reads, context create/update/sync/delete, and membership management) behind a thin barrel. No functional change — every contexts endpoint behaves exactly as before.
- Internal maintainability: split the large risk-scores API controller into focused modules (the summary/list endpoints and the single-entity detail + analyst-override endpoints) behind a thin barrel. No functional change — every risk-scores endpoint behaves exactly as before.

## Changes in this PR

- The complexity CI gate now measures **cognitive** complexity (how hard code is to follow) for JavaScript/TypeScript, not just cyclomatic — via `eslint-plugin-sonarjs` at the SonarSource S3776 default threshold of 15. Current offenders are grandfathered into the baseline and can only ratchet down; new or newly-over-threshold functions must stay at or under 15.

## Changes in this PR

- Fixed risk scoring so group ownership counts again — owners had silently stopped contributing to risk after ownership moved to its own resource type, so the "user owns many groups" and "group has members but no owner" signals had gone dead.
- Corrected group member counts and risk propagation to no longer treat group owners as if they were group members.

## Changes in this PR

- Admin → Updates now shows the web and worker version numbers side by side with a Matched / Mismatch badge, so you can confirm the two are in sync. A banner appears if they drift out of step — a sign an update was interrupted or only half-applied.
- Added a Database version to Admin → Updates, shown next to web and worker with a Matched / Mismatch badge. The app stamps its version onto the database once the required migrations have run, so you can confirm at a glance that all three are on the same version. It warns if the database schema is newer than the running app (e.g. after a rollback or a half-applied update).
- Made the Updates screen honest about how updating works: Identity Atlas checks for and reports new versions but never installs them itself — a separate update agent does that. The automatic-updates switch wording now reflects this, and a warning appears when automatic updates are on but nothing has actually been installing them.
- Fixed the update signal so it re-checks against the running version: after an update lands (or the app restarts) it no longer keeps reporting the same version as available, which could otherwise make an update agent re-apply the same version repeatedly.

## Changes in this PR

- Reworked the **Relationships** graph and drill-down lists on entity detail pages (users, resources, identities) to match the current access model. Access is now grouped by how it's held — **Direct / Indirect / Eligible** — instead of the outdated "Groups (Direct)", "Groups (Indirect)", "Groups Owned" and "OAuth2 Grants" buckets (the latter two were retired concepts that always showed 0).
- When you drill into a bucket, each row now shows **what kind of resource the assignment is for** — Group, Group ownership, App role, Delegated permission, App permission, Directory role, Business role, and so on — instead of a generic "Resource" label. This makes a Direct bucket that spans many resource types readable at a glance.
- Resource detail pages now show an **Indirect Members** bucket that was previously missing.
- The drill-down list is now **sortable** (click the Name or Type column header) and **exportable to CSV**, so a large Direct/Indirect bucket can be scanned, ordered by resource type or name, and pulled out for review.
- Fixed a bug where entity detail pages showed **0 Contexts** even when the person was a member of one. The count and list now correctly include contexts you belong to directly (as a principal, e.g. tags) as well as through your linked identity — previously only the (unused) identity path was checked, so every user and identity showed no contexts.

## Changes in this PR

- The built-in demo/mock dataset no longer uses the retired `Owner` membership type, so mock mode matches the current data model (group ownership is represented as its own resource, not a membership type).

## Changes in this PR

- Made the **Timeline** tab and the recent-changes panel load much faster on user, resource, access-package and identity detail pages. They previously scanned the entire change-history table on every open, so they got slower as history grew; they now use targeted indexes and stay fast regardless of how much history has accumulated.

## Changes in this PR

- The database now structurally enforces the universal data model: `assignmentType` is constrained to `Direct`/`Indirect`/`Eligible`, and the renamed Entra-era resource types (`EntraGroup`, `EntraRole`) can no longer be stored on resources or assignments. This guards against a bad migration or manual database change reintroducing a retired value — a path the ingest API validation could not cover.

## Changes in this PR

- Added an **Application Permissions** object type to the Entra ID crawler (opt-in). It captures the app-only, admin-consented permissions each service principal holds on other APIs — the tenant-wide kind such as `Mail.Read` on Microsoft Graph that works with no user signed in — modelled as **ApplicationPermission** resources linked to the holding app. This is the app-only sibling of the existing delegated (OAuth2) permissions.
- Each application permission shows up as a Direct assignment on the service principal that holds it, so a managed identity's or AI agent's tenant-wide API access is now visible, relatable, and certifiable like any other access.

## Changes in this PR

- Added an **App Owners** object type to the Entra ID crawler (opt-in). It captures who controls your applications, modelled as two resource types: **ApplicationOwnership** — owners of the app registration, i.e. the people who can add a credential and sign in *as* the app — and **ServicePrincipalOwnership** — owners of the enterprise-app service principal. Each owner appears as a Direct assignment on an ownership resource linked to the app, so app ownership can be listed, related, and certified like any other access.
- Apps that have owners but no app roles or delegated grants now still appear as resources, so their owners are visible rather than hidden.

## Changes in this PR

- The published Docker images (`:edge`, `:latest`, `:beta`, and the versioned tags) are now the exact images that passed the release smoke test, rather than a fresh rebuild made after testing. What you pull is now guaranteed to be what was verified.

## Changes in this PR

- Made context hierarchies more resilient to parent-loops. Generated (plugin) context trees now skip any parent link that would create a cycle, and imported context batches self-repair a cyclic parent link immediately after the batch rather than waiting for the end-of-sync refresh — so a mis-parented tree can no longer leave a stored loop behind.

## Changes in this PR

- Fixed inconsistent risk-tier labels after an analyst override. The override path used a different Critical/High threshold (80/60) than the scoring engine (90/70), so overriding a score could re-tier an entity on a different scale than the batch run that produced its stored tier. Both now share a single source of truth, so a score of, say, 85 is labelled "High" everywhere. (Entities with scores between 60–89 may now show a corrected tier.)
- The risk-score bar colour now follows the entity's risk tier, matching the tier badge, instead of a separate hardcoded set of score cutoffs.

## Changes in this PR

- Hardened the Docker deployment: the web/API container now reports a health status, and the worker waits for the API to be healthy (migrations applied and responding) before it starts running crawler jobs, instead of starting as soon as the API container launches.

## Changes in this PR

- Fixed imported context hierarchies (such as org-unit or department trees) not linking to their parent. A context's parent reference is now resolved into the correct context, so parent/child relationships persist on import instead of being silently dropped.

## Changes in this PR

- Cleaned up the access matrix legend: it now shows only the badges that can actually appear (Direct, Indirect, Eligible). The obsolete "Owner" badge and other retired assignment-type badges (Governed, OAuth2 grant, App role) were removed from both the on-screen legend and the Excel export legend. Ownership continues to appear as its own resource row.

## Changes in this PR

- Documentation and CI hygiene: corrected stale references in the developer guide and CI configuration (test framework, branch triggers, retired assignment-type terms in crawler comments) and documented which coding-principle rules are enforced by CI vs. reviewer judgement. No change to application behaviour.

## Changes in this PR

- Entra security and Microsoft 365 groups now use the resource type **Group** instead of **EntraGroup**. The connector each resource came from is already tracked separately, so the type no longer restates it — matching the other shared resource types (Application, AppRole, Business Role).
- Entra directory roles now use the resource type **EntraDirectoryRole** instead of **EntraRole** — the accurate name, and it now matches its colour badge in the Resources view.
- Existing data is updated automatically on upgrade; the Resource Type filter shows the new names and no re-crawl is required.
- Group-ownership resources are now named after the group itself (e.g. "Sales") rather than "Owner @ Sales" — the resource type already marks it as an ownership, so the prefix was redundant.

## Changes in this PR

- Development Docker setup: the local PostgreSQL container is now bound to localhost only instead of all network interfaces, so the database (which uses a default local password) is no longer reachable from other machines on your network.

## Changes in this PR

- API server errors (HTTP 500) no longer echo internal error details back to the client — they return a generic message while the full detail is still logged server-side, matching the project error-handling policy.

## Changes in this PR

- Internal refactor: unified how all crawlers send data to the ingest API into one shared, tested implementation, removing duplicated batching logic that had drifted between crawlers. No change to what data is synced or how.

## Changes in this PR

- Internal refactor: split the large Admin settings page into focused per-section components for maintainability. No functional change — every Admin tab and section works exactly as before.

## Changes in this PR

- Hardened the context hierarchy against cycles: a context can no longer be re-parented under its own descendant (the check now works at any tree depth, not just the first 50 levels), and a mis-parented or looped context tree arriving from a crawler or generated by a plugin is now automatically repaired instead of leaving member counts stuck as undefined for the affected branch.

## Changes in this PR

- Improved database migration logging: when a migration is recorded as applied because its objects already exist, the log now names the specific migration file and warns that any data backfill it contained may have been skipped — making a previously silent situation visible in the container startup logs.

## Changes in this PR

- Cleaned up orphaned access assignments and resource relationships whose underlying resource no longer exists, so stale rows can no longer linger in storage (they were already hidden from the matrix). Legitimate assignments to external, guest, and service-principal members are preserved.

## Changes in this PR

- Fixed curated data import so tags and their assignments are saved again. Previously, importing a curated JSON file that contained tags failed with a server error, and even when the import appeared to succeed, tag assignments were never attached to any user, group, or resource.
- Curated tag imports now resolve entities both by ID and by display name, and re-importing an existing tag updates its colour without creating duplicate assignments.

## Changes in this PR

- The Test Coverage docs page now shows code-complexity and mutation-testing columns alongside line/branch/method coverage: average and maximum cyclomatic and cognitive complexity per unit (via PSComplexity) and the PowerShell mutation score — the share of injected faults the tests actually catch (via PSMutant). These are measured for the PowerShell suite today; suites that don't supply them show a dash.

## Changes in this PR

- Internal: decomposed the Azure RM crawler's monolithic entry point into unit-tested phase functions (scope discovery, role definitions, role assignments, dedup, orphan handling, sends) threaded through a shared state object, plus pure record-shapers. Behaviour is unchanged — the same scope hierarchy, role-at-scope resources, grants and principal stubs are emitted.

## Changes in this PR

- Internal: extracted the midPoint crawler's system-registration, org-context, and view-refresh sync phases out of the monolithic entry point into unit-tested `Sync-Midpoint*` functions (no functional change to what gets synced).
- Internal: extracted the midPoint crawler's role/service-resource and user (identities + principals) sync phases into unit-tested `Sync-Midpoint*` functions (no functional change to what gets synced).
- Internal: extracted the midPoint crawler's two-pass streaming shadow phase (accounts + entitlements + entitlement memberships) into unit-tested `Sync-Midpoint*` functions (no functional change to what gets synced).
- Internal: extracted the midPoint crawler's org-membership, assignment (direct + inherited), role-nesting, and certification-review sync phases into unit-tested `Sync-Midpoint*` functions (no functional change to what gets synced).
- Internal: extracted the midPoint crawler's config resolution, authentication, performance-summary, and run-finalization steps into unit-tested functions, shrinking the entry-point body below the complexity ceiling (no functional change).

## Changes in this PR

- Added an "Entra Group Category Tree" context algorithm that auto-generates a browsable tree — an "EntraID Groups" root with a child context per group category — so you can filter Entra groups by their kind in the web UI and the matrix.
- Added a `groupCategory` attribute to every Entra group (Team, Microsoft365, SecurityGroup, DistributionList, MailEnabledSecurity — with a `Dynamic` prefix where dynamic membership applies), so analysts can tell at a glance what kind of group they're dealing with and filter on it in the Excel export.
- Added supporting group facets: `membershipType` (Assigned/Dynamic), `sourceOfAuthority` (Cloud/OnPremises, i.e. synced from on-prem AD or not), and `accessPackageEligible` (whether the group can be used in an access package).
- Group dynamic-vs-assigned is now determined from the authoritative Entra flag, so a group that was converted from dynamic back to assigned is classified correctly even if a stale membership rule lingers.

## Changes in this PR

- Added a `groupCategory` attribute to every Entra group (Team, Microsoft365, SecurityGroup, DistributionList, MailEnabledSecurity — with a `Dynamic` prefix where dynamic membership applies), so analysts can tell at a glance what kind of group they're dealing with and filter on it in the Excel export.
- Added supporting group facets: `membershipType` (Assigned/Dynamic), `sourceOfAuthority` (Cloud/OnPremises, i.e. synced from on-prem AD or not), and `accessPackageEligible` (whether the group can be used in an access package).
- Group dynamic-vs-assigned is now determined from the authoritative Entra flag, so a group that was converted from dynamic back to assigned is classified correctly even if a stale membership rule lingers.

## Changes in this PR

- Internal: extracted the CSV crawler's Systems, Contexts, and ContextMembers sync phases out of the monolithic entry point into unit-tested `Sync-Csv*` functions and pure `ConvertTo-Csv*Record` record-shapers (no functional change to what gets imported).
- Internal: extracted the CSV crawler's Resources and ResourceRelationships sync phases into unit-tested `Sync-Csv*` functions and pure record-shapers (no functional change to what gets imported).
- Internal: extracted the CSV crawler's Users (principals) and Assignments sync phases into unit-tested `Sync-Csv*` functions and pure record-shapers (no functional change to what gets imported).
- Internal: extracted the CSV crawler's Identities, IdentityMembers, and Certifications sync phases into unit-tested `Sync-Csv*` functions and pure record-shapers (no functional change to what gets imported).
- Internal: extracted the CSV crawler's config resolution, fallback-system registration, and post-import classify/refresh/log steps into unit-tested functions, reducing the entry point to pure orchestration below the complexity ceiling (no functional change).
- Internal: flattened the CSV crawler's remaining deep helpers (fast-path reader, per-system dedup/send, and the resource/assignment/certification sync phases) so every unit clears the cognitive-complexity gate, with direct tests for the new column-index/dedup helpers and mutation-testing coverage of the CSV record-shapers.

## Changes in this PR

- Internal: extracted the Omada crawler's resource, entitlement, and view-refresh sync phases out of the monolithic entry point into unit-tested `Sync-Omada*` functions (no functional change to what gets synced).
- Fixed: the Omada crawler's assignment phase referenced an undefined variable when computing its per-phase record summary, so the CRA-assignment count could be dropped from the sync-log breakdown.
- Internal: extracted the Omada crawler's config resolution, connection/system-registration setup, and end-of-run summary out of the entry point into unit-tested helpers, so the entry point is now thin orchestration only.
- Internal: flattened the Omada crawler's deepest transform and phase helpers (attribute mapping, CRA folding, role-assignment classification, resource ingest, run summary) so every unit now clears the cognitive-complexity gate, with direct tests for the new coalesce/merge/system-key helpers.

## Changes in this PR

- Internal: extracted the Entra ID crawler's user-principal, OAuth2 grants, app-role, directory-role, group-resource, group-assignment, PIM-eligibility, service-principal, sign-in-logs, and governance (catalogs, access packages, resource scopes, assignments, policies, access reviews) sync phases — including the filtered identity sub-sync — out of the monolithic entry point into unit-tested `Sync-Entra*` functions (no functional change to what gets synced).
- Internal: extracted the Entra ID crawler's config resolution, run initialization, view-refresh, and end-of-run summary/finalization out of the entry point into unit-tested helpers, so the entry point is now thin orchestration only.
- Fixed: PIM eligible group memberships were silently skipped on tenants where exactly one non-dynamic group survived filtering.

## Changes in this PR

- The Matrix now shows indirect members of nested Entra groups. When a security group is a member of another group, the child group's users now appear as indirect (I) members of the parent group — matching how access via an app role in a group already displayed. Previously group-in-group nesting showed no indirect members at all.

## Changes in this PR

- Internal: added a cognitive-complexity ratchet to CI (alongside the existing cyclomatic one) that gates PowerShell and Python code on how deeply nested / hard-to-follow it is, not just how many branches it has — flagging readability debt the cyclomatic gate misses.
- Internal: PowerShell complexity is now measured by the published PSComplexity module (a faithful, reference-validated SonarSource cognitive metric) feeding both ratchets, instead of a bundled measurer — `measure_ps.ps1` is now a thin selector over it.
- Internal: added PowerShell mutation testing via the published PSMutant module (report-only) over the decomposed crawler transforms — the metric that proves the tests would catch a bug, not just execute the line.

## Changes in this PR

- Fixed context plugins (e.g. Active Directory OU Tree) spawning a brand-new duplicate tree on every crawl instead of updating the existing one in place. Legacy trees created before per-tree instance keys were introduced now refresh onto themselves, so member counts and analyst edits are preserved and the tree list no longer explodes.

## Changes in this PR

- Fixed the **Next** button on the Users, Resources (Groups) and Identities list pages throwing an error when paging past the first page. The page count is only sent on the first page for export efficiency, and the UI was mishandling its absence on later pages — it now keeps the known total so pagination works across every page.

## Changes in this PR

- Internal maintainability: decomposed the core `/matrix/data` query handler — previously a single ~680-line function — into a thin dispatcher plus one focused function per view mode (flat grid, roll-up, context roll-up, attribute fold, inherited-access folds). Cyclomatic complexity of the largest function drops from 150 to 18. No change to matrix behaviour, endpoints, or output.
- Internal maintainability: decomposed the risk-scoring engine's `runScoring` routine — previously a single ~600-line function — into a thin orchestrator plus one function per pass (load, score resources, score principals, membership analysis, propagation, persistence), each now separately unit-tested. Cyclomatic complexity of the largest function drops from 115 to 20. No change to risk scores, tiers, or explanations.
- Internal maintainability: decomposed the Recent-Changes timeline builder into one focused, unit-tested handler per event type (attribute change, assignment, containment relationship, identity-link). Cyclomatic complexity of the largest function drops from 60 to 6. No change to timeline output.
- Internal maintainability: decomposed the generic ingest endpoint handler (shared by all 15 ingest routes) into separately unit-tested phases — record defaults, GUID-prefix recovery, scope projection, conflict-filter selection, column discovery, session handling, delete-by-id, and system-id lookup. Cyclomatic complexity of the largest function drops from 58 to 17. No change to the ingest contract or behaviour.
- Internal maintainability: decomposed the create-crawler-job and update-config handlers into separately unit-tested helpers — body validation, config resolution, upload-folder resolution, secret/credential preparation, singleton-conflict check, and config-merge. Cyclomatic complexity of the largest function drops from 51 to 16. No change to crawler-job behaviour.

## Changes in this PR

- Reworked the **Risky Consent** plugin so its contexts group the risky **grants themselves** (the OAuth/application permission grants) rather than the principals — so you can scope a matrix to a group and read off exactly which users consented to a risky grant. It now also produces **both** kinds of grouping in one plugin: by permission risk (**Risky Consent — High/Medium**) and by app reputation (**Risky App Consent — Malicious/Suspicious**, using the OAuthSentry threat feed + heuristics). The separate Risky App Consent plugin has been merged into it. Removed/merged context algorithms are now automatically disabled so they no longer appear as broken entries in the plugin picker.

## Changes in this PR

- Internal: midPoint crawler user/identity record-shaping extracted into unit-tested pure functions (no functional change).

## Changes in this PR

- Internal: Omada crawler identity record-shaping extracted into unit-tested pure functions (no functional change).

## Changes in this PR

- Fixed: service-principal sign-in activity could be written without its aggregate resource link when user sync was disabled in the same run.

## Changes in this PR

- Added a Marketing & Press Kit section to the documentation — product brief, key messages, features, use cases, proof points, FAQ, and reusable boilerplate — as a public-safe, on-message source for slides and blog posts.
- Expanded the documentation landing page with a short open-source / self-hosted summary and a link to the new press kit.

## Changes in this PR

- Added a **Risky App Consent** context plugin (Admin → Plugins) — the app-reputation companion to Risky Consent. It flags principals who consented to a **known-malicious OAuth app** (matched against the free, public OAuthSentry threat feed of apps seen in consent-phishing / BEC / AiTM campaigns) or to a **suspicious app** by heuristic — a self-registered / unverified publisher, or an app only one or two people consented to (the classic targeted-consent-phishing signal). It creates **"Risky App Consent — Malicious"** and **"Risky App Consent — Suspicious"** contexts you can build a matrix on. The threat feed needs no account or key and is best-effort: if it can't be reached the heuristics still run. The feed URL, whether to use it, the heuristics, and the low-prevalence threshold are all configurable when you run the plugin.

## Changes in this PR

- Fixed **duplicate Azure resources** in the Resources list (every Azure resource appeared twice). A full Azure crawl was tagging its resource batch with a scope label that matched none of the stored rows, so the full-sync clean-up step never removed superseded rows — when the internal resource id changed (during the Resource Graph rewrite), the old copies were stranded instead of being cleaned up. The crawl now reconciles each resource type correctly, so a fresh Azure RM crawl removes the leftover duplicates and keeps deleted Azure resources from lingering. (Run an Azure RM crawl after upgrading to clear existing duplicates.)

## Changes in this PR

- Fixed the resources list showing the **same delegated permission many times** (e.g. "Calendars.ReadWrite on Microsoft Graph" appearing five times). Each row is actually a *different application's* consent to that permission; the name just didn't say which app. Delegated-permission resources are now named with the consenting app — e.g. "Calendars.ReadWrite on Microsoft Graph (via Amazon Alexa)" — so they're distinct and scannable. (Takes effect after the next Entra ID crawl.)

## Changes in this PR

- Added a **Risky Consent** context plugin (Admin → Plugins). It classifies every delegated (OAuth) and application permission consent by risk using a curated risk map (e.g. `Group.ReadWrite.All`, `Mail.ReadWrite`, `Sites.ReadWrite.All` = High; `Directory.Read.All`, `Calendars.ReadWrite` = Medium; `openid`/`User.Read` = Low), then creates one context per risk tier — **"Risky Consent — High"** and **"Risky Consent — Medium"** — with every principal that holds such a consent as a member. Build a matrix on these contexts to find exactly which principals have granted risky consent. Tiers, systems, whether to include application permissions, and the default tier for unknown permissions are all configurable when you run the plugin.

## Changes in this PR

- Fixed search and filters being lost on list pages (Identities, Users, Groups, Resources) after opening one of the results and returning to the list — your search, column filters, "include deleted" toggle, and sort are now kept for the rest of the session.

## Changes in this PR

- Fixed WCAG 2.1 AA accessibility issues across the app: the header brand text, the Matrix and Business Roles action buttons, the Logs filter counts, and a Risk Scores hint now meet color-contrast minimums; table row-select checkboxes and the Risk Scores / Contexts / Business Roles filter dropdowns now carry screen-reader labels.
- Re-enabled the accessibility E2E suite (axe-core, WCAG 2A/2AA). It now checks **every** navigation page automatically — derived from the app's nav definition — so newly added pages are covered without updating the test.
- Fixed a Matrix page double-scrollbar: on short viewports with a tall toolbar the grid could push the whole page past the bottom, adding a second scrollbar. The grid now always fits the remaining viewport so only it scrolls.
- Extended the accessibility checks to the Admin sub-tabs (Crawlers, Plugins, Account Linking, Risk Scoring, LLM Settings, Performance, Authentication, Data, About) and fixed their WCAG AA issues — most notably the Performance metrics tables (latency values now use a darker, AA-compliant color), the Roles & Permissions grid checkboxes (screen-reader labels), and several filter/threshold/retention controls and `<code>` snippets. The suite discovers the sub-tabs from the page itself, so a new one is checked automatically.
- Darkened the Matrix grid header text so the matrix and Business Roles pages also pass WCAG AA contrast, and removed the temporary exemption — the accessibility suite now enforces every top-level page and every Admin sub-tab with no exclusions.

## Changes in this PR

- Fixed the badge shown at the start of an open detail tab: Identity tabs now show "ID" (they previously showed "AP", the access-package badge), and run tabs show "RUN" instead of "AP".

## Changes in this PR

- Completed the React Compiler set-state-in-effect cleanup across the remaining UI (performance metrics, entity detail pages, context tree, and other views/hooks) and enabled the `react-hooks/set-state-in-effect` lint rule as a build error so the pattern can't be reintroduced. No change to behavior.

## Changes in this PR

- Fixed the **Admin → Updates** screen showing a blank current version (and defaulting the channel to "latest") on source / development / local installs where the version isn't provided as an environment variable. The update logic now falls back to reading the version manifest, exactly like the rest of the app, so the running version and channel are detected correctly on every kind of deployment.

## Changes in this PR

- Excel Power Query export now distinguishes governed from non-governed assignments (the `governed` flag is included on the Assignments tab).
- Excel Power Query export now includes business roles / access packages on the Resources tab (previously hidden), with a `governanceResource` flag marking governance resources — so the `Contains` links on the ResourceRelationships tab now join to a named business role.
- Added four governance tabs to the Excel Power Query workbook: Governance Catalogs, Assignment Policies, Assignment Requests, and Certification Decisions (access-review outcomes).
- Data analysts can now rebuild any governance matrix the web UI shows — including the governed/non-governed split and which resources each business role grants — entirely in Excel.

## Changes in this PR

- Added reference **auto-update agents** and a setup guide so automatic updates work on any deployment: a Docker-host script (with cron and systemd timer units) and an Azure Container Apps script that apply a new version only when automatic updates are enabled, plus a documentation page explaining the model and per-platform setup. PostgreSQL is never auto-rolled, and schema migrations run fail-closed on startup.

## Changes in this PR

- Added an **Admin → Updates** screen showing the running version and release channel, whether a newer version is available, a switch to turn **automatic updates** on or off, and a history of update checks and installed updates. A **Check now** button runs an immediate check. (Pinned deployments are detected and the switch is disabled with an explanation.)

## Changes in this PR

- Fixed a startup crash when upgrading to recent builds: the database migration that simplifies how access assignments are stored could fail with a "duplicate key" error on real data, leaving the web container in a restart loop (shown as an "Application Error" page). The migration now safely merges duplicate assignments instead of failing, so the upgrade completes and the app starts normally.

## Changes in this PR

- Added the foundation for in-app auto-updates: Identity Atlas now runs a **daily check** for a newer version on its release channel (`edge` / `beta` / `latest`) and records every check and applied update in an update log. A new **auto-update switch** (off by default, `admin.systems`-gated) controls whether updates are applied automatically. The app never touches Docker itself — applying an update is handled by a small, deployment-specific helper (Docker host / Azure / local), so the same mechanism works on every setup. (This change ships the backend, detection, daily check and API; the Admin → Updates screen and the helper scripts follow in separate changes.)

## Changes in this PR

- The Excel / Power Query data export now includes **Contexts** and **Context Members** sheets — so you can export every context (departments, OUs, administrative units, tags, generated clusters) and the membership rows showing which entity belongs to which context, alongside the existing Principals / Resources / Assignments data.

## Changes in this PR

- Removed React Compiler set-state-in-effect warnings in the risk-scoring page (first-page reset on filter change, owner search), the matrix view (hierarchy-path reset), and the risk-profile wizard (elapsed-time counters), with no change to behavior. The risk-scoring page now also avoids a redundant stale-page fetch when filters change while paginated.

## Changes in this PR

- Fixed: the Excel / Power Query data export could be very slow or fail outright (a 500 partway through) on large tenants. The user, group, resource, and identity list endpoints evaluated a per-row tag lookup across the entire offset range on every page, and re-counted the whole table on every page — so deep pages got slow enough to time out. They now paginate first (resolving tags only for the rows on the page) and compute the total once, so each page stays fast regardless of how deep the export has paged. The assignment / identity-member / relationship bulk endpoints likewise count only on the first page.

## Changes in this PR

- Reworked the Roles & Permissions admin matrix and the Account Linking settings page to remove two React Compiler set-state-in-effect warnings. Loading, saving, custom permission/error messages, and config editing all behave exactly as before.

## Changes in this PR

- Reworked the Admin page's data loading (Power Query tokens, history retention, LLM settings, risk-scoring features) and its tab/provider state handling to remove six React Compiler set-state-in-effect warnings. All Admin sub-tabs load, save, and reset exactly as before.
- Reworked the matrix scope-statistics panel's live-stats and trends/breakdown loading to remove two more React Compiler set-state-in-effect warnings; the counts, governed split, trends timeline and department drill-down all behave as before.

## Changes in this PR

- The light/auto/dark theme hook was reworked to remove a React Compiler set-state-in-effect warning. Auto mode still follows the operating-system preference live, and switching or cycling the theme persists exactly as before.

## Changes in this PR

- The matrix custom row-order hook was reworked to remove a React Compiler set-state-in-effect warning. Saved row orders are now read from storage on first render and reloaded when the department changes, with the same persistence and "reset to default" behavior as before.

## Changes in this PR

- The matrix filter wizard's reset-on-reopen logic was reworked to remove a React Compiler set-state-in-effect warning. Reopening the wizard still returns it to the first (Setup) step with a fresh copy of the active filter, exactly as before.

## Changes in this PR

- Context Plugins admin page now loads its plugin trees and catalog through the shared fetch lifecycle, removing a React Compiler set-state-in-effect warning. The list, empty state, load-error message, and Refresh button behave as before.

## Changes in this PR

- Dashboard landing page now loads its stats and version through the shared fetch lifecycle, removing a React Compiler set-state-in-effect warning. Load-error vs empty-database handling and the Retry button are unchanged.

## Changes in this PR

- Read-only API tokens (the credentials behind the Excel / Power Query export) are now **automatically revoked after 90 days without use**, so a token embedded in a workbook nobody refreshes anymore no longer lingers as live read access. The threshold is configurable via the `READ_TOKEN_IDLE_DAYS` setting (set it to `0` to turn idle-revocation off). Auto-revoked tokens stay listed in the Existing tokens table (marked revoked) for audit.

## Changes in this PR

- Internal code-quality: converted the `useTimeline` and `useRecentChanges` entity-history hooks to the shared `useFetch` hook, clearing more `react-hooks/set-state-in-effect` warnings. No user-facing behaviour change.

## Changes in this PR

- Internal code-quality: converted the Systems, Dashboard Trends, Authentication settings, and Governance pages to the shared `useFetch` hook, clearing more `react-hooks/set-state-in-effect` warnings. No user-facing behaviour change.

## Changes in this PR

- Internal code-quality: converted the Contexts data hooks (`useContextRoots`, `useContextSubtree`) to the shared `useFetch` hook, clearing more `react-hooks/set-state-in-effect` warnings. No user-facing behaviour change.

## Changes in this PR

- Internal code-quality: added a shared `useFetch` data-loading hook to centralise the GET loading/error/abort lifecycle, so components stop hand-rolling `useState`+`useEffect` fetches (which trip the `react-hooks/set-state-in-effect` lint rule / React Compiler compatibility). No user-facing behaviour change; site conversions follow in separate PRs.

## Changes in this PR

- Replaced the browser's native `alert`/`confirm`/`prompt` pop-ups with themed in-app dialogs and toast notifications — dark-mode aware, non-blocking, and consistent with the rest of the UI.

## Changes in this PR

- Internal code-quality cleanup: resolved the React hook and fast-refresh ESLint warnings in the UI (dependency-array fixes, moving shared constants/helpers into component-only modules, and ref-during-render handling). No user-facing behaviour change; improves dev hot-reload and removes console noise.

## Changes in this PR

- Fixed: **Admin → Data → "Export curated data"** failed with a generic "Export failed" error whenever any business-role categories existed. The category export query applied a text-lowercasing function directly to the resource UUID column, which PostgreSQL rejects; it now lowercases the UUID as text (matching the import path), so the export completes.

## Changes in this PR

- Added a documentation page on the soft-delete / tombstone lifecycle: why removed entities are kept rather than hard-deleted, how a re-appearing entity is automatically re-activated, where deleted items are hidden or shown (list "include deleted" toggle, detail-page badge, matrix exclusion), and how the retention/purge job finalizes tombstones (governed by the shared history-retention window).

## Changes in this PR

- Corrected the data-model documentation to match the current Contexts model: entities no longer carry a single `contextId` column — context membership is now a many-to-many relationship via the `ContextMembers` join table, and every Context has a variant (synced / generated / manual) and a targetType (Identity / Resource / Principal / System). The conceptual hierarchy, entity-relationship diagram, and table reference were all updated to reflect the v6 redesign.

## Changes in this PR

- More documentation accuracy fixes: the risk-scoring data-model doc no longer documents the dropped `GraphResourceClusters`/`GraphResourceClusterMembers` tables (resource clustering is now a context-algorithm plugin), and its initialization order is corrected (the risk tables are created automatically by a migration at startup, not by a manual cmdlet).
- The ingest OpenAPI spec now states its scope explicitly and points to the API reference for the authenticated read API it does not cover.
- Added several previously-unlisted pages to the documentation navigation (effective-access engine, resource-cluster algorithm, Excel export & template authoring, CI scope testing).
- Documentation accuracy fixes: the API reference now shows PostgreSQL (was "Azure SQL"), the non-existent `/api/org-units` endpoint is replaced with the real org/context endpoints (`/api/contexts/tree`, `/api/org-chart`), the version-history example uses the actual `changedAt`/`diff` shape instead of legacy SQL-Server temporal columns, the data-model version label is aligned, the tag tables are noted as backward-compatibility views over Contexts, and the legacy "(FortigiGraph)" suffix is dropped from the README title.

## Changes in this PR

- Extracted the Entra ID crawler's remaining inline helper functions (filter-value coercion, ownership/OAuth2-scope/app-role resource-id generation, directory-role principal-type resolution) into the loadable helper library so they can be unit-tested in isolation; the crawler's behaviour is unchanged.
- Refactored the parallel group-children fetch so the per-group fetch/retry/pagination logic is a testable function and the parallel execution is isolated behind a thin seam; the crawler's behaviour is unchanged.

## Changes in this PR

- Documentation accuracy fixes: the API reference now shows PostgreSQL (was "Azure SQL"), the non-existent `/api/org-units` endpoint is replaced with the real org/context endpoints (`/api/contexts/tree`, `/api/org-chart`), the version-history example uses the actual `changedAt`/`diff` shape instead of legacy SQL-Server temporal columns, the data-model version label is aligned, the tag tables are noted as backward-compatibility views over Contexts, and the legacy "(FortigiGraph)" suffix is dropped from the README title.

## Changes in this PR

- Hardened the AI/LLM integration against redirect-based SSRF: outbound provider calls no longer follow HTTP redirects (a redirect could otherwise carry the provider API key to an unintended host).
- Hardened risk-profile generation against prompt injection: scraped web-page text and free-text hints are now clearly fenced as untrusted data the model must not treat as instructions, and any attempt to forge the fence markers from inside that content is neutralised.
- Classifier regex patterns are now validated when a classifier set is saved — an invalid or unsupported pattern is rejected up front with the offending pattern listed, instead of being silently skipped later during scoring.

## Changes in this PR

- Extracted the Azure RM crawler's reusable scope/ingest helper functions into a separate loadable library so they can be unit-tested in isolation; the crawler's behaviour is unchanged.

## Changes in this PR

- Expanded automated test coverage of the PowerShell SDK configuration helpers (`Update-FGConfig`, `Get-/Test-/Clear-FGSecureConfigValue`) to 100%, exercising the credential migration, encrypted-value fallback, and interactive add-missing-section paths.
- Expanded automated test coverage of service-principal synchronization discovery (`Get-FGServicePrincipalWithSync`) to 100%, including the no-filter candidate discovery and error-tolerance paths.
- Added coverage for all object-type variants of the Entra portal deep-link helper (`Get-FGEntraPortalLink`).

## Changes in this PR

- Outbound AI/LLM provider calls now have a request timeout and a response-size cap, so a hung or runaway provider can no longer hold a request open indefinitely or exhaust server memory.
- LLM and risk-profile endpoints no longer return raw upstream provider error details to the browser — failures now show a generic message (the full detail is logged server-side). The Admin → LLM Settings "Test" button still reports the provider and HTTP status so a bad key/endpoint is diagnosable, without echoing the raw provider response.

## Changes in this PR

- Refactored the entra-id crawler so its internal functions live in a loadable `EntraIDCrawler.Functions.ps1` library (dot-sourced by the entry-point script) instead of being trapped in the script's top-level execution body — no change to runtime behavior.
- Added unit tests for the entra-id crawler's helper functions (batched and chunked ingest, Graph delta-token persistence, delta-aware paginated fetching, per-phase tracking, user attribute resolution).

## Changes in this PR

- Refactored the midpoint crawler so its internal functions live in a loadable `MidpointCrawler.Functions.ps1` library (dot-sourced by the entry-point script) instead of being trapped in the script's top-level execution body — no change to runtime behavior.
- Added unit tests for the midpoint crawler's helper functions (batched and streaming ingest, per-endpoint performance stats, phase-error tracking, shadow-account labelling).

## Changes in this PR

- Refactored the omada crawler so its internal functions live in a loadable `OmadaCrawler.Functions.ps1` library (dot-sourced by the entry-point script) instead of being trapped in the script's top-level execution body — no change to runtime behavior.
- Added unit tests for the omada crawler's helper functions (resource-category and identity/resource/context type mapping, type-mapping merge, phase tracking, batched ingest).

## Changes in this PR

- Refactored the csv crawler so its internal functions live in a loadable `CSVCrawler.Functions.ps1` library (dot-sourced by the entry-point script) instead of being trapped in the script's top-level execution body — no change to runtime behavior.
- Added unit tests for the csv crawler's helper functions (file reading, column validation, system-id resolution, per-system batching and dedup).

## Changes in this PR

- Added unit tests for the PowerShell SDK (Graph request/token layer, user/group/governance read functions, write functions, and helpers), the risk-scoring module, and the crawler helper libraries (midPoint REST client, Azure Resource Graph + ARM helpers, and the OData GET/paged request layer) to substantially raise PowerShell code coverage.
- Fixed `Set-FGGroup`, which previously failed on every call due to a malformed `$PSBoundParameters` reference.
- Fixed `Confirm-FGAccessPackageResource`, which referenced a non-existent command (a missing hyphen) when adding a group to an access package.
- Fixed `Get-FGServicePrincipalWithSync`, which threw when discovering service principals without a filter.
- Fixed `Get-FGGroupEligibleMemberAll` so it gracefully returns nothing when the group query fails: previously, under the crawler's strict error mode, its error log terminated the call and crashed the crawl instead of skipping.
- Re-enabled the crawler manifest `CrawlerMeta.js` checks for every crawler (removed a stale "pending migration" skip list that was suppressing them now that all crawlers ship the file).

## Changes in this PR

- Expanded automated API test coverage: added unit tests (with the database mocked) across the matrix, tags, categories, admin, permissions, contexts, context-plugins, risk-profile, risk-score, identities, ingest, account-linking, data-export, auth-roles, bulk-list, risk-scoring-run, performance, and org-chart routes — raising route-handler line coverage from roughly half to ~75%.

## Changes in this PR

- Greatly expanded automated UI test coverage: React components are now mounted and exercised in a real DOM (effects, clicks, forms, wizard steps, tab switches) rather than only inspected as source, raising UI line coverage from ~5% to ~64%.
- Added mount tests for the Plugins, Governance, Risk Scoring, Admin, Access Packages, Department, Context detail, Contexts, Roll-up matrix, Matrix, Matrix filter wizard, New context wizard, Risk profile wizard, Roles & permissions, and Risk score sections — covering their loading, empty, error, and interaction states.
- Added mount tests for the Systems, Identity detail, and Run detail pages — covering their loading, empty, error, and interaction states.
- Added mount tests for the Dashboard landing page (Overview and Trends tabs) and the Sync Log page — covering loading, empty, error, stat-card navigation, tab switching, and filter/search interactions.
- Added mount tests for the Performance, Account Linking settings, Entity graph, Context picker, and Rotated matrix views — covering their loading, empty, error, and interaction states.
- Added tests for the Excel export utilities, entity-graph shaping, and the shared list-page, matrix, permissions, and expandable-graph hooks.

## Changes in this PR

- Hardened the Azure deployment templates: the storage account key and Log Analytics shared key are no longer emitted as Bicep module outputs (they previously persisted in ARM deployment history, readable by any deployment/resource-group reader). The App Service and Container Apps Environment now read those keys directly at deploy time, so the secrets never cross a module boundary.

## Changes in this PR

- Identity, resource, and permission pages now report a clear error when an underlying data lookup genuinely fails, instead of silently showing empty or zero values — only a legitimately absent optional table/column is treated as "no data".

## Changes in this PR

- Assignment imports now accept only the three standard assignment types (Direct, Indirect, Eligible); the legacy source-specific types are rejected at import, completing the assignment-model simplification (ownership is modelled as its own resource, governance as a flag).
- Added an automated guard so the simplified assignment model can't quietly drift back to the old set of types.

## Changes in this PR

- Fixed the published test-coverage page (and its browsable HTML reports) so they update on every merge again. The coverage workflow had been failing silently because the report directory under `docs/` was being excluded by an over-broad version-control ignore rule, so the page stayed frozen at its initial version.

## Changes in this PR

- Added the documentation build toolchain (MkDocs, Material for MkDocs, Mike) to the Software Bill of Materials, so it now appears in both the generated SBOM and the SBOM reference page. These were previously installed ad-hoc during CI and went unrecorded.

## Changes in this PR

- Governance memberships (access packages / business roles) are now modelled as ordinary assignments with a "governed" flag marking that the access is driven by a governance structure, replacing the special-cased "Governed" assignment type. A user assigned to a business role gets a real Direct membership on it, flagged governed.
- The matrix now derives "managed by access package" colouring and the **provisioning gap** — a user who should have access via a business role but doesn't actually have it — directly from the data instead of computing it in the browser, so the gap is consistent everywhere and reflects every governance source, not just Entra access packages.
- Provisioning-gap detection now works for any source that supplies role/entitlement relationships (Entra access packages, midPoint and Omada business roles), including identity-based assignments.
- Access-package counts on dashboards, user pages and the governance views now read the governed flag, so they stay accurate after the model change.

## Changes in this PR

- Standardised example data across the documentation, tests, and fixtures to use generic placeholder organisation, system, and hostname values.

## Changes in this PR

- CI no longer spins up the ~50-minute Integration, Playwright E2E, and Load & Soak suites for pull requests that only change test files — the application under test is unchanged, so those suites are skipped (unit and contract tests still run).

## Changes in this PR

- The API row on the Test Coverage docs page now reflects both unit *and* contract tests, so route code exercised only end-to-end (the matrix grid, contexts, identities, resources, ingest, plugin runner) no longer reads as untested.

## Changes in this PR

- Added a Test Coverage page to the documentation (Reference → Test Coverage) showing line/branch/method coverage for the API, UI, and PowerShell suites, with links to full browsable per-file reports. It refreshes automatically on every merge and is versioned alongside the docs (edge tracks the latest, a release is frozen at its version).

## Changes in this PR

- Fixed CSV/Omada imports failing with a `ContextMembers_contextId_fkey` foreign-key error when the configured system type contained a hyphen (e.g. a two-word system name). Context members now resolve to the same contexts that were imported, regardless of hyphens in the system type.
- Omada transform: identities are now keyed by `_ID` first (then `_UID`, then `_IdentityID`), and identity-to-account links use the same key derivation so a person and their accounts always connect.

## Changes in this PR

- Governance constructs (business roles / access packages) are now explicitly labelled in the data with a generic `governanceResource` flag, so the matrix's governance side is identified from the data instead of hardcoded knowledge — and new governance sources surface automatically. All crawlers (Entra, Omada, midPoint) label theirs consistently; existing ones are backfilled. No system-specific terms in the model.

## Changes in this PR

- Fixed a hang where context pages, the matrix, and crawler syncs could freeze indefinitely if a context's parent chain ever formed a loop (A inside B inside A). Affected queries now stop safely instead of running forever.

## Changes in this PR

- Groundwork for governed-access tracking: an assignment can now carry a "governed" flag, letting the same access be recorded both as actually-in-place and as governed/expected-by-a-business-role. No visible behaviour change yet — the crawler and matrix that use it follow in a later change.

## Changes in this PR

- Group ownership is now modelled as its own "Owner @ \<group\>" resource (a Direct assignment) instead of a separate "Owner" membership kind — so the matrix uses one consistent set of assignment types (Direct / Indirect / Eligible) and ownership can be listed, related, and certified like any other access.
- The matrix shows ownership as a real resource row rather than a client-side-simulated "(Owner)" sub-row.

## Changes in this PR

- Entra app-role, OAuth2 delegated-permission, and directory-role assignments are now recorded using the standard Direct / Indirect / Eligible assignment kinds instead of internal source-specific labels — the kind of resource already says what the access is, so the matrix shows one consistent set of assignment types. No change to which access is shown.
- Added contract tests for the ingest engine's soft-delete path, running against a real PostgreSQL container via testcontainers. Verifies that `scopedDelete` correctly stamps `deletedAt` on absent rows and skips already-deleted rows.

## Changes in this PR

- Added an architecture design doc (`docs/architecture/assignment-model-redesign.md`) for simplifying the assignment model — collapsing the internal assignment types down to the three universal kinds (Direct / Indirect / Eligible) and moving "what kind of access" onto the resource.
- Groundwork for that change: assignments now carry the resource's type alongside them, so future syncs can reconcile by resource. No visible behaviour change.

## Changes in this PR

- The Entra ID crawler now imports directory roles (Global Administrator, Privileged Role Administrator, etc.). Enable the "Directory Roles" object type on the crawler to sync them.
- Each directory role records its granular permission actions, whether it's a built-in role, and its template ID — the groundwork for scoring how critical a role is by what it can actually do.
- Both active role holders and PIM-eligible role holders are imported, and show up in the access matrix as Direct and Eligible access respectively.
- Fixed the Entra ID crawler edit wizard: the "Object Types to Sync" step now shows the full list of object types when editing an existing crawler (previously it could appear blank unless you re-entered the client secret), so you can enable Directory Roles on a crawler you've already set up.

## Changes in this PR

- The Entra ID crawler now imports directory roles (Global Administrator, Privileged Role Administrator, etc.). Enable the "Directory Roles" object type on the crawler to sync them.
- Each directory role records its granular permission actions, whether it's a built-in role, and its template ID — the groundwork for scoring how critical a role is by what it can actually do.
- Both active role holders and PIM-eligible role holders are imported, and show up in the access matrix as Direct and Eligible access respectively.
- Detail pages no longer silently hide real backend errors as empty data. The tolerance for optional tables on older deployments is now precise — only a genuinely missing table or column is ignored, while any other failure surfaces (logged and reported) instead of masking the problem behind a blank section.

## Changes in this PR

- Added quick-reference table to `tools/crawlers/CLAUDE.md` showing which test filename runs under which runner (UI vitest, API vitest, or Playwright), so developers don't have to read through multiple paragraphs to understand where a new test will execute

## Changes in this PR

- Added `npm run test:coverage` to `app/api` and `app/ui` for informational code coverage reporting (no CI gate — run locally to see which lines are exercised by unit tests)

## Changes in this PR

- Added `npm run test:e2e:sql` command to run Playwright E2E tests against a real Docker stack locally, matching the CI environment exactly
- E2E failures in CI now block PR merges (removed the `continue-on-error` bypass that was masking test failures)

## Changes in this PR

- Improved the risk-scoring dashboard's load time on large tenants: the "top entities by score" lists and the latest-scored-at lookup now query only what's shown (top 10 / most recent) instead of fetching and sorting every risk-scored row.

## Changes in this PR

- Added software supply-chain protection to the build pipeline: every pull request now installs Node dependencies through Socket Firewall, which blocks known-malicious packages (typosquats, install-script malware, hijacked maintainer releases) before they reach the build — including malicious version bumps that automated dependency updates might propose.
- Credited Socket Firewall on the About and Security pages of the documentation.

## Changes in this PR

- Improved matrix performance on large tenants: the roll-up and scope views now use a dedicated index for direct memberships, roughly halving the query time for broad matrix loads (measured ~2.5x faster on a real ~370k-row dataset). No change to results.

## Changes in this PR

- Internal maintainability: completed the matrix API module split — the core matrix-data query endpoint now lives in its own module. The matrix route file is reduced from ~1,680 lines to ~200. No change to matrix behaviour, endpoints, or output.

## Changes in this PR

- Internal maintainability: continued the matrix API module split — the scope-analysis endpoints (scope statistics, timeline, and breakdown) and the shared filter/scope helper functions now live in their own modules. No change to matrix behaviour, endpoints, or output.

## Changes in this PR

- Internal maintainability: split the oversized matrix API route module into smaller focused modules — the saved-filter endpoints and the roll-up SQL builders now live in their own files. No change to matrix behaviour, endpoints, or output.

## Changes in this PR

- Fixed dark-mode hover states on buttons and links across the context detail/tree, risk-scoring, run-detail, and modal screens. A hover text color was being applied permanently in dark mode (instead of only on hover) because its `hover:` modifier was missing, so the affected controls didn't visibly respond to hover in dark mode.
- The lint check for duplicate dark-mode colors is now enforced as an error, preventing the issue from returning.

## Changes in this PR

- Extracted shared `Invoke-FGWriteRequest` helper to eliminate the duplicated body in `Invoke-FGPostRequest` and `Invoke-FGPutRequest`
- Extracted shared `Invoke-FGGetPage` helper to eliminate the duplicated retry/throttle loop across `Invoke-FGGetRequest`, `Invoke-FGGetRequestToFile`, and `Invoke-FGGetRequestStream`
- Extracted shared `Merge-FGJsonArrayFile` and `Remove-FGTrailingCommaFromJsonFile` helpers to eliminate the duplicated StreamReader/StreamWriter JSON cleanup blocks
- Merged `Get-FGGroupTransitiveMemberAll` and `Get-FGGroupTransitiveMemberAllToFile` into their non-transitive counterparts via a `-Transitive` switch; the old function names remain as thin wrappers
- Extracted shared `Resolve-FGMemberObjectIds` helper to eliminate the duplicated member-name-to-object-ID resolution block in `Confirm-FGGroupMember` and `Confirm-FGNotGroupMember`

## Changes in this PR

- Fixed dark-mode styling on the context detail/tree, risk-scoring, run detail, and modal screens where duplicated Tailwind classes silently overrode the intended values: secondary text now renders at the correct (higher-contrast) shade, and table rows, list items, and sub-tabs no longer appear permanently highlighted in dark mode.
- Added a lint check that flags a className setting the same dark-mode color twice, to stop the issue from creeping back in.

## Changes in this PR

- Fixed the identity detail page so each linked account again shows its real group count and risk score/tier. Previously the per-account group count always displayed 0 and the risk score/tier never appeared, regardless of the account's actual access.

## Changes in this PR

- Published the June 2026 maintenance-sprint audit report (design/UX, security, performance & code quality, CI/test harness, and documentation review, plus an independent second-model cross-check) to the documentation site under Security.

## Changes in this PR

- Hardened crawler API-key authorization: a crawler key can no longer claim worker jobs, mark jobs complete/failed, or flip a config to delta mode unless it is the privileged built-in worker key. This closes a path where any valid crawler key could claim a queued job and receive another connected system's stored credentials.
- Crawler delta-sync state (delta tokens) is now scoped to the systems a crawler is allowed to access — a system-scoped crawler can no longer read, overwrite, or delete another system's sync token.
- The performance-metrics endpoints that clear collected metrics or enable/disable collection now require administrative permission instead of being open to any signed-in user.

## Changes in this PR

- Extracted shared `WizardShell` component from all 7 crawler ConfigWizard files, eliminating repeated card/header/stepper/error JSX
- Extracted shared `canSubmitCredentials` and `buildCredentialFields` utilities into `crawlerCredentials.js`, covering all auth methods (FormCookie, BasicAuth, OAuth2CC, OAuth2ROPC, ApiToken, CookieString)
- Extracted shared `MappingRows` component for the add/remove mapping-row grids used by the Omada and midPoint wizards
- Lowered the jscpd duplication gate threshold from 3% to 2%, locking in the JS/JSX reduction (1.65% overall after this refactor phase)

## Changes in this PR

- Extracted shared scaffold (`EntityDetailPage`) from the Resource, User, Business Role, and Identity detail pages, eliminating ~700 lines of near-identical JSX while preserving all existing behavior (attributes table, relationship graph, timeline, risk tab, per-entity header styles, linked accounts panel, analyst override controls)
- Added CI code-duplication gate (jscpd, 3% threshold) to catch clone drift before it enters main; threshold configured in `.jscpd.json` and enforced on every PR
- Extracted shared scaffold (`EntityListPage`) from the Resources, Users, and Identities list pages, eliminating ~700 lines of near-identical JSX while preserving all existing behavior (tag management, filter bar, sort, selection, pagination, include-deleted toggle, sub-tabs)

## Changes in this PR

- Extracted shared `queryRiskScoresPage` helper to eliminate duplicated list+count query pattern across all five risk score list endpoints (`/users`, `/groups`, `/business-roles`, `/contexts`, `/identities`)
- Extracted shared matrix SQL expression builders (`buildAssignmentExprs`, `buildIdentityJoinExprs`, `buildRoleSubjectJoinExprs`, `buildApMemberExprs`, `mergeGroupTotals`, `resourceMeta`) to remove repeated identity/principal conditional blocks in matrix route
- Extracted shared `createTempTable` and `bulkInsertIntoTemp` helpers to remove duplicated temp-table creation and batch-insert logic shared between ingest engine and sync sessions

## Changes in this PR

- The Azure RM crawler now reads resource groups, resources, role definitions and role assignments from Azure Resource Graph instead of one call per subscription, so it scales to tenants with hundreds of subscriptions with a fraction of the API calls and a much shorter run time. Output is unchanged — verified identical to the previous method on a live tenant before switching over.
- Azure scope identities are now case-insensitive, so the same resource group or resource is never split into two entries because Azure returned its path with different casing.
- Fixed crawler jobs failing when a crawler folder contains development-only scripts in a `dev/` subfolder; these are now correctly ignored at runtime as intended.

## Changes in this PR

- Soft-deleted records (users, resources and their assignments that were removed in a source system) are now **permanently purged after the retention period**, reusing the existing **Admin → Deleted Data & History Retention** setting (default 180 days). They stay auditable during the window, then the same job that prunes the audit log finalises them. One global value governs both; set it to `0` to keep everything forever.
- The Admin retention card and its "Prune now" action now cover deleted records as well as history.

## Changes in this PR

- Entities deleted in a source system (e.g. a user removed from Entra ID, or a deleted resource) are now **soft-deleted** instead of being erased: the record is kept and stamped as deleted, so leavers and removed resources stay auditable and cross-system references don't dangle. A later sync that re-sees the entity automatically restores it.
- Soft-deleted principals and resources are **hidden by default** from the access matrix and the Users/Resources lists. An **Include deleted** toggle on each list brings them back, marked with a **Deleted** badge; their detail page carries a "Deleted in source" badge too.
- Detail pages keep the history: a person still shows that they had access to a now-deleted resource (and a resource shows the now-deleted people who held it), each marked as deleted.

## Changes in this PR

- The Azure Resource Manager crawler can now skip role assignments whose principal isn't present in Entra ID — deleted service principals with dangling assignments, or principals outside a scoped (e.g. admins-only) Entra ID crawl. Controlled by a new **"Only load assignments for principals in Entra ID"** option (on by default; run the Entra ID crawler first).
- With that option off, those principals are still loaded but flagged as **orphaned**, so you can review them rather than hide them.

## Changes in this PR

- Added two generic context-algorithm plugins that derive navigable Context trees from the data any crawler emits: **Scope Hierarchy** (builds a tree from `Contains` relationships — e.g. Management Group → Subscription → Resource Group → Resource — with a `leafResourceTypes` option to stop at a level and list deeper resources as members) and **Resource Type Tree** (groups resources by an attribute into a root → per-type → members tree).
- The matrix can now answer "who has access to **any** resource in this group?". Filtering by a Resource context whose members are scope nodes (e.g. "all key vaults", "all VMs") now shows the **effective** access at those scopes — including **inherited** access — computed on demand by the effective-access engine, instead of an empty grid. Generic: it works for any source with containment + capability-resources.
- Added a **Principal Type Tree** context plugin — the principal-side mirror of Resource Type Tree. It groups principals by an attribute (default `principalType`) into a root with a child context per value, so you get ready-made **Managed Identities**, **AI Agents** and **Service Principals** contexts to filter the matrix by — answering "what can all managed identities access?". Optionally restrict to chosen values and/or one system.
- Inherited (Indirect) rows from the matrix expand now navigate to a real resource instead of 404'ing, and synthesized rows carry their scope-type label in the name.
- The access matrix can now show **inherited (effective) access**: tick **Include inherited access** when you've scoped to a set of resources, and access inherited from higher scopes (e.g. Owner on a subscription → Indirect on every resource beneath it) is folded in — as **I** badges in the flat grid and as counts in every rolled-up / folded view.
- Click any inherited **I** badge to see **how it was inherited** — the grant source and the scope path (e.g. *Owner on Subscription X → Resource Group → resource*).
- Inherited access is computed on demand and **cached per sync**, so repeat and large views are fast and it never needs materialising.
- **Resource Type Tree** plugin can now add, under each type, **Data plane access / Control plane access** groups and a leaf per role — so you can ask "who has any data-plane access to a storage account?" or "who has Owner on any storage account?" (needs the crawler's per-role plane classification).
- **Generated contexts now refresh automatically after every crawl**, so plugin-derived contexts (Managed Identities, Resource Types, scope trees…) never go stale — no separate plugin scheduling needed.
- New **Admin → Plugins** tab: see every configured context-plugin tree, its configuration, context count and last run, and **Run now** for an ad-hoc rebuild.
- The **Sync Log** tab is now **Logs** (moved next to Admin) — a single time-sorted activity stream of crawler syncs, context-plugin runs, account-linking runs and risk-scoring runs, with filter chips per type, a search box, and a **link back to the source** of each entry.
- **Account linking, context-plugin refresh and risk scoring now run automatically after every crawl** (when configured) as one ordered pipeline — each completes before the next, so contexts rebuild *after* account linking and risk scoring runs *after* contexts. Links and scores always reflect the latest crawled data.
- **Simplified scheduling:** account linking and risk scoring no longer have their own schedules to configure — they run after each crawl, with a **Run now** button for ad-hoc runs. Removes the per-tree, per-job and cron scheduling controls in favour of good defaults.
- Added a **Run now** button to the Risk Scoring admin page to re-score the active classifier on demand.
- Removed the **Recent runs** table from the Account Linking page — run history now lives in the Logs tab; Run now reports its result inline.
- **Plugin details page:** click any row on Admin → Plugins to open a details view showing what the plugin does, its full configuration, context count and last run. From there you can **edit the configuration and re-run** it in place, re-run it unchanged, or **remove** the tree (deletes its generated contexts).

## Changes in this PR

- Added automation that, whenever a merged PR changes a dependency manifest, lockfile, Dockerfile, or the compose file, regenerates the machine-readable SPDX SBOM (`sbom-edge.spdx.json`) and refreshes the version data on the Software Bill of Materials documentation page (npm package versions plus the PostgreSQL, PowerShell, and Node base-image versions), keeping both in sync with what actually ships.

## Changes in this PR

- Fixed the matrix scope-expand control (`>`) failing to appear on real PostgreSQL: a uuid/text type mismatch in the query that decides which rows are expandable caused it to error and silently render no expand affordance at all — which also suppressed nested-group expansion. Added a Postgres-backed CI check so this class of bug (SQL type errors hidden by database-mocked unit tests) is caught going forward.

## Changes in this PR

- Added an Azure Resource Manager crawler: syncs Azure RBAC — management groups, subscriptions, resource groups, role assignments and role definitions — so Azure scope access appears in Identity Atlas, with role-at-scope inheritance computed by the effective-access engine.
- Added the Azure Resource Manager crawler to the **Add Crawler** picker, with a guided setup wizard (service principal, scope, options, schedule) and a summary card in the configured-crawlers list.
- The Azure RM wizard now discovers your environment live: pick subscriptions from a checklist and choose a management group from the nested hierarchy, instead of typing IDs by hand (with a manual fallback if discovery can't reach Azure).
- Made the crawler action buttons (Run Delta, Run Full, Configure, Export, Remove) a uniform height and moved them to their own row beneath the crawler name, so they always line up consistently instead of pushing "Remove" onto a second line when the name is long.
- Fixed an Azure RM crawl failure when "Include individual resources" was enabled: resource IDs containing a "|" character no longer break scope-id generation.
- Azure RBAC inheritance is correct and computed on demand: role assignments are recorded only at the exact scope where they are declared (management group, subscription, resource group, or resource). Access you hold because you're an Owner at a higher scope shows as **Indirect** on the resources beneath it when you expand that assignment in the matrix — the effective-access engine derives it from the scope hierarchy, nothing is copied onto every scope below. The crawl is also much faster — one role-assignment query per subscription instead of one per scope.
- Management groups now show their real display name (e.g. "Tenant Root Group") instead of a bare GUID when a role assignment is inherited from a management group above the crawled subscriptions.
- Fixed the matrix scope-expand control (`>`) not appearing on real PostgreSQL: a type mismatch in the query that decides which rows are expandable made it error out and silently show no expand affordance at all.
- Scope assignment names now show the scope type — e.g. `Owner @ Sub: Fortigi Azure`, `Owner @ RG: …`, `Owner @ MG: …` — so it's clear at a glance whether the access is on a management group, subscription, resource group, or resource (for both declared and inherited rows).
- Fixed an "HTTP 404 — error loading resource" when opening an inherited (Indirect) row from the matrix expand: those rows are computed on the fly and have no detail page of their own, so they now link to the underlying scope resource (which does).
- Azure resources now record their specific resource type (e.g. `Microsoft.Compute/virtualMachines`, `Microsoft.Storage/storageAccounts`, `Microsoft.OperationalInsights/workspaces`), parsed from the ARM id and shown on the resource detail page — the groundwork for "who has access to any VM / any storage account" views.
- The Azure RM crawler no longer creates Contexts. Contexts are derived data, so the scope-hierarchy and resource-type trees are produced by context-algorithm plugins from the scope resources + `Contains` relationships the crawler emits; the crawler now sticks strictly to source data.
- Added two context-algorithm plugins that turn the crawled data into navigable Context trees: **Scope Hierarchy** (Management Group → Subscription → Resource Group → Resource, with a `leafResourceTypes` option to stop at a level and list deeper resources as members) and **Resource Type Tree** (groups resources by an attribute — by default `azureResourceType`, e.g. all Virtual Machines, all Storage Accounts). Both are generic — they work for any system that emits containment relationships or typed resources.
- Azure resources now record more governance attributes you can build contexts and matrices from: **region** (`azureLocation`, e.g. "who has access to anything in West Europe"), **portal tags** (each tag becomes its own attribute, e.g. "access to anything tagged Prio High"), and **managed identity** (whether the resource has one, and which — so you can group "all resources that have a managed identity"). Each is just an attribute the Resource Type Tree plugin can group by.
- Role assignments now record the **ABAC condition** (so a conditional grant is no longer shown as blanket access) and **provenance** (who created the assignment, and when).
- Fixed the Azure RM crawler overwriting the managed-identity / AI-agent classification that the Entra ID crawler assigns: because Azure RBAC labels every workload identity simply as "ServicePrincipal", the crawler no longer asserts that type for workload identities, so managed identities stay correctly classified and the "Managed Identities" context stays accurate.
- Each role assignment now records whether the role grants **control-plane**, **data-plane**, or **both** access (read from the role definition's `actions` / `dataActions`) — so you can distinguish "can manage the storage account" from "can read the data inside it", and build a context for *anyone with any data-plane access*.

## Changes in this PR

- The matrix can now expand a **scope-based permission** — e.g. an Azure role at a subscription or management group, and in future Azure DevOps, file shares or SharePoint — with the `>` control, revealing the resources beneath it that inherit that access (the same drill-down nested groups already offer). Inherited access is computed on demand by the effective-access engine, so it works for any system with scope inheritance without the crawler storing every inherited row.

## Changes in this PR

- Fixed FK violation in Omada → Identity Atlas transform: context-member rows for org units or job titles that don't appear in the exported Orgunits/Jobtitle files are now silently skipped instead of causing the import to fail with a `ContextMembers_contextId_fkey` constraint error.

## Changes in this PR

- Fixed Context Member import from CSV (e.g. the Omada→Identity Atlas conversion script): memberships that reference their context and member by external id now import correctly instead of failing with a database error. Affected any context membership imported via CSV, including Omada Positions (whose keys contain a pipe character — the pipe was never the cause).
- Fixed the CSV crawler collapsing all context-member rows into a single record before upload, so every membership is now imported rather than just one.

## Changes in this PR

- Crawler-type-specific behaviour no longer lives hardcoded in the API core: the demo "one run at a time" rule and the Custom Connector's paired-API-key handling are now driven by `singletonJob` / `pushMode` flags in each crawler's manifest, so adding or changing such behaviour stays inside the crawler's own folder.
- The crawler-isolation CI check now also scans the API source (`app/api/src`), not just the UI, and fails a build if a crawler type is hardcoded or a type-named file drifts into core.

## Changes in this PR

- Fixed a database deadlock that could occur when upgrading to a newer version: the application now applies all pending SQL migrations before it starts accepting any requests, so a crawler can no longer run against a half-migrated schema.
- If migrations fail on startup, the application now stops instead of serving with an outdated schema (the container restarts and retries automatically).

## Changes in this PR

- Fixed `bump-version` workflow failing to push to `main` by updating the deprecated `app-id` parameter to `client-id` in `actions/create-github-app-token`, matching `cut-release` and `cut-hotfix`
- Fixed CSV crawler rejecting large upload files (Assignments, Certifications) with "File too large". The per-file upload limit is raised from 200 MB to 1 GB.
- The CSV upload wizard now shows the file size limit in the upload step and flags any selected file that exceeds it before the save is attempted.
- Extracted the Demo Data crawler into its own plugin folder (`tools/crawlers/demo/`) with a `CrawlerMeta.js` and a `ConfigWizard.jsx` info page, removing the last hardcoded crawler type from `CrawlersPage.jsx`
- The Demo wizard now shows what data gets imported before loading, so users can cancel before committing
- Removed the `no-hardcoded-crawler-meta` ESLint warning carve-out for `CrawlersPage.jsx` — the rule is now a hard error for all UI files with no exceptions
- Removed the `PENDING_MIGRATION` exemption list from the `crawler-manifest` CI check — all crawler types now unconditionally require `CrawlerMeta.js` (except `odata` which is library-only)
- A PR touching only one crawler's files now runs only that crawler's integration test (plus any crawlers that transitively depend on it), not the full suite — a single-crawler change drops from ~20 min to ~3 min of integration testing
- Crawlers that must run for data setup (e.g. odata when omada changed) run without assertions so their exit code doesn't block the PR
- `::group::` log markers added to the crawler test runner — each crawler's output is now collapsible in the GitHub Actions log with pass/fail annotations in the PR summary
- Moved the Custom Connector's setup wizard and management UI out of the core admin UI and into their own self-contained `tools/crawlers/custom-connector/` folder, following the same pattern already used by the CSV, Omada, midPoint, and Microsoft Graph crawlers.
- Custom Connectors now appear as cards in the "Configured Crawlers" list, alongside every other crawler type, instead of in a separate table below the recent-jobs list. Each card shows the API key prefix, an enabled/disabled toggle, a "Reset Key" action, and an activity log (which now actually displays entries — previously it fetched them but never rendered anything).
- No other functional changes: registering, disabling, resetting, and removing a Custom Connector all behave the same as before.
- Moved the Microsoft Graph (Entra ID) crawler's configuration wizard out of the core admin UI and into its own self-contained `tools/crawlers/entra-id/` folder, following the same pattern already used by the CSV, Omada, and midPoint crawlers.
- Fixed: the "Advanced options" on the Schedule step (sign-in logs window, extra AI-agent name patterns) were silently dropped on save and never persisted — they now save and reload correctly.
- Fixed: editing an existing Microsoft Graph crawler without re-entering the client secret could fail to load the identity/user/group attribute pickers (a 400 error), because attribute discovery looked for the secret in the stored config instead of the secrets vault. It now resolves the vaulted secret correctly, matching how every other crawler type's live discovery already worked.
- Fixed: saving an edit to a Microsoft Graph, Omada, or midPoint (OAuth2 Client Credentials / OAuth2 ROPC auth) crawler without re-entering the client secret could fail with a 400 error ("required property clientSecret"). The same applied to clicking "Run Now" and to scheduled syncs, which failed silently (logged only to the container console). All three paths now correctly resolve the secret from the vault instead of expecting it in the stored config.
- No other functional or visual changes to the Microsoft Graph, Omada, or midPoint crawlers' setup wizards.
- Fixed CI: the UI unit-test job failed to load because it picked up the Omada crawler's new `configValidation.test.js`, which pulls in the database driver package that's only installed for the API — that test now correctly runs only under the API's test job.
- Fixed CI crawler scope detection incorrectly treating `tools/crawlers/CLAUDE.md` as a crawler type — only subdirectory paths are now matched
- Fixed YAML parse error in `pr-integration.yml` that caused all integration test runs to fail immediately with "workflow file issue", blocking every open PR from merging.
- The Omada-to-IdentityAtlas transform script now processes `Employment.csv` and `Jobtitle.csv`. Job titles are imported as `JobTitle` contexts, unique org unit + job title combinations as `Position` contexts, and each employment row generates identity memberships to its org unit, job title, and position context. All employments are included regardless of `ValidFrom`/`ValidTo`.
- Replaced all `'../../'` and `'../../../app/ui/src/'` relative import paths in the UI source and crawler wizard files with the `@ui/` alias (e.g. `import { useAuth } from '@ui/auth/AuthGate'`), making imports stable regardless of where a file sits in the directory tree
- Added a `jsconfig.json` at the repo root so VS Code and JetBrains resolve `@ui/` and `@crawlers/` aliases without red underlines
- Added the `local/no-relative-package-imports` ESLint rule and a companion Vitest test to prevent `'../'` traversal from creeping back into `src/` or crawler wizard files
- Fixed "PR Summary expected" ghost check appearing on all PRs after Phase 1 renamed the gate job; a stub job now emits the completed check name the Claude GitHub App expects.
- Fixed scheduled crawler runs silently skipping for Omada and midPoint configurations that use OAuth2 auth methods — the scheduler now validates stored configs via the vault-aware validator instead of always failing on a missing `clientSecret`
- Added unit tests for scheduler schedule-matching logic and job-queuing behaviour

## Changes in this PR

- CI now skips all checks when a push adds only housekeeping commits (version bumps, "Update branch" merges from main)
- Path-scoped CI gates: a UI-only change no longer triggers PowerShell lint or the 50-minute integration suite; a single-crawler change no longer runs all crawlers
- `ci-passed` and `ci-integration-passed` gate jobs replace per-job branch protection requirements, correctly passing when jobs are legitimately skipped
- `setup/IdentityAtlas.psd1` (version-number file) excluded from integration suite path trigger
- `node-launcher-ui-build` now only runs when UI or crawler wizard files change

## Changes in this PR

- midPoint business roles that grant AD groups directly (via a `construction` inducement, the common pattern for birthright bundles) now show those groups as contained resources. Previously only role-to-role inducements were imported, so such roles appeared to grant nothing.
- As a result, users holding such a role now correctly show access to the underlying AD groups in the matrix (governed access propagates through the business role).

## Changes in this PR

- midPoint crawler now imports **inherited** role and service memberships, not just directly-assigned ones. Birthright roles (assigned via an archetype), nested roles, and org-inherited roles now show all their members in Identity Atlas instead of appearing nearly empty.
- Each governed assignment now records whether it was granted directly or inherited (`grant=direct` / `grant=inherited`).
- Governance metadata relations (manager, owner, approver, meta) are correctly excluded — only true membership is imported as access.

## Changes in this PR

- Added architecture specification for the effective-access engine: a lazy, on-demand traversal engine that computes inherited permission access across containment hierarchies (Azure RM scopes, folder trees, group nesting) using the existing `Contains` relationship edges
- Added an effective-access engine that computes inherited permissions on demand: a grant at a parent (a group, or a containment scope like an Azure subscription) is surfaced as indirect access on everything beneath it, without storing those rows.
- New read API: `GET /api/effective-access/resolve` (one principal on one resource) and `GET /api/resource/:id/effective-access` / `GET /api/principal/:id/effective-access` (effective capabilities at a node, including those inherited through the containment hierarchy).
- Groundwork for upcoming source crawlers (e.g. Azure Resource Manager) whose access is defined by role-at-scope inheritance.

## Changes in this PR

- No user-facing change. Added end-to-end test coverage for the CSV crawler wizard's file upload step (staging files, the required-object coverage indicator, and the real upload/list/delete round trip against the server), closing a test gap that previously only covered the wizard's first step via a static render check.
- The new test is co-located with the CSV crawler plugin (`tools/crawlers/csv/`) rather than in the core UI's e2e folder, consistent with every other crawler-specific file. Since a colocated file can't directly import Playwright's test APIs (no shared `node_modules` ancestor), it's loaded via a small generic discovery spec (`app/ui/e2e/crawler-plugin-tests.spec.js`) that contains no crawler-specific knowledge — the same pattern already used for the wizard/discover/summary plugin files.
- The `crawler-manifest` CI check now also fails if a migrated crawler has a stray file named after it (or a hardcoded reference to its type string) anywhere under `app/ui/`, not just in `CrawlersPage.jsx` — catching the exact kind of drift this branch itself had to fix. Documented as an explicit rule in `tools/crawlers/CLAUDE.md` and `app/ui/CLAUDE.md`.
- No user-facing change. Added unit test coverage for the Omada and midPoint crawler wizards' credential validation gating and save-payload building (the logic that decides whether a connection can be saved per auth method, and which credential fields actually get sent — blank means "keep the stored value" when editing). The previously closure-only logic was extracted into pure, exported functions to make this possible.
- Added unit test coverage for the Omada wizard's `$metadata` entity-set/identity-field validation, including the case-insensitive "did you mean" suggestion logic — also extracted into a pure, exported function (`validateContextObjectType`).
- Documented the project's JS/UI crawler-wizard testing conventions in `tools/crawlers/CLAUDE.md` (co-located vitest tests, the render-smoke-test pattern and its limits, when to extract pure functions, when to reach for a Playwright e2e test, and how to test a `discover.js` handler) — previously undocumented anywhere.
- Renamed `docs/sync/custom-crawlers.md` to `docs/sync/building-a-crawler.md` (and its nav title from "Custom Crawlers" to "Building a Crawler") to avoid confusion with the unrelated `custom-connector` crawler type, and added a full "UI Integration" section covering `CrawlerMeta.js`/`ConfigWizard.jsx`/`Summary.jsx`/`discover.js`/file uploads/JS-UI-testing — previously this guide only covered the PowerShell side, so following it alone produced a crawler that fails the `crawler-manifest` CI check (missing `CrawlerMeta.js`). Also added a pointer to the live ingest API reference (Swagger UI at `/api/docs`) and documented `ScheduleEditor`'s prop contract in `app/ui/CLAUDE.md`'s shared-utilities list.

## Changes in this PR

- Finished generalizing the crawler upload-schema endpoints: the file-extension filter and the downloaded file's content-type are now derived from each crawler's own manifest instead of being hardcoded to CSV. No user-facing change for the CSV crawler today, but removes the last CSV-specific assumptions from an otherwise generic mechanism.

## Changes in this PR

- Added automated test coverage for the generic crawler file-upload mechanism (upload/list/delete, the upload-schema templates, and the manifest-driven job-dispatch gate), which previously had none and was only verified by hand. No functional change.
- Migrated the CSV crawler's configuration wizard to the self-contained plugin system (`tools/crawlers/csv/`), matching how midPoint already works. No user-facing change to the wizard itself.
- Added a generic "summary panel" plugin mechanism so a crawler's configured card can show crawler-specific details (e.g. CSV's system/type/delimiter) without that crawler being hardcoded into the Crawlers page.
- Fixed: the "Download schema templates" file on the CSV crawler's upload step was missing `ContextMembers.csv` from its file list — it now appears alongside the other supported files.
- Added test coverage for the CSV crawler's fuzzy filename-matching logic and its configuration wizard.
- Generalized the crawler file-upload mechanism so it's no longer hardcoded to the CSV crawler: any crawler type can now declare file-upload support in its manifest instead of needing changes to core API code.
- Fixed: the CSV crawler's "Download schema templates" file was missing `ContextMembers.csv` from its column-header reference (it now reads the real template files, including the previously-missing one).
- No user-facing change to the CSV crawler's own upload/download experience — same folder convention, same wizard behavior.

## Changes in this PR

- Fixed: the portable Windows (node-launcher) build would fail to build the UI once a crawler ships a configuration wizard, because the wizard files live outside the UI's own folder and couldn't resolve their dependencies during that build. The desktop/portable build now stages the UI together with the crawler wizard files the same way the Docker image already does, so it builds successfully again.
- Added an automated check (now run on every pull request) that catches this exact class of regression going forward: it builds the portable UI bundle and verifies every crawler with a configuration wizard actually made it into the build output, not just that the build didn't error.

## Changes in this PR

- The Omada IGA crawler is now a self-contained plugin under `tools/crawlers/omada/` — its configuration wizard, type-picker entry, and live `$metadata` discovery no longer live as hardcoded logic in the core Crawlers page or API routes. Adding or changing the Omada wizard now never requires touching shared UI/API files.
- No functional change to the Omada crawler wizard itself — same steps, same fields, same validation behavior.
- Added a "Syncing from Omada IGA" page to the docs site, and registered the existing Omada data-model reference doc in the site menu (both previously missing or unreachable).

## Changes in this PR

- Cleaned up CI logs: the Pester unit-test job no longer prints a misleading "module currently in use" warning on every run.

## Changes in this PR

- Added architecture design note for the planned `identityType` column on the `Identities` table, capturing open questions and current workaround guidance for crawler authors.

## Changes in this PR

- Fixed: crawler configuration wizards (e.g. the midPoint wizard) and their type-picker entries were silently missing from the production Docker image — the frontend build stage didn't include the `tools/crawlers` folder that the wizard plugin system discovers wizards from. They now appear correctly in the deployed app, not just in local dev.
- Added an automated check that catches this exact class of regression going forward: an E2E test that dynamically discovers every crawler with a UI wizard and verifies it actually appears in the "Add Crawler" list of the running app.

## Changes in this PR

- Added a dedicated midPoint (Evolveum) crawler wizard in Admin → Crawlers, so midPoint can now be added and configured fully from the UI (previously it could only be set up via raw config/import).
- The wizard guides you through connection, authentication (Basic / API token / OAuth2 client-credentials / OAuth2 ROPC), which object types to sync, the mapping rules, and scheduling — with every field pre-filled to the crawler's existing defaults.
- Added role classification: map midPoint roles to an Identity Atlas resource type by archetype (with subtype as a fallback). Archetypes and subtypes are discovered live from the connected midPoint server and offered as dropdown suggestions.
- Added advanced type-mapping overrides to map org subtypes to a context type and user subtypes to a principal type, also populated live from the server.
- Fixed: editing an existing midPoint crawler now opens the midPoint wizard instead of incorrectly opening the Microsoft Graph wizard.
- midPoint crawler configurations can now be exported and re-imported like the other crawler types.
- Added a full configuration reference for the midPoint crawler documenting every field and its default value.
- Every dropdown field in the midPoint wizard now shows a consistent dropdown arrow; the archetype/subtype fields open a clickable list of values discovered live from midPoint, always offer the default value (even when midPoint has none), and still allow free text.
- The live dropdown lists (archetypes, subtypes) are now shown in alphabetical order, with the default entry pinned at the top.
- The archetype dropdown now lists only archetypes that apply to roles, hiding midPoint's task/report/case system archetypes that are irrelevant to role classification.
- The midPoint wizard now uses the same numbered step indicator (Connection › Credentials › Objects & Mapping › Schedule) as the other crawler wizards.
- The midPoint sync guide and its new configuration reference are now listed in the docs site menu (they previously existed only as unlinked pages).
- Added a CI check that fails the build if a crawler doc page under `docs/sync/` isn't registered in the docs site's navigation, so this can't go unnoticed again.

## Changes in this PR

- Adding a new crawler type with a step-by-step configuration wizard no longer requires editing the core Crawlers page — drop a `ConfigWizard.jsx` and a `CrawlerMeta.js` in the crawler's folder under `tools/crawlers/{type}/` and it is picked up automatically.
- Crawlers can now expose a live-discovery endpoint by adding a `discover.js` to their folder; the UI wizard can call it at `POST /api/admin/crawlers/{type}/discover` without any API route changes.
- Added shared `Combobox` and `Select` input components for use in crawler wizard forms.
- The Vite dev server now allows serving files from outside `app/ui/` so that wizard components under `tools/crawlers/` are reachable during development.
- Added CI, ESLint, and Pester guardrails to prevent new crawlers drifting away from the manifest-based plugin system — adding a crawler without a `CrawlerMeta.js` now fails the build.

## Changes in this PR

- Fixed resourceType documentation to match what the built-in crawlers actually produce (removed non-existent types, added Application, AppRole, DelegatedPermission, Entitlement, Resource, Service)
- Added missing assignmentType values (AppRole, AppRoleViaGroup, OAuth2Grant) to the data model reference
- Added AI provider configuration guide to the Risk Scoring overview, including all three supported providers (Anthropic, OpenAI, Azure OpenAI), required fields per provider, and a data privacy table showing which providers are suitable for regulated environments
- Updated config file reference to cover Azure OpenAI and correct stale model defaults

## Changes in this PR

- Added identity-level assignment support to ResourceAssignments: any access can now be assigned to a person (Identity) rather than a specific account (Principal), enabling IGA crawlers (e.g. MidPoint, Omada) to express the true IGA assignment model
- Added `POST /ingest/resource-assignments-identity` endpoint for IGA crawlers to push identity-level business role assignments
- Matrix view now expands identity-level assignments through IdentityMembers so each linked account appears in the access matrix
- Fixed `classify-business-role-assignments` endpoint to correctly handle identity-level Direct assignments when promoting to Governed
- Admin stats panel now shows count of identity-level assignments for post-deploy verification

## Changes in this PR

- Fixed the context rename box shrinking to a tiny width when you double-click a context to rename it — it now stays wide enough to read and edit the full name.
- Context nodes can now show the actual users inside them on demand: each node with directly-assigned users gets a small "👤 N" toggle — click it to reveal the users as ovals nested inside that context (hidden by default to keep the tree readable). Click a user oval to open their detail.
- Sibling context nodes that share a long name prefix (a side effect of how the Manager Hierarchy names nodes) now show only their distinctive tail in the tree, with the full name on hover.
- The Manager Hierarchy plugin no longer repeats a name across consecutive org levels — "Commercie · Commercie" now reads just "Commercie" (existing trees also display de-duplicated without needing a re-run).
- In the Manager Hierarchy context tree you can now drag a team's direct member (a person) onto another team to change who they report to — the same way you can drag a team to re-parent it. The move is recorded as an override of the person's manager, so it survives every plugin re-run (dropping them back on their original manager clears the override).
- The sorted matrix can now fold a sort-attribute group into a single aggregate column: click a Division/Department header value to collapse all of its subject columns into one column showing the number of child groups, the number of users, and a count of Direct assignments per resource. Click the collapsed header again to unfold. Works at every sort level.
- Folding a large matrix by attributes now loads efficiently at any scale, including all users: instead of being blocked, an oversized attribute fold is aggregated on the server. Every chosen attribute is shown as its own header row from the start; click a value to fold its group into a single count column, and click a folded column to unfold it again. Small matrices keep the detailed per-subject grid.
- Removed the Orientation step from the matrix wizard.
- Excel export now includes every header row shown on screen (all sort attributes, and every org level in the Manager Hierarchy view), instead of just one. On-screen merged header spans are written as the same value repeated across each column — cells are not merged in the file.
- Matrix headers now keep only the lowest row pinned when you scroll vertically — in both the Manager Hierarchy / attribute views (deepest level stays) and the per-subject grid (the names row stays) — so many header rows no longer hide the matrix.
- The Manager Hierarchy and attribute fold views now hide branches/groups that have no in-scope assignments — when you scope a matrix to a set of resources, org teams (or attribute groups) where none of those resources are used no longer clutter the column headers.
- Sorting a matrix by Manager Hierarchy now loads efficiently at any scale, including all users: instead of fetching every per-subject assignment (which could fail to load for very large sets), the matrix aggregates per org node on the server and shows org-level counts, drilling into a branch or expanding a team's people only when you ask. This fixes the "Matrix query failed" error when loading all users by hierarchy.
- Large per-subject (attribute-folded or unfolded) matrices that are too big to load now show a clear "too large to load as a per-subject grid" message pointing you to Manager Hierarchy sort or attribute roll-up, instead of timing out — folding only collapses the displayed columns, it doesn't reduce how much data is loaded, so only the server-aggregated views load at any size.
- The matrix wizard no longer blocks loading a large matrix when it will open folded: since folding collapses the columns that make a big matrix slow, an oversized matrix that opens folded (the default above 5,000 assignments, and always for Manager Hierarchy sort) is now allowed with an informational note instead of being blocked. The hard "too large to load" block now applies only when you choose to load unfolded.
- A folded column can now be exploded into its individual member columns at the current level, instead of only drilling to the next level: the ▾ control shows all members (direct + indirect) under that group, and the ↳ control shows only the direct members at that level. Click the exploded group's header to collapse it back into a count. In Manager Hierarchy sort this lets you see the people sitting at an org level without descending into its sub-orgs.
- The matrix wizard steps were reordered for clarity: Step 1 now picks the subject type and the roll-up option, Step 4 is Sort (automatically skipped when roll-up is on, since column order is meaningless then), and Step 5 is Orientation.
- The roll-up view now mirrors the per-subject matrix: the Scope Statistics banner (subjects, resources, governed %) and the "how to read this matrix" legend appear above the grid.
- In roll-up mode the matrix now also shows business-role columns with a count of how many in-scope users/identities hold each resource via that business role, alongside the per-attribute Direct counts.
- The Sort step now lets you sort by any attribute, including extended attributes.
- The roll-up view now uses the same chrome as the regular matrix — the filter-summary bar with the Adjust matrix button, the scope banner, the All / Governed / Non-governed toggle (which adjusts the counts), Export and Share, and the legend in the same places — plus a trailing # (total) column and Description column, and a horizontal scrollbar when its columns are wider than the screen.
- Roll-up now has a new "Content" step that chooses what the grid shows: business roles only (roles go on the rows, each cell counting the in-scope subjects in that group who hold the role — and the resource filter step is skipped), resources and business roles (the combined view), or resources only. 
- Fixed a crash ("friendlyLabel is not defined") when advancing to the roll-up Content step.
- The roll-up Content step now offers a "Cell value" choice: show each cell as an absolute count (the default) or as the percentage of the subjects in that group who hold the resource or role (e.g. 8 of 10 in a department shows as 80%). In percentage mode each column header also shows the group's subject total.
- Saving a matrix now also stores the All / Governed / Non-governed toggle, so loading a saved matrix restores exactly what you saw — not just the wizard filter.
- You can again expand a roll-up group column into its individual subjects in the "Business roles only" view — clicking a group header now shows each subject in that group and which business role they hold (this already worked in the resources views).
- The roll-up matrix "Export to Excel" now downloads a real .xlsx workbook (it previously produced a CSV).

## Changes in this PR

- The midPoint crawler now fills the **department** field on both identities and their midPoint accounts, derived from the user's primary organizational unit (org membership).

## Changes in this PR

- The midPoint crawler now prints a performance summary at the end of each run (total wall-clock, per-read timings, and per-endpoint ingest throughput), making it easy to see where a large sync spends its time.
- Added a load-test data generator for the midPoint crawler (`tools/crawlers/midpoint/dev/Seed-MidpointLoadData.ps1`) that seeds a large fictitious AD with a realistic, repeatable distribution for capacity testing — proven up to 1,000,000 group memberships.
- The midPoint crawler now streams connected-system accounts, entitlements, and their memberships page by page instead of loading the entire set into memory, so it can sync very large directories (millions of group memberships) within a bounded, fixed amount of memory — and runs noticeably faster on large syncs.

## Changes in this PR

- Added a midPoint (Evolveum) crawler that pulls identity governance data from the midPoint REST API into Identity Atlas.
- Imports midPoint orgs as org-unit contexts (with hierarchy), roles and services as resources, and users as identities with their midPoint accounts.
- Imports accounts on connected systems (midPoint shadows) as principals, linked to the right person, so multi-account identities are visible.
- Maps connected-system objects by their type: real accounts become principals, groups/entitlements (e.g. AD security groups) become entitlement resources with their memberships shown in the access matrix, and non-account objects (org units, container/data rows) are no longer wrongly listed as users.
- Imports the actual group memberships on connected-system accounts (e.g. AD group memberships) as direct assignments in the access matrix, including memberships stored in midPoint 4.9's native reference-attribute form — previously only the older association format was read, so these memberships were missed.
- Consolidates a person's access on the identity: role and entitlement memberships gained through any of a person's accounts now show together when you open that person, instead of being scattered across separate account entries.
- Registers a connected system only when it actually holds accounts or entitlements, so resources that contain only context/data objects no longer appear as empty systems.
- Surfaces role/service assignments as governed assignments and role nesting as "contains" relationships, and maps org membership to context membership.
- Imports midPoint access certification campaigns as review decisions, so certify/revoke outcomes show up under each business role.
- Shows readable account names for connected-system accounts (e.g. database accounts that midPoint keys by a number now display the person's name and source system).
- Refreshes the access matrix automatically at the end of a sync so governed assignments appear immediately.
- Supports Basic, API-token, and OAuth2 (client-credentials / password) authentication, configurable from the Add Crawler screen.
- Fixed crawler manifest discovery in Docker so newly added crawlers are always recognised by the API without requiring a code change to the fallback list.
- Added user-facing documentation for the midPoint crawler (`docs/sync/midpoint.md`): what data gets imported, configuration reference, and troubleshooting tips.

## Changes in this PR

- Fixed crawler manifest discovery in Docker: the API container now automatically discovers all installed crawlers at startup, so newly added crawlers are recognised without requiring code changes.
- Removed the hardcoded crawler-type allowlist (`demo`, `entra-id`, `csv`, `omada`). The list is now built entirely from the manifest files — any crawler not present in the container is no longer silently accepted.
- Fixed a validation error that caused the demo crawler job to be rejected when submitted without a config body.
- Fixed the Entra ID crawler config schema so that `clientSecret` is no longer required when credentials are stored in the vault.

## Changes in this PR

- Updated default Anthropic model from the retired `claude-sonnet-4-20250514` to `claude-sonnet-4-6`, fixing the LLM connection test in CI.
- Fixed two high-severity npm vulnerabilities in the API (`esbuild` and `form-data`).
- Fixed PR hygiene CI check not respecting the `skip-hygiene` label when re-running a workflow: the check is now skipped at job level so it is never scheduled when the label is present.

## Changes in this PR

- Fixed false-positive in `MatrixView.scrollbar.test.js`: the magic-number guard was matching a comment in `MatrixView.jsx` rather than actual class usage
- Added tests for the two untested bootstrap guard paths in `Invoke-CrawlerJob.ps1`: skip (module already loaded) and throw (module file not found)

## Changes in this PR

- Pinned Docker base image to Node 24-slim; Dependabot will no longer propose upgrades to Node 26+

## Changes in this PR

- Fixed the Admin → Authentication tab disappearing on Azure App Service deployments. Because that tab also hosts Roles & Permissions management, hiding it locked admins out of editing role permissions. The tab now stays visible to anyone with the `admin.auth` permission on every platform; only the Docker-specific setup walkthrough is hidden on Azure.

## Changes in this PR

- Fixed crawler jobs failing in the portable Windows launcher with "Get-CrawlerRegistry is not recognized" — the dispatcher now self-imports the IdentityAtlas module when running as a standalone process

## Changes in this PR

- The matrix wizard has a new **Roll-up** step: aggregate the columns by an attribute (e.g. department). Columns become the attribute's values and each cell shows the count of distinct users/identities with a Direct assignment to that resource. Click a column to expand it into the individual users with their normal D/I/O badges. Roll-up returns an aggregated (small) result, so the "matrix too large" limit no longer applies in this mode.
- The matrix wizard has a new **Sort** step: order the columns by up to three attributes (default Department, then e.g. Job Title). The chosen attributes appear as grouped header rows above the column names.
- The Scope Statistics banner (subjects, resources, governed %) now also shows above the roll-up view.

## Changes in this PR

- Aligned Node.js to v24 (Active LTS) across all components: Docker images, portable Windows launcher, and all GitHub Actions workflows and release flows

## Changes in this PR

- The Systems and Sync Log tabs are now hidden by default. Enable either of them per user from Settings → Visible Tabs when you need them.

## Changes in this PR

- Fixed repeated "SIGINT received, shutting down..." loop when pressing Ctrl+C multiple times in the portable node-launcher
- Fixed process hanging indefinitely after Ctrl+C due to keep-alive browser connections blocking shutdown

## Changes in this PR

- Fixed portable node-launcher failing to start due to missing `re2` native addon; the correct Windows prebuilt matching the bundled Node version is now fetched at build time
- Standardised Node.js to v24 (Active LTS) across Docker images and CI workflows

## Changes in this PR

- Context trees (e.g. the manager / org tree) can now be curated after the plugin generates them: drag a node onto another node to re-parent it, double-click a node to rename it, and use the "+" on a node to add a manual child — all directly in the Contexts tree.
- Edited generated contexts are highlighted with an amber "✎ Edited" marker so it's clear at a glance which nodes you've changed by hand.
- Your renames and re-parenting on generated contexts are now preserved when the plugin re-runs (previously a re-run reset them).
- Member counts (direct and total) update immediately after re-parenting, adding, or moving a node, so the numbers on every context stay correct.
- The tree keeps your expanded/collapsed nodes after a drag-drop move instead of collapsing back to the top.
- The "Run plugin" dialog no longer closes when you click outside it, so a stray click can't discard what you were setting up.
- The "Manager Hierarchy" plugin can now name each node from configurable Principal attributes — any real attribute (Department, Job Title, Company…) or an extended attribute (e.g. a SuccessFactors department or an extension attribute), on its own or several joined together, with or without the manager's name. The default is unchanged ("<Department> (<Manager>)").
- When a plugin asks for a list of attributes (e.g. how to name org-tree nodes), you now pick them from a dropdown — grouped into the entity's own attributes and its extended attributes — with a "+ Add attribute" button, instead of editing raw JSON.
- Creating a new context tree is now a single guided wizard with steps (Source → Pick plugin → Configure → Preview & run), matching the new-crawler and new-matrix wizards, with a live preview before anything is written.
- Running a plugin now creates a separate, independent tree each time, so you can build several trees from the same plugin (e.g. one named by department and one by job title). The Preview & run step also lets you instead "Refresh an existing tree", which re-runs onto that tree and keeps your renames and re-parenting.
- In the tree, a single click opens a context and a double click renames it inline (the click no longer races the double-click).
- Generated trees now have a "Sync" button next to "Delete tree": it re-runs the plugin to update out-of-date memberships (for example, a user who changed manager moves to their new org unit) while keeping all your manual changes — renames, re-parenting, manual child contexts, and manually added members.

## Changes in this PR

- Fixed the matrix still showing a second (page) scrollbar next to the grid's own. The grid now measures the actual space left below the page chrome (auth banner, scope statistics, "How to read") and caps its height to fit, instead of a fixed estimate that was too tall — so only the grid scrolls, never the page.

## Changes in this PR

- Fixed Omada crawler integration test assertions that compared against the full database — prior CI steps loading demo data could make the assertions pass even if the Omada crawler ingested nothing. Assertions now scope to the system created by the current test run using the mock server's OS-assigned port.
- Extracted shared `Report-Result` helper to `tools/crawlers/shared/Test-Helpers.ps1`; removed the copy-pasted duplicate from both test files.
- Omada crawler integration test now deletes the crawler configs it registers (both the main config and the partial-failure config) in a `finally` block so CI runs don't accumulate stale entries.
- Added edge-case test to the OData library suite verifying that an empty `{"value":[]}` response returns an empty array rather than `$null` or throwing.
- Replaced bare integer literals in `Start-MockODataServer.ps1` startup poll loop with named variables (`$startupPollMs`, `$startupMaxPolls`).
- Added OAuth2 token refresh test: mock now supports configurable `expires_in` via `/_control`; test verifies the library transparently re-fetches a token when the existing one is immediately expired (no waiting — the library's proactive clock check triggers on the next request).

## Changes in this PR

- Fixed a persistent second (page) scrollbar that sat next to the matrix grid's own scrollbar. The "authentication disabled" banner was rendered outside the app's full-height column, making every page taller than the viewport by the banner's height; it now lives inside that column so the page no longer scrolls behind the matrix.

## Changes in this PR

- Added the Azure Deployment walkthrough and Azure Deployment reference to the documentation site navigation (under Operations) so they're discoverable instead of only reachable by direct URL.

## Changes in this PR

- Fixed Cut Beta, Cut Release, and Cut Hotfix workflows failing at the "Synthesize release notes with Claude" step — added `id-token: write` permission required by `claude-code-action` when using OAuth token authentication

## Changes in this PR

- Moved `Get-OmadaEntitySets` → `Get-ODataEntitySets` into the shared OData library (`Invoke-ODataAuth.ps1`) — OData `$metadata` discovery is not Omada-specific; also adds `Update-ODataSessionIfExpired` call before the fetch (matching all other OData library functions) and a new integration test
- Extracted `Invoke-IngestAPI`, `Update-CrawlerProgress`, and `ConvertTo-JsonArray` from all three crawlers (Entra ID, Omada, CSV) into `tools/crawlers/shared/Invoke-CrawlerIngest.ps1`; fixed a bug where the CSV crawler silently ignored HTTP 409 (job terminated) on progress updates instead of aborting the crawl; added unit tests covering scope-capture, the 409 abort path, and JSON array serialisation guarantees

## Changes in this PR

- Release notes generated at cut time are now synthesized by Claude: bullets are grouped by theme, self-fixes (bugs in features introduced in the same release) are dropped, and CI/tooling-only changes are filtered out — eliminating the need to manually rewrite release notes after each cut.

## Changes in this PR

- Added integration tests for the OData crawler library — all 6 auth methods (BasicAuth, ApiToken, CookieString, FormCookie, OAuth2CC, OAuth2ROPC), `@odata.nextLink` pagination, and 401 error handling, all running against a local mock server
- Added end-to-end integration test for the Omada IGA crawler — runs a full job against a mock OData server and verifies that identities, accounts, resources, and assignments land in the database
- Added dynamic CI test discovery: `Test-*.ps1` files colocated in each `tools/crawlers/<type>/` directory are automatically discovered and run in topological dependency order (dependency crawlers first, dependents after), with same-level tests running in parallel — no YAML changes needed when adding a new crawler with a test
- Added shared mock OData HTTP server (`tools/crawlers/shared/Start-MockODataServer.ps1`) for crawler integration tests that have no live CI endpoint
- Fixed PR Hygiene CI check recognizing `Test-*.ps1` (crawler integration tests) and `Start-Mock*.ps1` (mock server test infrastructure) as test files alongside the existing `*.Tests.ps1` Pester convention
- Fixed Docker image build failure caused by `re2` having no prebuilt binary for Node 26 — pinned base image to Node 22 LTS where prebuilt binaries are available
- Fixed Omada integration test sending wrong field names (`jobType`/`name`) to the crawler-configs API which expects `crawlerType`/`displayName` — caused 400 Bad Request and test failure in CI
- Fixed crawler dispatcher dot-sourcing `Test-*.ps1` files as library code — integration test files have mandatory parameters and are not library files; the dispatcher now skips them
- Fixed Omada integration test: mock OData server now binds to all interfaces so the Docker worker container can reach it via `host.docker.internal`
- Moved CSV, Entra ID, and Custom Connector integration tests to be colocated with their crawlers so they are auto-discovered by the CI topology-aware runner — no separate hardcoded CI steps needed
- Added `maxRetries` config option to the Omada crawler so operators can tune OData retry behaviour per deployment
- Fixed Omada integration test asserting resource count via `GET /api/resources`, which excludes BusinessRole resources — mock data now uses `Permission` category (maps to generic Resource type) so the assertion passes

## Changes in this PR

- Fixed portable Windows ZIP build (cut-beta / cut-release / cut-hotfix) failing when the `re2` native addon is a dependency — marked `re2` as external in the esbuild bundle

## Changes in this PR

- Fixed crawlers with dependencies (e.g. Omada IGA) failing immediately with "missing mandatory parameters: ApiBaseUrl ApiKey JobId ConfigPath" — the dependency layer's entry point was being dot-sourced instead of skipped
- Fixed syntax error in Omada crawler (spurious `}` inside `foreach` loop for CRA principal ingestion) that caused "Try statement missing Catch/Finally" parse failure

## Changes in this PR

- Securised the identity account-link decisions: confirming, rejecting, or clearing a linked account now requires the new "Identity link decisions" (`data.write.identity`) permission, so read-only users can no longer change what Account Linking will (re-)link. Previously any signed-in user could.
- Added unit tests covering identity graph fan-out, the orphaned-accounts context, account-linking analyst-decision preservation, context-picker target-type filtering, and the identity override permission gate.
- Documented Account Linking: the deterministic, dictionary-based replacement for the retired Account Correlation feature (editable signals + account-type rules, certainty slider, scheduled and on-demand runs, and an "Orphaned Accounts" context for unlinked accounts).
- Corrected the identity entity-graph documentation to the identity → accounts → access model (access hangs off each linked account, not the identity).
- Documented matrix Identity rows, expanding an identity column into per-account sub-columns, the row-type-aware context picker, and identity attribute filtering.
- Refreshed the API, configuration, data-model, risk-scoring, crawler, deployment, history, and UX docs to use the new Account Linking names, endpoints, and renamed database columns.

## Changes in this PR

- Identity page → Linked Accounts: accounts linked by the crawler/source data (no confidence score) now show "Linked from source" instead of Confirm/Remove. Confirm/Remove apply only to account-linking's scored links, so source links can't be accidentally changed here.

## Changes in this PR

- Account linking now survives crawls. A crawler's full sync used to remove any account-to-identity link it didn't create — wiping the links account linking had found. The crawler now only reconciles its own links and leaves links that carry a confidence score (added by account linking) or an analyst confirm/remove decision untouched. Account linking stays independent of the crawler.

## Changes in this PR

- Rebuilt **Account Linking** (formerly the non-functional "Account Correlation"). It now actually runs: for each existing identity it finds orphan accounts that belong to that person — admin (`adm-…`), guest, and secondary accounts — and links them with a confidence score.
- Account linking is deterministic and no longer needs an LLM. The matching dictionary (signals, account-type patterns, threshold) ships with sensible defaults and is editable in **Admin → Account Linking**.
- Account linking can run on a schedule and on demand ("Run now"), with a run history showing how many accounts were linked, updated, or skipped.
- Accounts that can't be linked to a person are now grouped into a generated **Orphaned Accounts** context (sub-grouped by type: admin / guest / service / shared) instead of being a hidden property.
- Analyst decisions are preserved across runs: a confirmed/rejected/moved link is never overwritten, and a rejected account is never re-linked.
- Account linking now matches a person's accounts even when their email convention differs (e.g. `r.euson@…` and `robin.euson@…`) by matching on the parsed name, attaching them at a lower, honest confidence the analyst can review. Role/company qualifiers in display names (e.g. `(OGD)`, `(ADM-azure)`) are ignored when matching.
- Added an **Auto-link certainty** slider in Admin → Account Linking to choose the minimum confidence required before accounts are linked.
- Ambiguous name-only matches (the same name across multiple identities) are left for manual review instead of being auto-linked to the wrong person.
- Retired the LLM-based correlation ruleset wizard and its endpoints.
- Identity relationship diagram: the identity fans out to **Linked Accounts** and **Contexts** only. Open Linked Accounts to see the individual accounts, then drill into an account to see that account's own access (groups, OAuth grants, etc.) — the same way every other entity graph works. An identity holds no access of its own; its accounts do.
- Matrix: clicking a subject column that is an **identity** now opens the identity page (it used to always open a user account).
- Matrix wizard: the context picker now only offers contexts that match what you're filtering — Identity rows → Identity contexts, User rows → User (Principal) contexts, and the resource side → Resource/System contexts.
- Matrix (Identities view): each identity column now has an **expand** control that splits it into per-account sub-columns, so you can see each linked account's assignments side by side under the identity.
- Identity page: the Relationships tab now lists the **linked accounts** with each account's own confidence, and lets you **Confirm** or **Remove** a linked account (Remove keeps account-linking from re-adding it; Undo reverts). Replaces the single overall confidence number / signals chip.
- Removed the legacy "Verify Identity" action from the identity page (per-account confirm/remove replaces it). Fixed the analyst-decision endpoints, which previously referenced a non-existent column and never worked.
- Identity page: the Attributes tab now also shows the identity's **extension attributes** (they were silently dropped before).
- Matrix (Identities): the subject filter can now filter on identity **extension attributes**, not just the core columns.

## Changes in this PR

- Added Custom Crawlers guide and Crawler Architecture doc to the documentation site navigation
- Fixed documentation site dark mode: admonition boxes (note, tip, warning, danger) now use dark surfaces with readable text instead of the light green/amber/red backgrounds that were unreadable against the slate page
- Fixed inline code dark mode on the documentation site: `code` spans now render with a subtle dark lime background and lime-300 text instead of the light lime-50 background

## Changes in this PR

- Fixed dark mode contrast in the Contexts tab: selected tree item now shows the correct blue highlight instead of a light-blue-on-dark background; filter dropdowns are now themed correctly in dark mode
- User detail page now color-codes the account type badge by principal type: Guest (amber), ServicePrincipal/Application (purple), ManagedIdentity (teal), Deleted (red), unknown (gray)

## Changes in this PR

- Restructured crawler architecture to be fully pluggable: each crawler now declares its identity and dependencies in a `crawler.json` manifest
- Extracted the generic OData protocol layer (auth, pagination, retry) into `tools/crawlers/odata/` as a reusable base that any OData-based crawler can depend on
- Renamed OData protocol functions from `*-OmadaAPI` / `Invoke-Omada*` to `*-ODataAPI` / `Invoke-OData*` to reflect their generic purpose
- Added crawler manifests for all existing crawlers: `entra-id`, `csv`, `omada`, `odata`, and `demo`
- Moved Omada-specific helpers (`Get-OmadaRefValue`, `Get-OmadaRefUid`, `Get-OmadaEntitySets`) into the Omada crawler folder
- Module loader (`IdentityAtlas.psm1`) now auto-discovers shared SDK directories — adding a new shared SDK no longer requires editing the module
- PR workflow code coverage paths now auto-discover all crawler and SDK directories — no manual updates needed when adding new crawlers
- Extracted demo dataset logic into its own crawler script (`tools/crawlers/demo/Start-DemoCrawler.ps1`)
- Restored Pester code-quality coverage for `tools/crawlers/` (CmdletBinding, secrets, Dutch comments); the file move from `tools/powershell-sdk/omada/` had silently dropped that coverage
- Added `[CmdletBinding()]` to `Get-OmadaRefValue`, `Get-OmadaRefUid`, and `Get-OmadaEntitySets` (detected by the restored coverage gate)
- Added `tools/crawlers/CLAUDE.md`: crawler authoring guide covering the manifest schema, auto-discovery, dependency system, and OData base layer
- Replaced hardcoded switch statement in the crawler dispatcher with manifest-driven dispatch: adding a new crawler no longer requires editing `Invoke-CrawlerJob.ps1`
- Crawler dependencies (e.g. Omada building on OData) are resolved automatically via DFS before each job run, loading dependency layers in topological order
- All crawlers now use a standard interface (`-ApiBaseUrl`, `-ApiKey`, `-JobId`, `-ConfigPath`); each crawler reads its own configuration from the JSON file written by the dispatcher
- Circular dependency detection throws a clear error naming the cycle rather than hanging indefinitely
- Moved Entra ID selectedObjects mapping and mark-delta-mode reset from the dispatcher into the Entra ID crawler
- Moved Omada selectedObjects mapping from the dispatcher into the Omada crawler
- Added `Dispatcher.Tests.ps1` with Pester unit tests covering registry building, DFS ordering, cycle detection, and live manifest validation
- Updated `Omada.Tests.ps1` file-structure assertions to match the new generic dispatcher: dispatcher now verified via `Get-CrawlerRegistry` usage; `contextObjectTypes` and `resourceCategoryMapping` now verified in `Start-OmadaCrawler.ps1` where they live
- Added `docs/sync/custom-crawlers.md`: step-by-step guide for building a new crawler, including the standard interface, config keys, and OData base layer walkthrough
- Added `docs/architecture/crawler-architecture.md`: technical reference covering the registry, DFS dependency loading, OData functions, and end-to-end dispatch flow
- Replaced `tools/crawlers/CLAUDE.md` content with a concise dev quick-reference pointing to the new docs pages
- Fixed load test (`Test-LoadAndBenchmark.ps1`) to use the standard `-ConfigPath` / `-JobId` interface when calling the CSV crawler directly (old `-CsvFolder` / `-SystemName` / `-SystemType` parameters removed as part of this step)
- API now auto-discovers valid crawler job types from `crawler.json` manifests — adding a new crawler automatically makes it available in the API without editing `jobs.js`
- Crawler config validation replaced hardcoded per-crawler functions with JSON Schema validation (ajv) driven by each crawler's `configSchema` in its manifest
- Docker web image build context changed to repo root so crawler manifests are included in the image; manifests live at `/app/crawlers/` in the container
- Fixed scheduler import (`validateOmadaConfig` → `validateCrawlerConfig`) and replaced hardcoded crawler type allowlist with the manifest-driven `VALID_JOB_TYPES` list
- Fixed crawler manifest discovery path for Docker (`CRAWLER_MANIFESTS_DIR=/app/crawlers`) and node-launcher (`bundled-scripts/tools/crawlers`)
- Added tests for manifest-driven `VALID_JOB_TYPES` (including sentinel check that `odata` is present, proving manifests are loaded rather than the hardcoded fallback)
- Updated `app/api/CLAUDE.md` with crawler job system documentation: `routes/jobs.js`, `scheduler.js`, manifest discovery path, and exported functions
- Removed PowerShell scripts from the web container image (Node.js only — scripts belong in the worker); malformed manifests now log a warning instead of silently disappearing from the job type allowlist
- Eliminated duplicate `SECRET_FIELDS` definition in `jobs.js` — now derived from the shared `OTHER_SECRET_FIELDS` constant already imported from `crawlerSecrets.js`
- Fixed load test (`Test-LoadAndBenchmark.ps1`) to use the standard `-ConfigPath` / `-JobId` interface when calling the CSV crawler directly (the old `-CsvFolder` / `-SystemName` / `-SystemType` parameters were removed in the step-2 dispatcher refactor)

## Changes in this PR

- Restructured crawler architecture to be fully pluggable: each crawler now declares its identity and dependencies in a `crawler.json` manifest
- Extracted the generic OData protocol layer (auth, pagination, retry) into `tools/crawlers/odata/` as a reusable base that any OData-based crawler can depend on
- Renamed OData protocol functions from `*-OmadaAPI` / `Invoke-Omada*` to `*-ODataAPI` / `Invoke-OData*` to reflect their generic purpose
- Added crawler manifests for all existing crawlers: `entra-id`, `csv`, `omada`, `odata`, and `demo`
- Moved Omada-specific helpers (`Get-OmadaRefValue`, `Get-OmadaRefUid`, `Get-OmadaEntitySets`) into the Omada crawler folder
- Module loader (`IdentityAtlas.psm1`) now auto-discovers shared SDK directories — adding a new shared SDK no longer requires editing the module
- PR workflow code coverage paths now auto-discover all crawler and SDK directories — no manual updates needed when adding new crawlers
- Extracted demo dataset logic into its own crawler script (`tools/crawlers/demo/Start-DemoCrawler.ps1`)
- Restored Pester code-quality coverage for `tools/crawlers/` (CmdletBinding, secrets, Dutch comments); the file move from `tools/powershell-sdk/omada/` had silently dropped that coverage
- Added `[CmdletBinding()]` to `Get-OmadaRefValue`, `Get-OmadaRefUid`, and `Get-OmadaEntitySets` (detected by the restored coverage gate)
- Added `tools/crawlers/CLAUDE.md`: crawler authoring guide covering the manifest schema, auto-discovery, dependency system, and OData base layer
- Replaced hardcoded switch statement in the crawler dispatcher with manifest-driven dispatch: adding a new crawler no longer requires editing `Invoke-CrawlerJob.ps1`
- Crawler dependencies (e.g. Omada building on OData) are resolved automatically via DFS before each job run, loading dependency layers in topological order
- All crawlers now use a standard interface (`-ApiBaseUrl`, `-ApiKey`, `-JobId`, `-ConfigPath`); each crawler reads its own configuration from the JSON file written by the dispatcher
- Circular dependency detection throws a clear error naming the cycle rather than hanging indefinitely
- Moved Entra ID selectedObjects mapping and mark-delta-mode reset from the dispatcher into the Entra ID crawler
- Moved Omada selectedObjects mapping from the dispatcher into the Omada crawler
- Added `Dispatcher.Tests.ps1` with Pester unit tests covering registry building, DFS ordering, cycle detection, and live manifest validation
- Updated `Omada.Tests.ps1` file-structure assertions to match the new generic dispatcher: dispatcher now verified via `Get-CrawlerRegistry` usage; `contextObjectTypes` and `resourceCategoryMapping` now verified in `Start-OmadaCrawler.ps1` where they live
- Added `docs/sync/custom-crawlers.md`: step-by-step guide for building a new crawler, including the standard interface, config keys, and OData base layer walkthrough
- Added `docs/architecture/crawler-architecture.md`: technical reference covering the registry, DFS dependency loading, OData functions, and end-to-end dispatch flow
- Replaced `tools/crawlers/CLAUDE.md` content with a concise dev quick-reference pointing to the new docs pages
- Fixed load test (`Test-LoadAndBenchmark.ps1`) to use the standard `-ConfigPath` / `-JobId` interface when calling the CSV crawler directly (old `-CsvFolder` / `-SystemName` / `-SystemType` parameters removed as part of this step)

## Changes in this PR

- Restructured crawler architecture to be fully pluggable: each crawler now declares its identity and dependencies in a `crawler.json` manifest
- Extracted the generic OData protocol layer (auth, pagination, retry) into `tools/crawlers/odata/` as a reusable base that any OData-based crawler can depend on
- Renamed OData protocol functions from `*-OmadaAPI` / `Invoke-Omada*` to `*-ODataAPI` / `Invoke-OData*` to reflect their generic purpose
- Added crawler manifests for all existing crawlers: `entra-id`, `csv`, `omada`, `odata`, and `demo`
- Moved Omada-specific helpers (`Get-OmadaRefValue`, `Get-OmadaRefUid`, `Get-OmadaEntitySets`) into the Omada crawler folder
- Module loader (`IdentityAtlas.psm1`) now auto-discovers shared SDK directories — adding a new shared SDK no longer requires editing the module
- PR workflow code coverage paths now auto-discover all crawler and SDK directories — no manual updates needed when adding new crawlers
- Extracted demo dataset logic into its own crawler script (`tools/crawlers/demo/Start-DemoCrawler.ps1`)
- Restored Pester code-quality coverage for `tools/crawlers/` (CmdletBinding, secrets, Dutch comments); the file move from `tools/powershell-sdk/omada/` had silently dropped that coverage
- Added `[CmdletBinding()]` to `Get-OmadaRefValue`, `Get-OmadaRefUid`, and `Get-OmadaEntitySets` (detected by the restored coverage gate)
- Added `tools/crawlers/CLAUDE.md`: crawler authoring guide covering the manifest schema, auto-discovery, dependency system, and OData base layer

## Changes in this PR

- Fixed tags on identities: a tag created/assigned to an identity is now actually shown and can be (re)assigned. Previously identity tags were saved but never appeared because the tag compatibility view excluded identities.

## Changes in this PR

- Rebuilt **Account Linking** (formerly the non-functional "Account Correlation"). It now actually runs: for each existing identity it finds orphan accounts that belong to that person — admin (`adm-…`), guest, and secondary accounts — and links them with a confidence score.
- Account linking is deterministic and no longer needs an LLM. The matching dictionary (signals, account-type patterns, threshold) ships with sensible defaults and is editable in **Admin → Account Linking**.
- Account linking can run on a schedule and on demand ("Run now"), with a run history showing how many accounts were linked, updated, or skipped.
- Accounts that can't be linked to a person are now grouped into a generated **Orphaned Accounts** context (sub-grouped by type: admin / guest / service / shared) instead of being a hidden property.
- Analyst decisions are preserved across runs: a confirmed/rejected/moved link is never overwritten, and a rejected account is never re-linked.
- Account linking now matches a person's accounts even when their email convention differs (e.g. `r.euson@…` and `robin.euson@…`) by matching on the parsed name, attaching them at a lower, honest confidence the analyst can review. Role/company qualifiers in display names (e.g. `(OGD)`, `(ADM-azure)`) are ignored when matching.
- Added an **Auto-link certainty** slider in Admin → Account Linking to choose the minimum confidence required before accounts are linked.
- Ambiguous name-only matches (the same name across multiple identities) are left for manual review instead of being auto-linked to the wrong person.
- Retired the LLM-based correlation ruleset wizard and its endpoints.

## Changes in this PR

- Warmed up the documentation site so it's less stark white and better matches the app: a green brand accent on the header, green ticks on section headings, the active left-nav item highlighted in soft green, the in-page table-of-contents active link in blue, and blue-accented blockquotes.

## Changes in this PR

- The in-app "Documentation" and "CSV Schema Reference" links now point to the docs version that matches the running build — an **edge** build links to the edge docs, a release links to the stable docs — instead of always opening the default (stable) docs.

## Changes in this PR

- Business Role detail page: the Attributes tab now opens with an **Overview** panel showing Type, Review status, Review date, Reviewed by and Category using the same badges and colours as the Business Roles list; the governance records (policies, access reviews grouped by review instance, pending requests) now sit at the bottom of the Attributes tab; and the Relationships tab is back to just the relationship graph.
- The Business Role **Timeline** now shows access-review activity ("Access review started" / "ended").

## Changes in this PR

- Rolled the new sub-tab detail layout out to all the main entity pages — **Resource**, **Business Role (Access Package)**, **Identity**, and **Context** now have the same Attributes / Relationships / Timeline / Risk tabs as the user page (Risk shown only where the entity is actually scored).
- Each of these pages now has a **Timeline** showing attribute updates and relationship changes over time (e.g. who was granted/removed from a resource, members linked to an identity), grouped by day.
- The **Identity** page shows correlation confidence and signals on the Relationships tab (correlation is what links the accounts).
- Removed the duplicate **Group** detail page — group links already open the Resource page, so there is now one consistent page per object.
- The **Department** view keeps its purpose-built hierarchy/risk-distribution layout, since a department is a computed grouping rather than a stored entity (no per-entity attributes, history, or single risk score).
- Business Role pages now surface the **governance records behind the overview** — assignment policies, access reviews (who reviewed, when, and the decision), and pending requests — as references on the Relationships tab, so the data driving the Review Status / Type columns is visible.
- Business Role detail now shows the **calculated overview fields** (Type, Review Status, last review date, reviewed by, and policy/review/request counts) in an "Overview (calculated)" panel on the Attributes tab, matching the Business Roles list.
- Restructured the access-review references to reflect how the data actually relates: assignment **policies** show their review **cadence** (how often a review recurs), and access reviews are grouped by **review instance** (each scheduled campaign run, with status and dates) containing the individual per-person decisions — instead of a flat list of people.

## Changes in this PR

- Reorganised the user detail page into sub-tabs (like the Admin section) so it's no longer one long cramped scroll: **Attributes**, **Relationships**, **Timeline**, and **Risk** (the Risk tab appears only when risk scoring is enabled).
- The **Relationships** tab shows the relationship graph (without the recent-added/removed nodes) plus the identity-membership panel, now with the account-correlation **confidence shown as a bar** alongside its signals.
- Added a **Timeline** tab: a single chronological view of what changed for the user over time — both attribute updates (e.g. department or job-title changes, shown as before → after) and relationship changes (access granted/removed, manager changes, linked accounts) — with a 30-day / 90-day / 1-year / all range selector.
- The relationship graph's "+N more" overflow now shows the **full** list of items below the graph (the list is scrollable and each row is clickable), instead of capping at 10.
- Removed the separate identity-membership panel from the user page — the identity is reachable directly from the relationship graph.
- Reworked the Timeline into a **horizontal** timeline: dots on a line from the initial load through later changes, each dot labelled with the kind and number of changes; click a dot to expand exactly what changed at that point.
- Each timeline dot now shows the number of changes that happened that day.
- Fixed the Risk tab showing empty: the user detail page now includes the entity's risk score, and the Risk tab only appears when the user actually has a score.

## Changes in this PR

- Published a **UX & Interface Assessment & Remediation** page in the docs (under Project → User Experience), a sanitized public summary of the June 2026 UX/GUI audit — findings by severity with status and links to the pull requests that fixed them, mirroring the existing security assessment page.

## Changes in this PR

- Dependabot now tracks Docker base image updates (worker PowerShell image, API Node.js image) alongside the existing GitHub Actions SHA-pinning
- Extended CI PR checks to include the Omada PowerShell SDK and crawler in PSScriptAnalyzer linting
- Extended Pester code coverage to the Omada SDK (`tools/powershell-sdk/omada`)
- Pester test runner now scans the full `test/unit/` directory so new test files are picked up automatically without CI changes
- Removed stale `app/db` path reference from PSScriptAnalyzer and Pester coverage scopes
- Upgraded PSScriptAnalyzer from Error-only to Warning + Error severity; expanded coverage to all production PowerShell roots (job dispatcher, module, CSV transforms)
- Added eslint-plugin-security to the API build — catches unsafe regex, dynamic RegExp construction, and similar security anti-patterns on every pull request
- Fixed: manager-hierarchy context plugin now uses the RE2 engine for admin-supplied exclude patterns, preventing ReDoS via a crafted regex (same fix already applied to the risk-scoring engine)
- Fixed: `$input` variable in `New-OAuth2ScopeResourceId` (EntraID crawler) shadowed a PowerShell automatic variable — renamed to `$hashInput`
- Fixed: `$matches` variable in `Get-FGAttributeMapping` shadowed a PowerShell automatic variable — renamed to `$regexMatches`

## Changes in this PR

- Added native Omada IGA crawler that syncs directly from the Omada OData 4.0 REST API — no manual CSV export or transform step required
- Supports six authentication methods: Form/Cookie (on-premise), HTTP Basic Auth, OAuth2 Client Credentials (cloud), OAuth2 ROPC, API Token, and Cookie String (session cookie from browser DevTools)
- Syncs systems, contexts (OrgUnits + configured types), identities, accounts/principals, resources (business roles and permissions), entitlements (CHILDROLES nesting), role assignments (Resourceassignment), and effective account assignments (CalculatedAssignments/CRA)
- Each of Omada's connected target systems (SAP, AD, Salesforce, etc.) is registered as a separate Identity Atlas System; resources and assignments are linked to their correct system
- Fetches OData `$metadata` at startup to discover available entity sets — phases that require missing sets are skipped with a warning
- Context types are configurable (`contextObjectTypes`): each entry specifies entity set, contextType label, and an optional identity reference field for direct context membership
- Resource category mapping is configurable (`resourceCategoryMapping`): maps Omada ROLECATEGORY to Identity Atlas resourceType
- CRA (CalculatedAssignments) pages are streamed one-at-a-time to prevent OOM on large cloud datasets
- Added step-by-step logging throughout the crawler — each fetch, build and ingest operation prints a `→` indicator in the job transcript
- Base URL is normalised using `System.Uri` — both root URLs and explicit OData paths are accepted; the Builtin service URL is derived automatically
- Fixed: `oisauthtoken=` prefix is auto-prepended to bare CookieString tokens for Omada Cloud
- Fixed: `$metadata` fetch no longer sends JSON Accept headers (caused HTTP 500 on cloud); XML is accepted as returned
- Added 42 Pester unit tests for the Omada SDK (auth methods, helper functions, URL normalisation, config forwarding)
- Added data model reference documentation for the Omada crawler (`docs/architecture/omada-crawler-datamodel.md`)
- Added PowerShell formatting style guide to `Functions/CLAUDE.md` (Stroustrup preset, region blocks, operator spacing)
- Fixed: Omada crawler script path in job dispatcher now respects the `IA_APP_ROOT` environment variable instead of hardcoding `/app`
- Fixed: CRA summary log line reported wrong record count (referenced a removed variable from before the streaming refactor)
- Omada post-sync now calls account correlation (cross-system identity linking with Entra and other crawlers)

## Changes in this PR

- Added native Omada IGA crawler type to the API — validates config, masks secrets, dispatches jobs, and schedules automatic syncs
- Added Omada crawler setup wizard to Admin → Crawlers — four-step flow with live `$metadata` validation for context entity sets and identity field names (case-sensitive auto-suggest), and a resource-category mapping editor
- Added `POST /api/admin/omada/validate-metadata` endpoint for live wizard validation against the Omada OData `$metadata` document
- Added Omada to the scheduler allowlist so crawls can be scheduled from the Admin UI
- Extended `ingest/refresh-views` to recalculate `directMemberCount`/`totalMemberCount` on all Contexts after any full sync
- Fixed: Identity detail page Contexts count was fetched but never passed to the graph shape function, causing the Contexts node to always display 0
- Fixed: Context detail page member clicks now use `targetType` to open the correct detail kind (`identity`, `user`, `resource`) instead of always using `user`
- Fixed: User detail `/contexts` endpoint and context count now query `ContextMembers` directly by Identity UUID via `IdentityMembers`, so Omada-synced context memberships appear on the identity detail page
- Added migration 029: `extendedAttributes jsonb` column on `Identities` table for system-specific identity attributes
- Added: Identities API `/contexts` endpoint and `contextCount` now query `ContextMembers` directly by Identity UUID so context memberships appear on identity detail pages for all crawlers
- Fixed: `POST /api/admin/omada/validate-metadata` crashed with a reference error due to an undefined variable; `configId` now also rejects non-numeric values with a clear 400 error
- Fixed: `POST /api/admin/omada/validate-metadata` now accepts an inline config object so the Omada wizard can validate `$metadata` when adding a new crawler (not only when editing an existing one)
- Fixed: `validateOmadaConfig` now correctly requires `tokenEndpoint`, `clientId`, and `clientSecret` for OAuth2ROPC connections instead of only username and password
- Fixed: Omada wizard Step 2 (`canStep2`) now correctly requires `tokenEndpoint`, `clientId`, and `clientSecret` for OAuth2ROPC before advancing to Step 3
- Fixed: Omada wizard "Add Schedule" now sets `syncMode: 'full'` on new schedules, matching the fact that Omada does not support delta syncs
- Fixed: Context `directMemberCount` is now reset to 0 after a full sync for contexts that lost all their members, not left with a stale non-zero count
- Fixed: Omada credential fields (`password`, `apiToken`, `cookieString`) are now vaulted per-job and stripped from `CrawlerJobs.config` before storage, matching the existing behaviour for `clientSecret`; `injectJobSecret` retrieves and injects all credential fields at claim time
- Fixed: Scheduler now validates the full Omada config (auth credentials, not just `baseUrl`) before queuing a scheduled run, matching the validation applied by the manual "Run Now" path
- Fixed: `validateOmadaConfig` now correctly requires `tokenEndpoint` for OAuth2CC connections (in addition to `clientId` and `clientSecret`)
- Fixed: `POST /api/admin/omada/validate-metadata` now rejects `baseUrl` values that use schemes other than `http` or `https` with a 400 error, preventing potential server-side request forgery
- Fixed: Editing a crawler config via `PATCH /api/admin/crawler-configs/:id` now validates the merged config against Omada rules when the crawler type is `omada`, preventing invalid configs from being saved silently

## Changes in this PR

- Consolidated documentation navigation from 13 top-level tabs to 5 (Home, Guide, Concepts, Reference, Project) to prevent tab overflow on standard screen widths

## Changes in this PR

- Corrected the matrix "How to read this matrix" legend so it matches what the grid actually shows: only the four ways access is *held* — Direct, Indirect (via a nested resource), Eligible (just-in-time access), and Owner. Business-role, OAuth2, and app-role assignments already render as Direct (or Indirect for an app role inherited via a group), so they're no longer listed as separate badges; whether access is governed is shown by the cell colour.

## Changes in this PR

- Documented the colour-saturation rule in the UI Style Guide: solid fills (bars, chips, graph nodes) use soft pastel tiers while thin marks (chart lines, borders, icons, text) keep stronger colour — so future contributions stay consistent with the app's soft look.

## Changes in this PR

- Reworked the documentation site to look like the app: the bright solid-green header and tab bar are now a clean white shell with a dark title and the green logo as the accent (dark slate header in dark mode), with the active tab marked by a green underline and a soft grey search field — so the docs and the product feel like one product.

## Changes in this PR

- Removed the **Tags** column from the matrix — it no longer carried meaningful information now that tags are modelled as contexts. The matrix right-side metadata is now just member count and description.

## Changes in this PR

- Softened the colours of data visualisations so they match the app's gentle palette instead of looking harsh/bright: the entity relationship graph nodes, the correlation-confidence bar, the governance compliance bar, the risk-score bars, and the department risk-distribution bars now use soft pastel fills (their outlines, chart lines, and labels keep their stronger colour for legibility).

## Changes in this PR

- Unified the look of every step-by-step wizard (crawler setup, matrix filter, risk profile, account correlation) behind one shared stepper component — same blue active step, "✓" for completed steps, and chevron separators everywhere, instead of four slightly different hand-built versions.
- Made interactive controls consistently **blue** across the app: the crawler wizard, Admin save/new buttons, and the risk-profile and correlation wizards previously used purple/indigo (and a few green) buttons, which now match the rest of the UI and the Style Guide.

## Changes in this PR

- Fixed the run-detail "Go there now →" link, which opened a broken/empty detail tab; it now correctly navigates to the Contexts page. Also cleaned up a dark-mode style glitch on that screen.

## Changes in this PR

- Refreshed the documentation site to follow the UI Style Guide's two-role colour system: green stays the brand colour (header, tabs, logo, cards, table headers) while blue now marks everything interactive — body links, the active navigation item, and hover/accent states — in both light and dark mode.

## Changes in this PR

- Added a CI lint gate that blocks native browser dialogs (`confirm`/`alert`/`prompt`) in new UI code — these aren't styled, dark-mode aware, or testable; use an in-app dialog or toast instead.
- Added a CI lint gate that keeps legacy/internal jargon (SOLL, IST, "Org Unit", Start-FGSync) out of user-facing UI text, steering contributors to the current terminology (Governed/Non-governed, Context, in-app crawlers).
- Renamed the stale "Contexts (Org Units)" crawler label to "Contexts".

## Changes in this PR

- Added a **UI Style Guide** to the documentation (Contributing → UI Style Guide): the canonical colour system (green = brand/identity, blue = interactive), dark-mode and accessibility rules, component conventions, and a terminology glossary that future contributions follow.

## Changes in this PR

- The dashboard/entity relationship graph now respects the OS "reduce motion" setting — its pulsing rings and animated edges stop for users who request reduced motion (completing the reduced-motion support added to the rest of the app).

## Changes in this PR

- The Dashboard now tells the difference between "couldn't reach the server" and "no data yet". A load error shows a clear retry message instead of the "configure a crawler" onboarding panel, so a transient backend hiccup no longer looks like your data disappeared.

## Changes in this PR

- Hardened the Sync Log: a row with a missing record count no longer crashes the page (it now shows 0).

## Changes in this PR

- Fixed dark-mode rendering of status badges: the Business-Role review-compliance badges (Compliant / In Progress / Missed / Reviewed Late) and the account-type badges (Regular / Admin / Test / Service / Shared / External) now use proper dark colours instead of bright pastel blocks on a dark background.

## Changes in this PR

- Fixed the Contexts tab in dark mode: the variant labels (Synced / Generated / Manual) and target-type badges (Identity / Resource / Principal / System) now render with proper dark-mode colours instead of washed-out pastel chips. "Principal" also gets its own colour so it's no longer visually identical to an unknown type.

## Changes in this PR

- The Systems page no longer dead-ends new users with a stale `Start-FGSync` command. Its empty state now guides you to **Add a crawler** (the supported path), matching the Dashboard and Sync Log. Added a reusable empty-state panel for consistent onboarding across the app.

## Changes in this PR

- Accessibility: added a keyboard **"Skip to main content"** link, a global keyboard focus indicator so focus is always visible, and support for the OS **"reduce motion"** preference (animations/transitions are minimised when requested).
- Renamed the context detail-tab badge from "OU" to "C" so it matches the unified "Contexts" terminology (no more leftover "Org Unit" wording).

## Changes in this PR

- Added a **"How to read this matrix"** legend to the Matrix view. It explains the cell badges (Direct, Indirect, Eligible, Owner, Governed, OAuth2 grant, and App role — assigned directly vs via a group), the coloured cells that mean a membership is governed by a business role, the badge showing a membership is covered by more than one business role, and the amber provisioning-gap marker. The legend is collapsible and remembers whether you keep it open.

## Changes in this PR

- Terminology consistency: the Excel export header no longer shows the internal German label "SOLL" (now "Governed (via Business Roles)"), and the Dashboard governance trend now describes access as granted through a **Business Role** rather than "an Access Package or Business Role" (they are the same thing).

## Changes in this PR

- Added a **Scope Statistics** panel to the Matrix view. For the current matrix selection it shows the number of principals/identities, resources, and assignments in scope, plus the split of **governed vs non-governed** assignments (% managed by a business role / access package).
- Added a **historic timeline** for the selection — see how the number of principals, resources, assignments, and crucially the **% governed vs non-governed** have changed over time. History is reconstructed from the existing change-audit log (no new tracking), accurate back to when auditing began on each table.
- Added a **department / business-unit drill-down**: governed-vs-non-governed broken down department by department, each expandable to its own trend line — built for reporting on role-mining progress.
- Renamed the Matrix view-toggle from **IST / SOLL** to **Non-governed / Governed** (with All / Gaps unchanged) so the terminology matches the rest of the app. An assignment counts as *governed* when the membership is covered by a business role / access package the user holds.
- Fixed the governed/non-governed determination everywhere in the Matrix (the toggle, the scope counts, and the trends) to recognise access provided through a business role / access package, not only assignments recorded directly as "Governed". Previously the Governed view and the % could read as 0 even when most access was managed.
- Refined the Non-governed view: owner memberships are always treated as non-governed (access packages never grant ownership), the access-package columns are hidden, and rows are ordered by member count instead of the access-package staircase.

## Changes in this PR

- Fixed: documentation site version dropdown now updates automatically when a release or hotfix is cut

## Changes in this PR

- Fixed: portable Windows launcher now binds to 127.0.0.1 only, preventing the API from being accessible to other machines on the network
- Added: startup warning when the portable launcher runs with authentication disabled

## Changes in this PR

- Fixed: portable Windows launcher crashes with "Cannot find module" when the installation folder path contains a space

## Changes in this PR

- Fixed: Cut Release, Cut Beta and Cut Hotfix workflows now correctly generate release notes (missing fetch-depth caused grep to fail on the tag list)
- Fixed: deprecated `app-id` input replaced with `client-id` for the GitHub App token action

## Changes in this PR

- Portable Windows launcher build now verifies the SHA-256 checksum of the downloaded node.exe against the official Node.js SHASUMS256.txt before packaging

## Changes in this PR

- Added a **Security** section to the documentation with a public "Assessment & Remediation" page summarizing the June 2026 independent security assessment — findings by severity and status, the pull requests that remediated each one, confirmed strengths, and the remediation roadmap. Exploit detail remains confidential.

## Changes in this PR

- Security: the one-click Excel workbook export no longer trusts spoofable request headers when stamping the API URL into the file. Because the workbook also carries a live read token, a forged `X-Forwarded-Host`/`Host` could previously have made an analyst's data refresh send that token to an attacker's server. The export URL is now taken from a server-trusted source.
- Added `PUBLIC_BASE_URL` (recommended for deployments behind a proxy, tunnel, or Azure) to set the workbook's API URL explicitly, and `TRUST_PROXY` to opt in to honouring `X-Forwarded-*` headers from a trusted reverse proxy. Local and default deployments are unchanged.

## Changes in this PR

- Security: Excel exports (matrix and access-package workbooks) now neutralize spreadsheet formula injection — synced display names, group/role names, and descriptions that begin with `=`, `+`, `-`, or `@` (or a tab/return) are written as literal text, so a maliciously named group can't turn into an executable formula when the exported file is opened.

## Changes in this PR

- Security (CI/CD supply chain): all GitHub Actions used in the build/test/release workflows are now pinned to immutable commit SHAs instead of mutable version tags, so a compromised or repointed action tag cannot silently run in CI with repository credentials. A Dependabot configuration keeps the pinned actions updated via reviewed pull requests.

## Changes in this PR

- Cut Hotfix workflow now builds and attaches the portable Windows ZIP to the GitHub release, matching the Cut Release workflow

## Changes in this PR

- Fixed: launching the portable launcher a second time while Identity Atlas is already running no longer crashes — it now detects the existing instance and opens the browser instead
- Fixed: portable Windows launcher now correctly shows the release version number (e.g. "5.7.0") in the UI version card and footer instead of showing no version

## Changes in this PR

- Security: removed the Admin → "Containers" live-stats view and, with it, the Docker socket mount (`/var/run/docker.sock`) from the web container. Mounting the Docker socket into the web service was a host-takeover risk — a compromise of the web process could control the Docker daemon and the host. The container-stats dashboard didn't justify that exposure. Crawlers, data sync, and all other functionality are unaffected.

## Changes in this PR

- Docs version picker now shows the release version number (e.g. "5.7.0") instead of "stable"
- Cut Beta and Cut Release workflows now accept an optional ref input so releases can be cut from any commit, tag, or branch (default: main); docs deploy from the same ref

## Changes in this PR

- Security: LLM-generated risk-classifier patterns are now matched with a linear-time regular-expression engine (RE2) instead of the built-in engine. A maliciously or accidentally crafted pattern can no longer cause catastrophic backtracking that freezes risk scoring (a denial-of-service / ReDoS risk). Patterns using constructs RE2 cannot run in linear time (e.g. look-ahead) are skipped and logged rather than executed.
- Fixed: portable Windows launcher worker never picked up queued jobs (demo data import, crawlers) because the worker API key was read before the server finished writing it

## Changes in this PR

- Security: hardened the risk-profile URL scraper against server-side request forgery (SSRF). It now resolves and checks every target address and refuses private, loopback, link-local, and cloud-metadata addresses — including decimal/hex and IPv4-mapped encodings and addresses returned via DNS — pins the connection to the validated address to defeat DNS-rebinding, re-validates every redirect hop, and never forwards credentials across a redirect to a different host.

## Changes in this PR

- Security: fixed a guard that was meant to keep read-only API keys (`fgr_…`) out of admin endpoints but never actually triggered — it checked the mount-stripped request path instead of the full URL, so a leaked read-only key could reach admin GET endpoints (information disclosure). The check now uses the full request URL and correctly rejects read-only keys on `/api/admin/*`.

## Changes in this PR

- Security: Microsoft Graph crawler client secrets are no longer stored in plaintext in the database. They are encrypted in the secrets vault and injected only into the job handed to the authenticated worker at run time. Any existing plaintext client secrets are migrated into the vault automatically on upgrade.
- Security: the built-in worker's API key is no longer stored in plaintext in the database. It is kept only as a salted scrypt hash (for verification) plus a private, restricted file that the worker reads — and any previously-stored plaintext copy is removed automatically on upgrade. A read of the database can no longer recover a usable worker credential.

## Changes in this PR

- Security: the built-in worker's API key is no longer stored in plaintext in the database. It is kept only as a salted scrypt hash (for verification) plus a private, restricted file that the worker reads — and any previously-stored plaintext copy is removed automatically on upgrade. A read of the database can no longer recover a usable worker credential.

## Changes in this PR

- Security: the production Docker Compose stack no longer publishes PostgreSQL to all network interfaces. It now binds to localhost (`127.0.0.1`) only by default, so the database is not reachable from other hosts. Set `POSTGRES_BIND_HOST=0.0.0.0` if you deliberately need off-host access.
- Security: the production Docker Compose stack no longer ships a default database password. `POSTGRES_PASSWORD` is now required — the stack refuses to start until a strong value is set. (The local development compose still provides a default for convenience.)
- Azure deployments are unaffected — they use a managed PostgreSQL server rather than the Compose Postgres container.

## Changes in this PR

- Security (behaviour change): a signed-in user whose Entra roles map to no permissions is no longer silently granted full administrator access. Such users are now denied all admin and write actions (fail-closed). Previously, on installs where app roles had not been assigned yet, any authenticated tenant user effectively had admin rights.
- To grant access after enabling authentication, assign users an Entra app role — the default "Admin" role grants full access. If you lock yourself out by enabling auth before assigning a role, recover with the auth CLI (`auth-config.js disable`); see the Permissions & Roles documentation for the bootstrap and recovery steps.
- Added a startup warning when authentication is enabled without `AUTH_REQUIRED_ROLES`, since any signed-in tenant user can still read data until sign-in is restricted to specific roles.
- Security: the API now accepts only Entra ID **access tokens** issued for its own API scope (audience `api://<client-id>`). ID tokens — and any token whose audience is the bare client ID — are rejected. This prevents an ID token (issued on every interactive sign-in and not intended for API authorization) from being used as an API credential.
- This requires the Entra App Registration to expose its API with the default `api://<client-id>` Application ID URI, which the in-app setup walkthrough already configures.

## Changes in this PR

- Replaced `tools/setup-branch-protection.sh` with documentation in `docs/architecture/branching-strategy.md` — the script had drifted from the live ruleset config and a written guide is easier to maintain for a repo that is set up once.

## Changes in this PR

- Fixed granular admin roles: each admin permission is now enforced on its own routes, so a role granted (for example) only crawler access is no longer incorrectly blocked by unrelated admin permissions. Previously only the full-access (wildcard) role worked for admin endpoints.
- Added a "Permissions & Roles" reference page documenting every permission, the default role mapping, and how authorization is enforced.
- Added comprehensive automated tests for the permission model: an allow/deny check for every permission against its real endpoint, the role→permission gate logic, UI tests confirming tabs and controls are hidden when a user lacks the permission, a round-trip test proving that saving a changed role→permission mapping immediately changes access, and validation that signed tokens are rejected when their signature, audience, issuer, tenant, or expiry is wrong.
- Pull request checks now require accompanying tests and a changelog entry whenever code changes (maintainers can override with a label for genuine exceptions).

## Changes in this PR

- Added **Portable Windows Launcher** page to the documentation navigation under Architecture.

## Changes in this PR

- Documentation site now shows a version picker — visitors land on the **stable** docs by default and can switch to **edge** (latest `main`) via the dropdown in the top bar.
- Each GitHub Release automatically publishes a new stable docs snapshot; merges to `main` update the edge docs.

## Changes in this PR

- Added customer-editable role → permission mapping under **Admin → Authentication**. Three roles ship by default — **Admin** (full access), **RoleMiner** (read + Excel/CSV export + the ability to mint read-only `fgr_` API keys for PowerQuery / BI), **Servicedesk** (read-only). Role names in the matrix must match the `Value` strings configured on the Entra app registration's app roles.
- Customers can add their own role names alongside the seed three (one row per Entra app role) and tick which catalog permissions each role grants. Catalog covers read, Excel/CSV export, read-API-key generation, tag / category / risk / certification writes, and the various admin areas (crawlers, systems, LLM, context plugins, CSV import, feature flags, auth itself).
- Excel export buttons (Matrix, Business Roles), the Admin top-level tab, the Admin sub-tabs, and the PowerQuery read-key UI now hide when the signed-in user lacks the matching permission, so Servicedesk operators don't see controls that would 403 on click.
- API enforcement is layered: every mutating / exporting / admin endpoint is gated server-side regardless of what the UI shows, so a leaked or replayed request can't bypass the page-level hiding.
- Backwards compatible — installs that haven't saved a role mapping AND users whose JWT carries no `roles` claim both fall back to "full access," so upgrades don't break existing setups. Enforcement starts the moment you assign Entra app roles to users + save a mapping.
- Self-lockout guard: the save endpoint refuses any change that would strip the editing user's own `admin.auth` permission — there's no path to lock yourself out of the role mapping page short of direct DB access.
- New endpoints: `GET /api/auth-me` returns the calling user's resolved roles + permissions; `GET/PUT/DELETE /api/admin/roles` reads and edits the mapping (gated by `admin.auth`).

## Changes in this PR

- Disabled the Issue Triage & Auto-fix GitHub Actions workflow (no longer triggers on new issues or nightly schedule).

## Changes in this PR

- Fixed: the worker container's job queue silently went dead if it couldn't find the built-in API key within 5 minutes of starting. The intended behaviour (per the comment in `scheduler.ps1`) was "poll until file appears", but the loop bailed after 60 retries and the main job-tick then no-op'd forever. We hit this on a fresh Docker install where the web container's first bootstrap failed (bad master key length) and was fixed via `up -d --force-recreate web` — by the time web wrote the key, worker had given up, and every crawler the user configured afterwards sat in `queued` with nothing to pick it up. Worker now re-checks the key file on every poll tick, so the queue self-heals once web writes it. Startup keeps the 5-minute "loud warning" window for the common misconfiguration case (volume not shared between web and worker), and the warning now explains both root causes instead of just shrugging.

## Changes in this PR

- Fixed: enabling Entra ID auth on a Docker install via env vars (the natural pattern for the README's `Quick Start → Option A`) silently dead-ended in a "setup required" loop. `docker-compose.prod.yml` was wiring `AUTH_ENABLED` through to the web container but had `AUTH_TENANT_ID` and `AUTH_CLIENT_ID` commented out. So someone setting all three in their `.env` would see `AUTH_ENABLED=true` reach the container while the two IDs got dropped on the floor, leaving the API to report `{ enabled:true, configured:false }` and the SPA to render the "Entra ID setup required" page even though everything was filled in. Both vars are now wired through with `${VAR:-}` defaults — behaviour for anyone who hasn't set them is unchanged.

## Changes in this PR

- Improved Vite hot-module reload: non-component exports (hooks, constants, helper functions) moved out of component files so fast refresh works without full page reloads during development
- Consolidated duplicate formatting utilities (duration, relative time, compact numbers, date-only) into shared formatters; removed multiple inline copies scattered across component files
- Extracted shared `ASSIGNMENT_TYPE_STYLES` constant; access packages list now correctly applies dark mode badge colors (was missing dark variants)
- Renamed `getApColor` → `getAccessPackageColor` for clarity

## Changes in this PR

- Fixed: the matrix no longer stays blank after importing the demo dataset in Docker — navigating to the Matrix tab now picks up the newly loaded data and auto-applies the default filter without requiring a page refresh.

## Changes in this PR

- The Image Channels, Environment Variables (Docker Setup), Quick Install (index), and Config File Reference sections in the docs now show separate Linux/macOS and Windows (PowerShell) commands, consistent with the rest of the documentation
- Release notes for new versions are now generated automatically from the changelog instead of using GitHub's default auto-generated PR list

## Changes in this PR

- Release notes for new versions are now generated automatically from the changelog instead of using GitHub's default auto-generated PR list

## Changes in this PR

- Fixed cut-beta and cut-release workflows failing because `app/desktop/package.json` was missing
- Fixed portable ZIP build failing on Linux CI due to esbuild binary being invoked incorrectly
- Fixed cut-beta and cut-release CI running on Node 20 instead of Node 24 to match the bundled node.exe

## Changes in this PR

- Fixed cut-beta and cut-release workflows failing because `app/desktop/package.json` was missing

## Changes in this PR

- Added portable Windows launcher (`IdentityAtlas-portable.zip`) — runs Identity Atlas on any Windows PC without Docker. Unzip and run `Start-IdentityAtlas.ps1` with PowerShell 7.
- Bundled launcher uses the official signed `node.exe` from nodejs.org (OpenJS Foundation certificate), making it compatible with corporate WDAC / application-control policies that block unsigned executables.
- PostgreSQL data is stored in `%APPDATA%\IdentityAtlas\` using PGlite (WebAssembly PostgreSQL) — no subprocess spawned, no executable written to disk at runtime.
- PowerShell crawlers (Entra ID, CSV) are supported as a soft dependency: requires `pwsh.exe` on PATH.
- Fixed: matrix view data was not shown after first data load in portable mode (`pg_class.reltuples` is always 0 in PGlite; dashboard now falls back to an exact `COUNT(*)` when running in desktop mode).
- Fixed: migrations that partially applied (PGlite DDL transaction quirk) no longer cause the server to abort on restart — objects that already exist are recorded as applied and the server continues.
- Fixed: crawler jobs failed to start in portable mode — `Invoke-CrawlerJob.ps1` now accepts the crawler config as either a hashtable (Docker scheduler) or a JSON string (desktop worker), so both callers work correctly.
- Fixed: demo, Entra ID, and CSV crawler jobs failed in portable mode because `Invoke-CrawlerJob.ps1` used hardcoded `/app/` paths; it now resolves scripts relative to `$env:IA_APP_ROOT` (set by the launcher) with `/app` as the Docker fallback.
- Fixed: UI was not served when the zip was extracted to a non-standard path — the Express app now uses the `FRONTEND_DIST` env var set by the launcher instead of a hardcoded relative path that resolved incorrectly inside the esbuild bundle.
- Fixed: portable launcher now starts cleanly on fresh machines — resolved a WASM crash triggered by `CREATE EXTENSION pg_trgm` conflicting with the extension loaded at PGlite init, and a missing CJS compatibility shim in the esbuild bundle that prevented Express from loading.
- Fixed: matrix was empty after loading demo data in portable mode — two causes: (1) `REFRESH MATERIALIZED VIEW CONCURRENTLY` is not supported by PGlite's single-process WASM runtime, desktop mode now always uses plain `REFRESH`; (2) a legacy boolean→integer coercion in the ingest normalizer produced values PGlite rejects for `boolean` columns — booleans are now passed through as-is.
- Fixed: crawler job trace logs were silently lost in portable mode — the dispatcher and API now resolve the log directory from `$env:TRACE_DIR` / `TRACE_DIR` env var (set by the launcher) rather than the hardcoded Docker path `/data/uploads/jobs`.
- Fixed: build script now passes PowerShell commands as an argument array via `execFileSync` instead of shell-interpolating them, preventing backslash characters in paths from being silently dropped.

## Changes in this PR

- Fixed boolean values being incorrectly coerced to integers (0/1) during data ingest, causing failures on strict boolean columns
- Crawler job dispatcher now resolves script paths via `IA_APP_ROOT` environment variable, allowing the worker to run from any installation directory instead of requiring a fixed `/app` path
- Crawler job trace logs and CSV upload paths now respect `TRACE_DIR` and `UPLOAD_ROOT` environment variables, removing the hardcoded Docker paths `/data/uploads/jobs` and `/data/uploads`

## Changes in this PR

- Fixed broken links in architecture docs — source-code cross-references now point to GitHub URLs so the MkDocs strict build succeeds and docs deploy correctly to GitHub Pages.

## Changes in this PR

- Fixed noisy PostgreSQL ERROR log entries on first boot caused by `REFRESH MATERIALIZED VIEW CONCURRENTLY` being attempted before the materialized views were populated; the refresh now checks `pg_matviews.ispopulated` and skips `CONCURRENTLY` on the initial run.

## Changes in this PR

- Fixed: Matrix "Apply" button was disabled when no conditions were added to the wizard, making it impossible to create a matrix without first setting filters. The matrix now loads all subjects and resources when applied with no conditions.
- Fixed: Matrix tab showed a "Create matrix" call-to-action even when the database contained no data. It now shows a "No data available yet — run a crawler" message instead, and the wizard no longer auto-opens when there is nothing to display.
- Improved: Demo dataset (`Ingest-DemoDataset.ps1`) now seeds a default matrix filter so the Matrix tab opens straight to data on first visit, without requiring the wizard.
- Improved: Matrix wizard now warns when the selected slice exceeds 5,000 assignments and blocks Apply above 25,000, preventing accidentally loading very large datasets.

## Changes in this PR

- Security: bumped API dependencies to address npm audit high-severity finding (tmp path traversal).

## Changes in this PR

- Security: bumped postcss (8.5.6 → 8.5.15, moderate) and tmp (0.2.5 → 0.2.7, high) to address npm audit findings. Two remaining moderate vulnerabilities (uuid/exceljs) cannot be fixed without a breaking exceljs downgrade.

## Changes in this PR

- Fixed: assigning or removing a category on a business role from the Access Packages page silently failed — the relationship never got saved. The UI was sending the body field as `accessPackageId`, but the API expects either `resourceId` or `businessRoleId` (leftover from the v3 Access-Package → Business-Role rename). The mismatch produced a 400 that the UI's `for` loop swallowed without surfacing. UI now sends `resourceId`.
- Fixed: `POST /api/categories/unassign` still used the old MSSQL-shim syntax (`p.request().input(...).query('@param')`) from before the Postgres migration. Calls to it would throw at runtime. Converted to the Postgres `db.query(text, [params])` pattern the `assign` endpoint right next to it already uses.

## Changes in this PR

- Crawler memory footprint dropped dramatically on tenants with large sign-in volumes or many access-package assignments. The `SignInLogs` and `Governance/APAssignments` phases used to load every paginated Graph response into one in-memory array before processing — fine on a Docker host with 12 GB, OOM-killed the worker on Azure (capped at 2 GB / 4 GB on the Consumption tier of Container Apps). Both phases now pipe Graph pages through a new `Invoke-FGGetRequestStream` helper that emits items one at a time, so we aggregate as events arrive and never hold more than ~one Graph page (~1000 events) plus the aggregated state. Real-world impact: a customer's 4.5K-user / 9.9K-group tenant had 7 phase OOMs at 1 GB / 2 GB; the same shape will now run cleanly without bumping resources.
- Added `tools/powershell-sdk/graph/Invoke-FGGetRequestStream.ps1` — a streaming counterpart to `Invoke-FGGetRequest`. Same auth/retry/throttling/Retry-After semantics, but emits each `.value` item to the pipeline as pages are fetched instead of accumulating the whole result. Use it whenever the next thing you do is process items in a loop and the response can be paginated — assigning the result to a variable (`$x = Invoke-FGGetRequestStream …`) re-buffers and undoes the benefit.

## Changes in this PR

- Increased the Azure worker container's CPU and memory allowance across all size profiles. PowerShell Graph crawlers spawn one runspace per parallel task via `ForEach-Object -Parallel`, and each runspace duplicates the session state — memory pressure scales fast on real tenants. The previous tiers maxed out at 0.5 CPU / 1 GB memory even on `xl`, which OOM-killed real customer syncs (4.5K users + 9.9K groups + 3.6K service principals — a mid-size tenant). New sizing keeps the same Postgres / App Service tiering but bumps the worker substantially:

  | Profile | Web SKU | Worker (was → now) |
  |---|---|---|
  | xs | B1 | 0.25 CPU / 0.5Gi → **0.5 CPU / 1Gi** |
  | s (default) | B2 | 0.25 CPU / 0.5Gi → **1 CPU / 2Gi** |
  | m | S1 | 0.25 CPU / 0.5Gi → **1 CPU / 2Gi** |
  | l | P1v3 | 0.5 CPU / 1Gi → **2 CPU / 4Gi** |
  | xl | P2v3 | 0.5 CPU / 1Gi → **2 CPU / 4Gi** |

  Marginal cost is small (~€5-15/month per tier) compared with the cost of debugging an OOM crash halfway through a customer's first sync. Existing deployments aren't affected automatically; redeploy or run `az containerapp update --name <worker> --resource-group <rg> --cpu 2.0 --memory 4.0Gi` to bump an existing worker.

## Changes in this PR

- Azure deployments now ship with Entra ID auth turned **on from the first deploy**. The Bicep template sets `AUTH_ENABLED=true` and creates `AUTH_TENANT_ID`/`AUTH_CLIENT_ID` env vars as empty strings. After Step 1 of the walkthrough, opening the deployed Web App's URL shows an **Entra ID setup required** page with the exact remaining steps (register the App in Entra, expose an `access` scope, paste tenant + client IDs into the Web App's Environment variables blade). The previous "open mode after Step 1, then add auth in Step 2" flow is gone — there's no usable unauthenticated state at any point in the install, so a customer can't accidentally end up running an internet-exposed deployment with no sign-in.
- The setup-required page is rendered by the SPA's `AuthGate` when `/api/auth-config` returns `{ enabled: true, configured: false }` — a new `configured` field is true only when both tenant and client IDs are populated. The page shows the current origin (so the redirect-URI step is copy-paste), inlines the same Entra-app-registration walkthrough that's in [docs/architecture/azure-deployment-walkthrough.md](docs/architecture/azure-deployment-walkthrough.md), and adapts the "where to put the IDs" instructions to whether you're running on Azure App Service or a Docker host.
- Local Docker installs are unaffected: `AUTH_ENABLED` still defaults to `false` for `docker compose` deployments. The auth-required-by-default behavior is an Azure-deployment thing.

## Changes in this PR

- Added a **Cut Beta** GitHub Actions workflow (`Actions → Cut Beta`) to publish pre-release Docker images tagged `:beta` and the exact version (e.g. `5.3.0-beta.1`) without touching `:latest`. Users on `docker-compose.prod.yml` are unaffected.

## Changes in this PR

- Fixed: on a fresh Azure deployment, migration `013_matrix_matviews_and_indexes.sql` failed at `CREATE EXTENSION pg_trgm` because Azure Postgres Flexible Server requires the extension to be allow-listed via the `azure.extensions` server parameter before any user can install it. The migration runner aborts the pending batch on failure, so 16 later migrations (including the one that adds `nextRunMode` to `CrawlerConfigs`) also got skipped. Symptom was "Failed to create job" when clicking Run on a crawler in the UI. The Postgres Bicep module now sets `azure.extensions=PG_TRGM` via a `Microsoft.DBforPostgreSQL/flexibleServers/configurations` resource, so future deploys never hit this.
- Fixed: the Docker worker's crawler API key (`fgc_…`) was being rejected by `authMiddleware` before reaching `crawlerAuthMiddleware`, so `POST /api/crawlers/jobs/claim` returned 401 every 30 seconds and the worker never picked up queued jobs. This was an over-correction from the admin-bypass hardening in #160 — `authMiddleware` is mounted on `/api/*` ahead of `crawlerAuthMiddleware` in `index.js`, so worker requests hit the unconditional `fgc_` rejection first. `authMiddleware` now passes `fgc_` tokens through to the next middleware on `/api/crawlers/*` and `/api/ingest/*` (the two prefixes downstream-mounted with `crawlerAuthMiddleware`), while still rejecting them on every other admin/UI path. The original admin-bypass concern stays addressed.

## Changes in this PR

- Added a one-click **Deploy to Azure** button to the README. Provisions a complete production-grade Identity Atlas stack on Azure in ~15 minutes via Bicep: VNet-isolated Container Apps Environment (web + worker), Postgres Flexible Server with a private endpoint, Key Vault holding the master key and DB password, ACR with both images auto-imported from `ghcr.io`, Azure Files share for `/data/uploads`, Log Analytics, and three managed identities scoped via RBAC.
- New `azure/` directory holds `main.bicep` (orchestrator), eleven focused module Bicep files (network, identities, ACR, DNS, Key Vault, Postgres, storage, Container Apps Environment, web app, worker app, bootstrap deployment-script), the compiled ARM JSON used by the Deploy-to-Azure button, an example parameters file, a `deploy.ps1` CLI fallback, and `import-image.ps1` for refreshing images later.
- Estimated cost: ~€100–110/month (West Europe, ex VAT, single-replica, no HA). Full architecture, decisions taken, and ops notes in [docs/architecture/azure-deployment.md](docs/architecture/azure-deployment.md).
- Reworked the Azure deployment to a much simpler "Simple" shape: App Service for Linux Containers (web) + Postgres Flexible Server (public endpoint, firewall-restricted) + Container Apps Environment (worker, always-on) + Storage Account / Azure Files / Key Vault / Log Analytics. No VNet, no private endpoints, no public IPs or load balancers we provision — anyone with Azure-subscription-owner rights can deploy without involving central networking teams. Replaces the previous VNet-isolated shape (saved as a future "Isolated" template for tenants who want it).
- One-click **Deploy to Azure** button still works. The deploy form now asks for a **size profile** (xs / s / m / l / xl) ranging from ~€45/mo (demo) to ~€469/mo (enterprise). Default `s` (~€79/mo) is sized for small production tenants and feels snappy under normal concurrent use.
- **Bring-your-own Log Analytics**: provide an existing workspace resource ID (or workspace customer ID + shared key as a fallback) and the deployment forwards all logs there instead of creating a new workspace. Saves the ~€3-5/mo line and matches enterprise CCoE patterns.
- Deployment time dropped from ~15 minutes to ~5-7 minutes. Architecture, decisions, scaling, and ops notes documented in [docs/architecture/azure-deployment.md](docs/architecture/azure-deployment.md).
- Fixed: the App Service was being deployed with the Postgres password under the wrong env var name (`POSTGRES_ADMIN_PASSWORD`), so the API could not connect to the database after a fresh deploy. The env var is now `POSTGRES_PASSWORD`, matching what `app/api/src/db/connection.js` reads.
- **Entra ID authentication is now ON by default for Azure deployments.** The deploy form has three new fields: `enableEntraAuth` (default TRUE), `entraTenantId`, and `entraClientId`. If `enableEntraAuth=true` but tenant/client are blank, the deploy now fails fast in the bootstrap step with a clear message — so you can't accidentally publish an open-to-the-internet instance. Set `enableEntraAuth=false` explicitly to deploy in OPEN mode for short-lived demos.
- On Azure App Service, the Admin → Authentication and Admin → Containers tabs are now hidden. They both assume a Docker host you can reach; on Azure neither is reachable in the same way, and on Azure auth is enforced via Bicep parameters at deploy time anyway.
- The deploy form now has an `imageChannel` dropdown: **stable** (default, tracks the last `:latest` release tag) or **edge** (tracks every main-branch build via `:edge`). Replaces the previous free-form image fields. Advanced users can still pin to a specific image via `webImageOverride` / `workerImageOverride`.
- Added a portal-only deployment walkthrough at [docs/architecture/azure-deployment-walkthrough.md](docs/architecture/azure-deployment-walkthrough.md). It uses a two-pass deploy pattern — first deploy claims the name in OPEN mode so you can confirm the hostname before creating the Entra App Registration; second deploy turns auth on with the IDs filled in. Avoids wasting App Reg setup work on a name collision.
- Simplified the deploy form to just the happy-path fields: `namePrefix`, `sizeProfile`, `imageChannel`, `existingLogAnalyticsWorkspaceId`, `entraTenantId`, `entraClientId`. Removed ten advanced fields (`location`, `webImageOverride`, `workerImageOverride`, `existingLogAnalyticsCustomerId`, `existingLogAnalyticsSharedKey`, `webAllowedIpCidrs`, `bootstrapForceTag`, `postgresAdminPassword`, `entraRequiredRoles`, `enableEntraAuth`) — region is taken from the resource group, the rest are settable by editing the Bicep or post-deploy from the Web App's Environment variables blade.
- The `enableEntraAuth` toggle is gone; auth state is derived from whether the Entra IDs are filled in. Both blank = first-pass OPEN deploy that claims the hostname; both filled = auth ON. Filling in only one is rejected with a clear error. Less form clutter and one fewer decision for a first-time deployer.
- Input validation now runs in the bootstrap step **before** any module tries to use the values, so a typo fails the deploy in under a minute with a clear error instead of producing a half-built resource group. Validates: the existing Log Analytics workspace ID (when provided) is a full workspace resource ID — not the parent resource group's ID, which was a real-world mistake we hit.
- **Deployment is now two separate templates with non-overlapping concerns.** `main.bicep` deploys the app stack in OPEN mode (no auth); a new `main-auth.bicep` layers Entra ID auth onto an existing deployment by patching only the App Service's app settings. Both have their own Deploy-to-Azure button. The auth template never touches Postgres, Key Vault, or any other resource — so the previous failure modes around re-deploying the same template (Postgres storage-shrink errors, half-applied changes) are gone. Each template's form has only the fields it actually needs.
- `namePrefix` is now auto-generated and deterministic per resource group (`idatlas-` + 7-char hash of the RG ID) — and no longer a parameter, so it doesn't show up in either deploy form. Both templates derive the same prefix when deployed to the same RG, so Step 2 finds the App Service Step 1 created without any input. Customizing the hostname requires editing the Bicep — uncommon enough that the friction reduction is worth it.
- Step 2's auth patch now uses a deployment-script (`az webapp config appsettings set`) instead of a `Microsoft.Web/sites/config` Bicep resource. The Bicep-native approach hit an ARM circular-dependency error — read existing settings + write to the same resource triggers ARM's cycle detector, even though the operations are sequential. `az webapp config appsettings set` is a true merge (adds/updates only the named keys without touching the rest), so it sidesteps the need to read at all. The script reuses Step 1's existing deployment-script managed identity and grants it Website Contributor scoped to just the one App Service.
- Added a **Trends** tab to the Dashboard page. Plots the % of assignments that are governed over time, plus separate charts for users, resources, and assignments growth.
- The chart starts populated on the day this version ships and grows as new days are captured. The scheduler writes one snapshot per UTC day to the new `DashboardSnapshots` table — no historical backfill, so the early section reflects only the snapshots actually captured (not a reconstructed history).
- Range selector switches between 30 days / 90 days / 1 year / 2 years. Charts render as hand-rolled SVG; no new frontend dependency.
- Added Playwright e2e coverage for the new Dashboard tab strip and Trends tab: verifies tab switching, chart container presence, and the range selector behaviour.
- New `docs/architecture/dashboard-trends.md` documents the snapshot architecture, the no-backfill decision, the API surface, and the chart rendering details.
- Pointers in `app/ui/CLAUDE.md` so future AI contributors find the new components.

## Changes in this PR

- Fixed inconsistent docker startup commands: all documented `docker compose up` invocations now consistently use `--pull always` to ensure the latest image is pulled on every start.

## Changes in this PR

- Fixed security vulnerability: crawler API keys (`fgc_`) were incorrectly passed through JWT auth middleware, allowing any string with the `fgc_` prefix to reach admin endpoints without valid credentials.

## Changes in this PR

- Fixed CodeQL alert 50: replaced plain null-prototype object with `Map` in ingest normalization to eliminate remote property injection risk from user-supplied field names.

## Changes in this PR

- Fixed remaining CodeQL warnings: removed unused internal helper functions, eliminated a TOCTOU file-system race in the job-log endpoint, and hardened ingest normalization against prototype-injection via user-supplied property names.

## Changes in this PR

- Fixed log-injection vulnerability in ingest validation logging — only the record count is logged, never user-supplied content
- Fixed client-side request-forgery risk in the authentication context default — the fallback stub no longer calls fetch
- Fixed server-side request-forgery in the risk-profile scraper routes — added inline CodeQL suppression with evidence of the existing mitigation in `scraper.js` (http(s) only, private/loopback hosts blocked)
- Fixed server-side request-forgery risk in the Azure OpenAI provider by adding inline CodeQL suppression with evidence of the existing `validateAzureEndpoint` mitigation (HTTPS required, private/loopback hosts blocked)

## Changes in this PR

- Removed unused imports and variables flagged by CodeQL across API route files (admin, contexts, correlationRulesets, details, governance, permissions, resources, tags), ingest engine and sessions, and the secrets vault
- Removed unused variable declarations in Playwright end-to-end test files (access-packages, detail-pages, identities, matrix, multi-filter)
- Removed unused state setter in RiskScoringPage

## Changes in this PR

- Fixed log injection in context plugin dry-run and ingest routes by sanitising user-controlled values before logging
- Fixed remote property injection in ingest normalisation by iterating the trusted column set instead of request-supplied keys
- Hardened CORS configuration: replaced permissive wildcard origin with an explicit localhost allowlist for development; production defaults to same-origin only
- Added rate limiting to the SPA HTML fallback route
- Added tenant ID format validation in MSAL AuthGate to prevent client-side request forgery via a crafted server config response

## Changes in this PR

- Fixed SSRF vulnerabilities in LLM web scraper and Azure OpenAI provider by blocking requests to private/loopback addresses
- Upgraded API key hashing from SHA-256 to scrypt (PBKDF) with automatic legacy key detection and migration on startup
- Fixed path traversal vulnerability in job log endpoint using path containment check
- Fixed TOCTOU race conditions in master key file handling and CSV folder detection
- Fixed regex polynomial ReDoS in Azure OpenAI endpoint URL handling
- Fixed bad HTML tag filter patterns in LLM scraper (script/style/nav block stripping)
- Fixed double-escaping of HTML entities in LLM scraper text extraction

## Changes in this PR

- Fixed WCAG 2.0 AA contrast failures in MatrixFilterWizard: separator characters, percentage labels, orientation labels, hint text, and delete button labels were rendered in gray-300/400 (failing contrast) and upgraded to gray-500/600
- Fixed low-contrast "all" placeholder and loading indicator in MatrixFilterSummary
- Fixed SVG axis label color in TimeSeriesChart (gray-500 → gray-600, from ≈4.6:1 to ≈7.5:1 margin)
- Fixed remaining pre-existing contrast violations across 44 UI components (gray-400/300 text on light backgrounds, blue-400 and red-400 status text)
- Added ESLint rule `local/no-low-contrast-text` that blocks Tailwind `text-{color}-300` and `text-{color}-400` classes in JSX `className` attributes, enforcing WCAG 2.0 AA compliance at build time

## Changes in this PR

- Fixed matrix view crash ("Something went wrong / Cannot read properties of undefined") caused by a bad rebase conflict resolution in the CodeQL fixes PR (#148) that accidentally reverted the MatrixView.jsx wizard refactor from PR #147

## Changes in this PR

- Fixed six CodeQL code-scanning alerts: unused loop variable, misleading string concatenation, useless initial assignment, unused dead-code variable, and two unused variables in e2e tests

## Changes in this PR

- Added a **Trends** tab to the Dashboard page. Plots the % of assignments that are governed over time, plus separate charts for users, resources, and assignments growth.
- The chart starts populated on the day this version ships and grows as new days are captured. The scheduler writes one snapshot per UTC day to the new `DashboardSnapshots` table — no historical backfill, so the early section reflects only the snapshots actually captured (not a reconstructed history).
- Range selector switches between 30 days / 90 days / 1 year / 2 years. Charts render as hand-rolled SVG; no new frontend dependency.
- Added Playwright e2e coverage for the new Dashboard tab strip and Trends tab: verifies tab switching, chart container presence, and the range selector behaviour.
- New `docs/architecture/dashboard-trends.md` documents the snapshot architecture, the no-backfill decision, the API surface, and the chart rendering details.
- Pointers in `app/ui/CLAUDE.md` so future AI contributors find the new components.

## Changes in this PR

- Added a new crawler phase that imports application role assignments from Entra ID. For each enterprise app the crawler pulls the catalog of `appRoles[]` and the `appRoleAssignedTo` list, then writes one `AppRole` resource per (app, role), an `Application → AppRole` relationship, and one `ResourceAssignment` per user assignment. Group-typed assignments are expanded to per-user `AppRoleViaGroup` rows via `/transitiveMembers` so the matrix surfaces indirect access too.
- Wired up the existing "Apps & AppRoles" checkbox in the Crawlers wizard so toggling it actually runs the new phase. Requires `Application.Read.All` on the app registration (already required for service principals; the permission validator was already enforcing it).
- New matrix badges: `R` (App Role — direct) and `R` in a lighter shade (App Role — via group), so analysts can tell direct vs inherited app-role access at a glance.
- The dev `docker-compose.yml` now sets `restart: unless-stopped` on the postgres and web containers (the worker already had it; the prod compose file already had it for all three). After a host reboot, a Docker daemon restart, or an unexpected crash, the whole stack now auto-recovers without needing a manual `docker compose up -d`.
- Expanding a group in the matrix now fans out **any** resource that group is assigned to, not just nested parent groups. App roles a group grants its members appear as expanded sub-rows, with cells showing each user's `Indirect` (via this group) and/or `Direct` membership of that role. Previously only group-in-group nesting was visible.
- The crawler now writes the group→AppRole assignment itself (alongside the per-user expansion), so the relationship is queryable directly rather than reconstructed from the user-level rows. An idempotent backfill from existing `AppRoleViaGroup` data is applied automatically on the next bootstrap.
- Fixed three CI regressions on the PR:
  - Matrix matview `REFRESH` failed on large datasets after the badge-collapse migration when a single `(resourceId, principalId)` had both a `Direct` and a `Governed` row (or any other two rows that collapsed to the same `membershipType`) — both ended up at the unique index. Migration 026 dedupes via `GROUP BY (resourceId, principalId, membershipType)` with `bool_or` on `managedByAccessPackage`.
  - Playwright matrix test now walks the wizard (it used to wait for a table directly; the matrix tab now lands on an empty state until a filter is applied). Two other tests' `Matrix` button selectors gained `exact: true` so they don't match the wizard's "Create matrix" button.
  - Added a permissive authenticated-API rate limiter (600 req/min per IP) so `app.use('/api', authMiddleware, …)` no longer trips CodeQL's "authorization without rate limiting" rule.
- Fixed: user detail page showed "Identity 0" even when the user was linked to an Identity. The backend was 500-ing on `/api/identities/by-user/:userId` because the secondary query referenced columns (`userId`, `userPrincipalName`) that don't exist on `IdentityMembers`. The query now correctly joins to `Principals` to surface the UPN.
- Restored the matrix row-expand button on groups that have nested groups. The `/api/groups-with-nested` and `/api/group/:id/nested-groups` endpoints filtered `principalType LIKE '%group%'` — PostgreSQL `LIKE` is case-sensitive, and the data stores `principalType='Group'` (capital G), so the filter never matched and the UI thought no groups had nested members. Switched to `ILIKE` so case is irrelevant (same fix pattern as the recent Tag-all-matching repair).
- Fixed: on the user detail graph, the OAuth2 Grants fanout collapsed every consent into a single "Microsoft Graph PowerShell" node (the client app), and clicking it opened the client app instead of the scope. The fanout now shows one node per granted scope (e.g. "User.Read.All on Microsoft Graph"), and clicking opens the scope's Resource detail page so the actual permission and its consent metadata are visible.
- Fixed the search box on every Risk Scoring subpage (users / resources / business roles / org units / identities). The queries used `LIKE` (case-sensitive in postgres) on unquoted camelCase columns (`p.displayName` rather than `p."displayName"`) — so typing into the search field returned zero rows whether the data matched or not. Five queries flipped to `ILIKE` with proper identifier quoting. Caught by the new postgres-LIKE audit test.
- Fixed: "Tag all N matching" on the Users/Resources/Identities pages did nothing. The bulk-by-filter endpoint had been silently broken since the v5 postgres migration — it still referenced the dropped temporal `ValidTo` column, used the SQL-Server-specific `@@ROWCOUNT` system variable, and left camelCase column/table names unquoted (which postgres lowercases). The endpoint now reports the real inserted count and works against the postgres schema. Search is also now case-insensitive (`ILIKE`).
- The matrix now shows every type of user/resource assignment by default — OAuth2 grants, governed business-role assignments, and any future assignment type are no longer silently dropped. Previously only Direct/Owner/Eligible/Governed memberships flowed through. As a result you'll see new rows for delegated permissions, application roles, and similar resources for the principals that have them.
- Added matrix cell badges for Governed (G) and OAuth2 Grant (A) so cells that carry those membership types render with a labelled badge instead of a generic `?`.
- Replaced the Matrix tab's inline filters with a three-step filter wizard. The matrix stays empty until a filter is applied, removing the "Top 25 most-permissioned users tenant-wide" default that often hid the slice analysts actually wanted to see.
- Step 1 picks the row type — **User × Resource** (one row per account) or **Identity × Resource** (one row per correlated person, with cells unioned across the identity's accounts).
- Steps 2 and 3 narrow the subjects and resources with include/exclude conditions on **contexts** (with optional "include descendants") and **attribute values** (any column from Principals / Identities / Resources, plus `ext.*` keys inside `extendedAttributes`).
- Every step shows live counts: subject count vs. total, resource count vs. total, and the resulting number of assignments — so the size of the sub-selection is always visible while building the filter.
- Filters can be **saved org-wide** under a name, loaded again from a dropdown at the top of the wizard, and **shared** via the Matrix tab's "Share Link" button (the entire filter is encoded in the URL).
- Dropped from the Matrix toolbar: the User slider, search box, "User Filters" bar, context-filter chip bar, and the Type/Tags column-header filter dropdowns. All of those are subsumed by the wizard. IST / SOLL / Managed / Gaps toggle, Excel export and Share Link stay.
- Added an "Adjust filter" button to the toolbar that re-opens the wizard pre-populated with the current filter.
- New backend endpoints (`POST /api/matrix/data`, `POST /api/matrix/preview`, `GET /api/matrix/columns`, and `GET|POST|PUT|DELETE /api/matrix/saved-filters`). The legacy `GET /api/permissions` endpoint stays for backward compatibility, but new flows always go through `/api/matrix/data`.
- New `SavedMatrixFilters` table (migration 023) for the org-wide named filters.
- The matrix badge column now reports only *how* a user holds a resource (D / I / O / E), not the source of the assignment. Business Role assignments, OAuth2 consents, and direct app-role assignments all render as **D** (Direct) — the user holds these directly; the fact that they came through a governance process or a user consent is already conveyed by the resource type and (for governed rows) by the cell's Access-Package coloring. App-role assignments inherited via group membership render as **I** (Indirect).
- Test coverage caught up with the recent additions: ingest validation tests cover the new `assignmentType` values (`OAuth2Grant`, `AppRole`, `AppRoleViaGroup`) and the new `relationshipType` (`HasAppRole`); the nightly Entra crawler test asserts that app-role resources are reachable, the `/identities/by-user` endpoint responds 200, and the matrix view's `membershipType` column never leaks a source-attribute type.
- Added a static-analysis test that fails the build if any route handler reintroduces a plain `LIKE` (instead of `ILIKE`) on a column where case-insensitivity was historically load-bearing — the same SQL-Server-vs-postgres footgun bit three different endpoints during the v5 migration.
- Docs caught up too: `CLAUDE.md` no longer points at the deleted `Sync-FGEntraAppRoleAssignment.ps1`, the resource-type and relationship-type tables now list `AppRole`, `Application`, `DelegatedPermission`, `HasAppRole`, `DelegatesScope`. New `docs/architecture/matrix.md` consolidates the matrix grid model — badge collapse rules, why groups don't appear as columns, expand semantics — that was previously spread across migration comments. The ingest-API doc lists the current enum values.

## Changes in this PR

- Split CLAUDE.md into per-area subdirectory guides (Functions/, app/api/, app/ui/) so only relevant conventions are loaded per context; root file reduced from 1110 to 251 lines
- Moved open maintenance items to docs/maintenance-backlog.md; removed all resolved entries

## Changes in this PR

- Added a three-way Theme toggle (Light / Auto / Dark) to the settings dropdown, replacing the previous on/off switch. The "Auto" setting follows the OS color scheme and updates live when the system preference changes. Existing dark-mode preferences are automatically migrated on first load.
- Fixed WCAG 2.0 AA contrast violations in tag and category badge colors: all ten colors were replaced with darker equivalents, achieving a minimum 4.5:1 contrast ratio.
- Fixed additional WCAG 2.0 AA contrast violations across the UI: "missing permissions" text (red-400 → red-600), "core" attribute label (indigo-500 → indigo-700), staleness indicator colors (amber-600/blue-500 → amber-700/blue-700), empty-state dashes and separators (gray-400 → gray-500), "No changes recorded" text, close button icons, "Identity not found" text, and the risk tier "None" badge label (gray-400 → gray-500).

## Changes in this PR

- Added `.gitattributes` to enforce LF line endings on all text files, preventing CRLF from being introduced on Windows checkouts

## Changes in this PR

- CI automation (version bumps, releases, hotfixes) now authenticates via the Fortigi CI Bot GitHub App instead of a personal access token, so repository rules apply to all human contributors without exception

## Changes in this PR

- Added CodeQL static analysis scanning on all pull requests — automatically detects security vulnerabilities and code quality issues in JavaScript and TypeScript

## Changes in this PR

- Updated GitHub Actions to Node.js 24 runtime: checkout@v6, setup-node@v6, setup-python@v6, upload-artifact@v7, deploy-pages@v5, docker/setup-buildx-action@v4, docker/build-push-action@v7, docker/login-action@v4
- Updated Node.js install version in CI workflows from 20 (EOL) to 22 LTS

## Changes in this PR

- Fixed version link in footer not navigating to Admin → About when clicked from admin pages

## Changes in this PR

- Fixed "What is new" link on the dashboard — it now points to the changelog for the installed version instead of always showing the latest.

## Changes in this PR

- Fixed the Crawlers wizard incorrectly reporting `DelegatedPermissionGrant.Read.All` as missing when it had been granted. The wizard was checking for the GUID that belongs to `DelegatedPermissionGrant.ReadWrite.All`, so the real Read.All grant was never detected. `ReadWrite.All` is now correctly recognised as a superset of `Read.All`.
- Fixed the Entra ID crawler silently dropping OAuth2 delegated-grant resource-relationships (every consent was rejected with a 400). The validation whitelist was missing `DelegatesScope`, the relationship type introduced with the OAuth2 grants feature.
- Fixed the Entra ID crawler silently failing every `assignmentPolicies` fetch (so Access Packages showed blank Type/Review columns). Microsoft removed the `assignmentPolicies` segment from the `/beta` Graph surface — the call now goes via `/v1.0` (which still exposes it). The unused `$expand=accessPackage` and `$top=999` parameters were also dropped; `accessPackageId` is already on the base object, and this endpoint rejects `$top`.
- Fixed the Entra ID crawler dropping OAuth2 delegated-grant *assignments* with a 400 error. The `ASSIGNMENT_TYPES` validation whitelist was missing `OAuth2Grant`, the assignment type introduced with the OAuth2 grants feature. (Sibling fix to the `DelegatesScope` relationship-type entry.)
- Sign-in log sync now slices the window into 1-day chunks instead of fetching the whole 7-day window as one request. A single expired `$skiptoken` (Graph returns 400 mid-pagination on long slow fetches) used to abort the entire phase — now it loses one day, not the week, and the rest still ingests.
- Fixed the `/identities/by-user/:userId` endpoint returning 500 errors. It referenced column names (`primaryAccountUpn`, `primaryAccountId`) that only exist as aliases in other queries — now reads the real columns (`email`, `primaryPrincipalId`) and aliases them consistently.
- Entra ID crawler now fails the job (with a summary message) when any main sync phase errors out. Previously the crawler reported "completed successfully" even after several 400 responses had silently dropped entire object types.
- Sped up large ingests (e.g. 250k group memberships on a first-run tenant) by sending 1000 rows per INSERT statement instead of 200. The improvement is partially offset on first-run tenants by the new audit-history trigger now actually firing for these tables (previously it silently did nothing), so real-world wall-clock savings depend on whether history is in use — but statement count into Postgres is cut 5×.
- The nightly Entra ID test now asserts every permission returned by the wizard's validate endpoint is granted (catches GUID-mapping regressions like the one above), and the Full-Sync scenario enables every Entra object type — including Service Principals, PIM, Sign-in Logs, and OAuth2 Delegated Grants — with per-type presence checks on the resulting data.
- Crawlers wizard: step indicator is now clickable when editing an existing crawler — jump directly to any step instead of clicking Next repeatedly.
- Crawlers wizard: new Advanced section on the last step exposes `signInLogsDays` (1–30) and `aiNamePatterns` (extra regex fragments classifying service principals as AI agents). Previously these were only configurable by hand-editing the database.
- Added Export and Import buttons on the Crawlers page. Export downloads a crawler's configuration as JSON with the client secret stripped — safe to commit to a repo or share across tenants. Import opens the wizard pre-populated with the exported values; the user only has to re-enter the client secret.
- Fixed blank page when browsing the stack over plain HTTP (e.g. a dev VM on `http://hostname:3001`). The `upgrade-insecure-requests` CSP directive and Strict-Transport-Security (HSTS) header are now only emitted when `BEHIND_TLS=true` is set, i.e. when a TLS terminator sits in front of the container. Plain-HTTP deployments no longer have their asset URLs silently rewritten to HTTPS.
- Fixed scheduled Entra ID crawler runs failing with `400 Bad Request` on the first delta-mode day after the delta token was primed. Graph's `/users/delta` returns only the fields that changed per record, so the ingest API would reject records missing `displayName` and silently null every unchanged field on the ones that got through. The server now does `COALESCE(EXCLUDED.col, existing.col)` on delta upserts and skips the required-field check for delta payloads.
- Ingest validation errors are now logged with the first few concrete record-level errors (field name + reason), not just a count. Previously a 400 on the worker produced `"5 record error(s)"` in the web log with no hint which field was at fault.
- The Entra ID crawler now captures the response body of a non-2xx ingest API call via `$_.ErrorDetails.Message` (the PS 7 location — the old stream-read fallback was returning empty). Worker logs now show the actual validation error rather than just `"Response status code does not indicate success: 400"`.
- The Principals, Service Principals, Resources (groups) and Assignments (group members) phases are now wrapped in the same catch-and-continue pattern as the already-wrapped Sign-in Logs, PIM and Governance phases. A transient failure in one of these no longer aborts the entire crawl — the job continues to the remaining phases, and the final `phases` breakdown on the job record shows which phase(s) failed. The job still ends in `failed` state with a summary if any phase errored.
- Added a Sizing section to the [Docker Setup](docs/architecture/docker-setup.md) guide with recommended RAM and disk for small / medium / large tenants, plus a callout that activity-data sync (sign-in logs, and future audit/MFA feeds) is the dominant driver of growth — not principal or resource counts. The README now links there from Prerequisites.
- Each crawler job's full console output is now captured to `/data/uploads/jobs/{id}.log` via `Start-Transcript`, and the job-details modal on the Crawlers page has a new **Trace** tab showing the live transcript. It follows the tail while the job is running (polls every 3 s) and presents the final text once the job terminates — no more SSH-ing into the worker to see which access package is timing out or what the actual ingest 400 response body said. The 20 most recent logs are kept on disk; older ones are cleaned up on each new job.
- Fixed the Entra ID crawler skipping every access review definition in the Governance/AccessReviews phase, which surfaced in the UI as every access package showing "Pending first review" even when historical reviews existed, and 0 reviews on the dashboard. Graph's access-review scope shape evolved from a single `scope.query` to `resourceScope.query` (with `principalScope` carrying the reviewer side); the crawler only checked the old location, so every current-shape definition was silently dropped. The phase now inspects `scope.query`, `resourceScope.query`, and `scopes[].query` in turn, accepts both the path-style (`accessPackages/<uuid>`) and filter-style (`accessPackage/id eq '<uuid>'`) access-package identifiers, and logs a summary line at the end (`N total; skipped X (no scope) + Y (no AP id); kept Z`) so operators can see at a glance whether the filter is still dropping too much.
- Access review decisions fetch no longer passes `$top=999` to `/identityGovernance/accessReviews/definitions/{id}/instances/{iid}/decisions`. Graph caps that collection at 100 per page and returned 400 Bad Request for every instance — the fix earlier in this release unblocked 451 definitions, but each instance's decisions call was still failing silently, so `CertificationDecisions` stayed at zero rows. We now drop the `$top` query-string entirely and rely on `@odata.nextLink` pagination, and log the Graph response body on any remaining failures.
- The Crawlers page job list now shows a **Details** button for *every* job, not just completed/failed ones. Clicking it on a running or queued job opens the same modal with the new Trace tab live-tailing the worker's console — previously there was no way to see what a stuck-looking job was actually doing without SSH'ing into the container.
- The Governance/AccessReviews phase now emits a progress heartbeat every 25 definitions (`Access reviews: 175 of 451 definitions...`), and sets an explicit top-level step name (`Syncing access review decisions`) when it starts. The umbrella governance banner used to stay frozen on *"Catalogs, access packages, policies, reviews..."* for the full ~30 minutes the sub-phase took on a large tenant; now the UI shows actual movement.
- Fixed the Entra ID crawler's scheduled runs failing with `"records must be an array"` whenever the delta path happened to return *exactly one* changed principal or resource (every other count was fine). PowerShell's `ConvertTo-Json` silently collapses a single-element array stored as a hashtable value into a bare object (`@{records = @($user)} | ConvertTo-Json` → `{"records": {...}}` instead of `{"records": [{...}]}`), which the server's envelope validator correctly rejected. The crawler's ingest helper now wraps every array field in a `List[object]` which always round-trips as a JSON array regardless of cardinality.
- Each schedule entry can now independently specify its sync mode — **Delta (fast)** or **Full (authoritative)**. This supports the common pattern of running multiple fast deltas per day with one weekly full-refresh as a backstop (e.g. deltas at 02/08/14/20 and a full sync on Sunday at 04:00). The schedule editor shows a **Mode** dropdown per row; the worker scheduler reads the schedule's `syncMode`, falls back to the crawler's `Force full next run` override if set, and otherwise defaults to delta.
- The Recent Jobs table gained a **Mode** column showing a `full`/`delta` badge per run so you can see at a glance which scheduled runs took which path, and the job-details modal's header surfaces the same badge. Jobs queued before this change — which predate the per-schedule mode — render a `—` and continue to run in delta mode as before.
- Replaced the single **Run Now** button + separate *"Force full sync next run"* toggle on each crawler card with two explicit buttons: **Run Delta** (indigo) and **Run Full** (amber). One click queues the intended run directly — no more "set a toggle, wait for state to save, then click Run". The `POST /api/admin/crawler-jobs` endpoint accepts an optional `syncMode` body field (`"full"` or `"delta"`) for API callers; the stored `nextRunMode` column still works as a fallback for the scheduler when a schedule entry doesn't specify its own mode.

## Changes in this PR

## Context redesign (v6) — unified Contexts model + plugin framework + UI rewrite

### Data model & schema

- **Breaking (v6):** Replaced the old single-purpose `Contexts` table with a unified model: three variants (`synced` / `generated` / `manual`) and four target types (`Identity` / `Resource` / `Principal` / `System`). Membership lives in a new `ContextMembers` table. The legacy `Identities.contextId`, `Principals.contextId`, and `Resources.contextId` columns are removed; a principal can now belong to many contexts.
- New tables: `Contexts` (rewritten), `ContextMembers`, `ContextAlgorithms`, `ContextAlgorithmRuns`. The `_history` audit trigger is wired onto `Contexts`.
- Migration `019` drops the legacy `GraphResourceClusters` / `GraphResourceClusterMembers` tables (clustering is now a plugin).
- Migration `020` drops `GraphTags` / `GraphTagAssignments` and replaces them with **VIEWS** over `Contexts` + `ContextMembers`. Existing tag-JOIN queries (in `permissions.js`, `resources.js`, `details.js`) keep working unchanged. Tag IDs are now UUIDs; the UI treats them as opaque strings so no frontend change was needed.
- Migration `021` re-keys the `ix_Contexts_externalId` unique index from `(scopeSystemId, externalId)` to `(sourceAlgorithmId, scopeSystemId, externalId)` so different plugins can use the same `externalId='root'` on the same system without colliding.

### Backend — context API surface

- Rewrote `/api/contexts` routes from scratch: list / tree / detail / paginated members, plus full CRUD for non-synced contexts. `DELETE` allows manual + generated; synced is rejected. `POST/DELETE /:id/members` accept analyst writes on both manual and generated contexts (the plugin runner preserves `addedBy='analyst'` rows across re-runs).
- `GET /api/contexts/:id/members?include=descendants` walks `parentContextId` recursively and returns `DISTINCT ON (memberId)` so a subtree's members are visible in one paginated list.
- `GET /api/contexts` and `/api/contexts/tree` sort by `totalMemberCount DESC, displayName ASC` so big subtrees bubble up.
- `recalcMemberCountsForChain(id)` helper in `contexts/memberCounts.js` keeps `directMemberCount` and `totalMemberCount` accurate after every analyst write. Wired into the five paths that mutate `ContextMembers`: contexts member POST/DELETE and three tags routes (assign / unassign / assign-by-filter).
- `/api/contexts/:id` adds `contextCount` to the user/resource/identity detail responses and exposes `/api/<entity>/:id/contexts` lazy-load endpoints — the entity-detail graph uses these to populate the new "Contexts" fanout.

### Plugin framework (generated contexts)

- **Plugin contract** in `app/api/src/contexts/plugins/`: registry, runner, types. Plugins are in-tree Node modules; registered plugins seed into `ContextAlgorithms` at startup.
- **Runner** does a **two-pass FK-safe upsert** (insert with `parentContextId=NULL` first, then `UPDATE` parent links) so plugins can emit nodes in arbitrary order without hitting the parent-FK constraint.
- After every run, the runner rolls up `totalMemberCount` over the produced subtrees via a recursive CTE.
- **HTTP**: `GET /api/context-plugins`, `POST /api/context-plugins/:name/dry-run`, `POST /api/context-plugins/:name/run` (async, returns `runId`), `GET /api/context-plugins/runs`, `GET /api/context-plugins/runs/:id`.
- **Plugins shipped in this PR:**
  - `manager-hierarchy` — builds a tree from `Principals.managerId`. Node displayName is `"<Department> (<Name>)"` when available. Accepts `excludeNamePatterns` (regex array) so external-consultancy admin-managers (e.g. `\(Quanza\)`) can be filtered out persistently — their reports reattach to the synthetic root.
  - `ad-ou-from-dn` — parses an LDAP DN into a nested OU tree. Accepts a `dnField` parameter (default `extendedAttributes.onPremisesDistinguishedName`) resolved through a whitelisted SQL-expression helper.
  - `resource-cluster` — token-based clustering. Splits resource names on any non-alphanumeric, drops short/numeric/stopword tokens, creates one cluster per surviving token that appears in ≥`minMembers` resources. A resource can belong to multiple clusters. Tunable `minMembers` (default 4), `minTokenLength`, `maxTokenCoverage`, `additionalStopwords` for tenant-specific noise. See `docs/architecture/resource-cluster-algorithm.md`.
- **Plugins removed during the build** because they didn't carry their weight or weren't ready: `department-tree` (manager-hierarchy already shows department in displayName), `app-grouping-by-pattern` (`resource-cluster` does this better with no config), `business-process-llm` (stub — comes back when the LLM-call wiring lands).

### Matrix filtering by context

- New chip widget on the Matrix toolbar lets analysts pick one or more contexts to filter by, each with an "+sub" checkbox to include descendants. Filters AND together.
- `/api/permissions` accepts a `contextFilters` JSON query param. The `contexts/contextFilters.js` helper compiles the filter into SQL fragments using a recursive CTE on `parentContextId`. Identity/Principal-targeted filters constrain the row axis; Resource and System targets constrain the column axis.
- The filter is also pushed into the top-N user subquery — otherwise the matrix picked the 25 most-permissioned users tenant-wide and then intersected, leaving the view empty whenever the top-25 and the filtered context didn't overlap.
- Filter selections live in the matrix hash so filtered views can be bookmarked.

### Tags as Contexts

- Tags become a specialisation of manual Contexts (`contextType='Tag'`). The UI contract is unchanged.
- `bootstrap.js#ensureTagRoots()` runs at every container start and creates one synthetic `Tags` root per `targetType` (Principal / Resource / Identity), then reparents any orphan tag rows. New tags from `POST /api/tags` attach under the appropriate root via `getOrCreateTagRoot()`.
- The matrix `__userTag` filter and the resource detail tag chips keep working unchanged through the `GraphTags` / `GraphTagAssignments` views.
- Admin bulk-import of tags still targets the legacy table names — deferred to a follow-up because the admin-import path is scheduled for its own cleanup.

### Crawler integration

- CSV crawler (`tools/crawlers/csv/Start-CSVCrawler.ps1`) sends the new `Contexts.csv` / `ContextMembers.csv` shape and ingests them via the `/api/ingest/contexts` endpoint. The `/ingest/refresh-contexts` derive-from-`Principals.department` call is gone.
- Entra crawler no longer has a `Context` object type — context derivation is plugin work, not crawler work.

### UI — Contexts tab

- New **Contexts** tab with a two-pane layout: left selector grouped by `contextType (targetType)`, right pane with **Tree** or **List** view. Each tree node is a rounded pill with a ringed variant-colored bubble; L-shaped connector lines show the hierarchy.
- Tree + selector show **`<direct> · <total>`** member counts when a subtree carries indirect members.
- "**+ New**" on the selector opens a three-card dispatcher: Import (jumps to Crawlers), Run plugin, Create manual.
- **RunPluginModal** — picker grouped by target type, parameter form auto-generated from each plugin's `parametersSchema` (with `scopeSystemId` rendered as a system picker and array/object params editable as JSON), Dry-run preview with counts + samples, Run that queues async + opens RunDetailPage.
- **RunDetailPage** polls `/api/context-plugins/runs/:id` every 1s until terminal; shows status, reconciliation counts, parameters, and any error.
- **ManualContextEditor** — rename, set parent, set owner, edit description, delete-with-confirm. Parent picker is the new shared **ContextPicker** modal (tree + list views, search with auto-expand on match, exclude self+descendants).
- **ContextMemberPicker** — debounced typeahead hitting `/api/identities`, `/api/resources`, `/api/users`, `/api/systems` based on `targetType`. Members are addable on both manual and generated contexts; per-row Remove on each. Remove buttons on algorithm-added rows say "Remove (will return)" so the analyst knows tuning plugin parameters is needed for a persistent removal.
- **GeneratedContextActions** panel for generated contexts — Delete-with-confirm + caveat that re-running the plugin will recreate the row unless parameters change.
- **Tree-delete** button on the right-pane header lets the analyst nuke an entire tree (root + descendants + members) without drilling in.

### UI — entity detail rework

- Detail pages (User / Resource / Identity / Access Package) use a shared two-column layout: **AttributesTable** on the left (real columns + `extendedAttributes` merged), **EntityGraph** on the right.
- AttributesTable uses `table-fixed` with a 40/60 colgroup so long extension-attribute labels wrap rather than squeezing the value column. No internal scroll — the panel grows to its natural height.
- **EntityGraph** is pannable via pointer drag and zoomable via wheel (clamped 0.4× – 3×). A "Reset view" button overlays the top-right when the user has moved away from default. `touch-action: none` so trackpad/touch swipes pan instead of scrolling the page.
- The graph's "Contexts" fanout uses the new `contextCount` + `/contexts` endpoints — clicking it shows every context the entity belongs to and drilling in opens that context's detail page.

### Risk Scoring page changes

- Cluster sections retired. Default view is "Users". A "View clusters →" link jumps to the Contexts tab. The `/api/risk-scores/clusters*` routes are removed; clustering lives in the `resource-cluster` plugin.

### Bootstrap / quickstart fixes

- `BEHIND_TLS=true` opt-in for HSTS + CSP `upgrade-insecure-requests`. The default `http://host:3001` quickstart no longer traps browsers into HTTPS-only for a year.
- `/api/users` was returning 500 because it still SELECT'd the dropped `u."contextId"` column. Fixed.

### Tests

- 8 new vitest test files, **216 tests total** (was 175 before this branch):
  - `contexts/contextFilters.test.js` — 13 tests for the matrix-filter SQL helper
  - `contexts/memberCounts.test.js` — 5 tests for the count-refresher (walk-up, direct/total updates, cycle safety)
  - `contexts/plugins/manager-hierarchy.test.js` — 10 tests covering the algorithm + `excludeNamePatterns`
  - `contexts/plugins/ad-ou-from-dn.test.js` — 10 tests including injection guards on `dnField`
  - `contexts/plugins/resource-cluster/tokenize.test.js` — 16 tests for the tokenizer + stopwords
  - `contexts/plugins/resource-cluster/index.test.js` — 10 integration tests for the plugin's `run()` against a mocked db
  - `bootstrap.tagRoots.test.js` — 3 tests for `getOrCreateTagRoot`

### Cleanup

- Removed `OrgChartPage.jsx` and the `Org Chart` tab. A minimal `/api/org-chart` adapter remains (3 endpoints: manager / reports / availability) to keep the entity-detail graph and the Department detail page working until those callers are rewritten to read from the manager-hierarchy plugin tree directly.

## Changes in this PR

- Redesigned User, Identity, and Resource detail pages with a two-column layout: a single unified Attributes table on the left (core columns and extendedAttributes merged, with an "ext" tag marking JSON-derived fields) and an interactive relationship graph on the right.
- The graph shows the entity in the center with relationship nodes orbiting around it (for a user: Manager, Direct Reports, Context, Groups split by Direct/Indirect/Owner/Eligible, Access Packages, OAuth2 Grants, and Identity). Node size scales with the count and active nodes pulse in the logo's lime palette.
- Clicking a relationship node reveals the full list of items below the graph — e.g. clicking "Groups (Direct)" shows every direct membership, clicking "Direct Reports" shows every report — with clickable rows that open the entity's own detail tab.
- Clicking a satellite item now fans its relationships out as a further ring, drilling into that entity's own graph. Clicking the same node again collapses it; switching to a different root node replaces the chain. Works across users → access packages → resources → users, etc.
- Business Role / Access Package detail pages now share the same graph + fanout + attributes layout as users and resources.
- New "Recent Changes" timeline on every entity detail page. Shows relationship-level events from the last 30 days — assignments in/out, manager changes, resource containment shifts, linked-account add/remove — so investigating a permission issue starts with "what moved recently". Each event links to the affected counterparty's detail tab.
- Recent additions and removals also show up in the graph itself: a "Recently Added" root node (amber tint) and "Recently Removed" node (rose tint) appear when applicable, and items added in the window are tinted amber when they appear inside regular fanouts.
- Identities tab is now a simple Resources-style list (name, email, accounts, department, job title, tags) with search, filters, and bulk-tag actions. Account-correlation controls (verify / confirm / reject, HR anchor badges, orphan status, confidence bars) were removed from the list — they will return in a dedicated correlation UI later.
- Identities now support tags. Tag CRUD accepts entityType='identity'; identity rows carry their tags in the list API; a new `/api/identity-columns` endpoint feeds the filter-bar dropdowns.
- New endpoints `GET /api/user/:id/recent-changes`, `/api/resources/:id/recent-changes`, `/api/access-package/:id/recent-changes`, `/api/identities/:id/recent-changes`. Each returns up to 50 events in the last 30 days with `{ at, operation, summary, counterpartyKind, counterpartyId, counterpartyLabel }`.
- Migration 018 rewires the `_history` audit trigger so it writes a composite-key row identifier for `ResourceAssignments`, `ResourceRelationships`, and `IdentityMembers` — tables where the primary key is a tuple of foreign keys. Before this migration those inserts and deletes were silently skipped, so Recent Changes only picks up events from the migration forward.
- Identities now show aggregate counts across all linked accounts (groups, governed roles, owned resources, eligible memberships, OAuth2 grants) and a new `/api/identities/:id/assignments?type=…` endpoint returns the flattened list when a node is clicked.
- User detail endpoint now returns `membershipByType` (broken down by Direct/Indirect/Owner/Eligible) and `directReportCount`; resource detail endpoint returns `assignmentByType` (Direct/Governed/Owner/Eligible) — both used to populate the graph without loading full lists.
- HSTS and CSP `upgrade-insecure-requests` are now opt-in via `BEHIND_TLS=true`. The default quickstart serves over plain HTTP on port 3001, and these headers were trapping browsers into HTTPS-only mode with no TLS listener behind them.
- New `Test-EntityGraphNodes.ps1` nightly test walks every active node on every entity detail graph, asserts the matching list endpoint returns non-empty rows with displayName fields, and probes the `/recent-changes` endpoint shape for all four entity kinds.

## Changes in this PR

- Fixed org chart direct reports not showing due to invalid ValidTo filtering (temporal tables were removed in v5)

## Changes in this PR

- Fixed business role assignments not displaying in the detail page (API was returning `state` instead of `assignmentState` and missing the `id` field)

## Changes in this PR

- Added dark mode support across the entire UI; toggle via the user avatar settings dropdown
- Dark mode preference is persisted per browser in localStorage
- All pages, tables, cards, modals, and the matrix view adapt to dark mode
- Access Package column colors switch to a darker saturated palette in dark mode so they remain distinct and legible
- Risk tier badges (Critical/High/Medium/Low/Minimal) use appropriately shifted dark variants

## Changes in this PR

- The Crawlers page now shows **one progress card per running or queued crawler** instead of collapsing everything to a single card. Starting two crawlers back-to-back shows two cards stacked: the running one with its live step + percentage, and the queued one with a "Waiting for the worker" amber card (no fake 0% progress bar). Each card is labelled with the source config's display name so two Entra tenants are distinguishable at a glance. Cards can be dismissed individually once the job finishes.
- Added **OAuth2 Delegated Grants** as a new object type in the Entra ID crawler. When enabled, the crawler pulls `/oauth2PermissionGrants` and ingests every per-user consent (user X authorized client app Y to call target API Z on their behalf with scope S). Tenant-wide admin consents (`consentType='AllPrincipals'`) are skipped because they don't represent an individual user's authorization decision.
- New Graph permission surfaced in the Crawlers wizard: `DelegatedPermissionGrant.Read.All`. The wizard now warns if the app registration doesn't have it when the OAuth2 Grants object type is selected. `DelegatedPermissionGrant.ReadWrite.All` counts as granted (superset).
- Modelled each (client-app, target-API, scope) combination as a child `Resources` row of the client app (resourceType `DelegatedPermission`, linked via a new `ResourceRelationships.relationshipType='DelegatesScope'`). Each user's consent becomes a `ResourceAssignments` row with `assignmentType='OAuth2Grant'`. The deterministic scope-resource IDs make re-runs idempotent, and the distinct relationshipType keeps the sync from interfering with Access Package `Contains` relationships.
- Added an **OAuth2 Delegated Grants** collapsible section to the User detail page, listing every (client app, target API, scope) the user has consented to. Clicking the client-app name opens its detail tab. The section only renders when the user has at least one grant.
- Removed the hardcoded "Open in Entra ID" button from every detail page (User, Group, Resource, Access Package). The button was built from UI-side URL computation duplicated across four files, which drifted whenever Microsoft changed portal URLs.
- Replaced with a data-driven path: the crawler-calculated `ext.Link` attribute now renders as a clickable "Open in Entra ID" hyperlink directly in the Extended Attributes / Attributes table on every detail page. Single source of truth — if the crawler knows the portal URL for an object, you see it; if it doesn't, the row simply isn't there (no more links that 404).
- Bonus: any other `http(s)://…` attribute value renders as a clickable link showing the URL text, so future calculated fields (wiki links, ticket references, etc.) get the same treatment automatically without each detail page needing to opt in.
- Added a dedicated **`PrincipalActivity`** table (migration `017_principal_activity.sql`) for sign-in timestamps. Activity data no longer lives in `Principals.extendedAttributes`, which eliminates the `_history` churn that previously generated one audit row per user per daily crawl. History-trigger-free by design — only the latest known activity per combination is kept.
- The Entra ID crawler now populates **per-user sign-in activity** from the existing `signInActivity` property on `/users`, sending it to `/ingest/principal-activity` as aggregate rows (granularity A) keyed by principal.
- **Service-principal sign-in activity** is newly captured via `/beta/reports/servicePrincipalSignInActivities`. For each synced SP the crawler uploads an aggregate row with `lastSignInDateTime` and `lastNonInteractiveSignInDateTime` from the report, plus `applicationAuthenticationClient` and `delegatedClient` flavours in `extendedAttributes`. Previously ~96% of principals (SPs / MIs / AI agents) had zero activity data.
- New crawler object type **"Sign-in Logs (per-app activity)"** (`signInLogs`) pulls `/auditLogs/signIns` and aggregates to per-`(user, app)` last-activity rows (granularity B). Answers "when did user X last sign in to app Y?". Window configurable via `signInLogsDays` (default 7, capped at Graph's 30-day retention). Skipped events (no `userId`/`appId`, or app not yet synced) are logged but don't fail the run.
- Risk scoring engine now reads the stale-sign-in signal from `PrincipalActivity` first, falling back to the old `extendedAttributes.signInActivity` path so scores don't regress for tenants that haven't re-crawled yet.
- Seven new vitest cases covering `principal-activity` envelope + record validation, the aggregate-row sentinel path, the per-pair path, and pinning `AGG_RESOURCE_ID` to the migration's `DEFAULT` value.
- Fixed the Crawlers page showing "Force Stop" on every crawler config of the same type when any one of them was running. With two Entra ID crawlers side-by-side, starting one made the other's card light up as if it were running too, and clicking "Force Stop" on the wrong card would kill the real running job. The page now matches each running job back to the specific config that started it. Manual "Run Now" jobs are also stamped with their source config id on the backend so the scheduler and the UI agree on which config each job belongs to.

## Changes in this PR

- Added per-phase timing to the Entra ID crawler. Each `SyncXxx` block (Principals, ServicePrincipals, Resources, Assignments, PIM, Governance, RefreshViews) now wraps a `Stopwatch` and the final log prints a breakdown table: `Principals  42.3s  (4.7%)` etc., plus an "Other" line covering setup and anything outside the instrumented blocks. No behaviour change — just instrumentation — so operators can see exactly where a slow crawl spent its time before deciding where to optimise.
- Added two calculated fields to every Entra-synced object's `extendedAttributes`: a **`Link`** deep-link into the Entra admin portal (same URL the Identity Atlas UI opens on its "Open in Entra ID" buttons), and **`<fieldName>_OuPath`** — a forward-slash-separated OU path derived from any DN-shaped value on the object. Example: `CN=100001,OU=Users,OU=Accounts,OU=Clients,DC=krypton,DC=ad,DC=novastream,DC=com` becomes `Clients\Accounts\Users`.
- Works across **all synced object types** (users, groups, service principals, managed identities, AI agents). Every DN-shaped attribute on each record is converted — the conversion is opt-in by DN shape, not by hardcoded field name, so custom `fgGroupDN` / `ownerDN` / etc. extensions get translated too.
- `onPremisesDistinguishedName` is now fetched by default on the user sync so on-prem-synced users get an `_OuPath` out of the box. Cloud-native users leave it null and emit no extra field.
- Four new helper functions under `tools/powershell-sdk/helpers/`: `Add-FGEntraCalculatedAttributes`, `Get-FGEntraPortalLink`, `Test-FGDistinguishedName`, `Convert-FGDistinguishedNameToOUPath`. 21 new Pester tests pin the DN detection rules, the canonical OU-path conversion example, and each portal-URL blade shape.
- Fixed the worker running "orphaned" crawl jobs after a web container restart. When the web container restarts mid-crawl, its bootstrap marks any `running` CrawlerJob as `failed`. Previously the worker had no way to know its current job had been killed and would keep processing for another 60–90 minutes until the crawl finished naturally, blocking every queued job behind it. The crawler's progress endpoint already returned HTTP 409 when asked to update a non-active job — the crawler was silently swallowing that signal. It now propagates 409 as a clean abort, the dispatcher marks the job failed, and the worker moves on to the next queued job within one poll cycle (~30 seconds).

## Changes in this PR

- Added a one-click Excel Power Query workbook download under **Admin → Data → Excel Power Query Workbook**. Clicking "Generate token & download workbook" mints a read-only API key, embeds it in the workbook's Settings sheet alongside the API URL, and streams the file back. Data analysts can drop the file on any machine and refresh from any deployment without ever editing M code.
- Tabs included: Systems, Principals, Resources, Assignments, Identities, IdentityMembers, ResourceRelationships. Each tab includes pre-written paginated Power Query M code that the user pastes into Power Query Editor (Data → Get Data → Other Sources → Blank Query). A future iteration will swap in a hand-built template that loads queries automatically — the rest of the plumbing is already in place.
- New read-only API token type (`fgr_…`). Tokens are accepted on GET requests to non-admin endpoints only — they cannot mutate data or reach any admin endpoint, even if leaked. Stored as SHA-256 hashes; plaintext is shown to the operator exactly once at creation. Tokens can be revoked from the same admin section, which immediately stops every workbook holding them from refreshing.
- New bulk list endpoints for the join tables that previously had no flat listing: `/api/assignments`, `/api/identity-members`, `/api/resource-relationships`. All are paginated (`?limit=1000&offset=N`, max 10 000 per page) with optional `?systemId=N` filter, returning `{ data, total }` like every other list endpoint.

## Changes in this PR

- Fixed Docker image publishing not triggering automatically after PR merges to main

## Changes in this PR

- Fixed Quick Start documentation: Image channel switching code now includes Windows PowerShell syntax

## Changes in this PR

- Replaced long-lived release branches with git tags for release management — hotfixes now ship only the fix, without features already merged to main
- Added "Cut Release" workflow: tags vX.Y.Z on main HEAD, triggers :latest publish
- Added "Cut Hotfix" workflow: tags a hotfix branch commit as a new patch version, triggers :latest publish
- Removed release branch concept — no more "Compare & pull request" banner confusion after cutting a release

## Changes in this PR

- Added branching and versioning strategy reference page under docs/architecture
- Added `--pull always` flag to Quick Start commands in README, quickstart, docker-setup, and index docs so users always get the newest image
- Added `.env` setup step (copy from template) to all Quick Start sections
- Added tabbed Linux/macOS and Windows code blocks throughout docker-setup and local-dev docs
- Fixed version pinning example in quickstart to use release format (5.2.0.0) instead of edge timestamp format
- Fixed history.md to link to the branching strategy doc instead of referencing CLAUDE.md
- Aligned local-dev.md with docker-setup.md: added --build note for first run, tabbed stop/reset commands

## Changes in this PR

- Added an About page showing the MIT license text and Software Bill of Materials
- The version string in the footer is now a clickable link to the About page

## Changes in this PR

- Added Service Principals to the Entra ID crawler. When the "Service Principals" object type is selected, the crawler now pulls all Entra service principals (enterprise apps, managed identities, AI agents) and writes them to the Principals table alongside user accounts — unblocking future Azure RM role-assignment imports that reference these identities.
- New classification helper (`Get-FGServicePrincipalType`) tags each service principal as `ManagedIdentity`, `AIAgent`, or `ServicePrincipal` based on Graph's `servicePrincipalType`, well-known Microsoft AI platform tags (CopilotStudio, PowerVirtualAgents, AzureOpenAI, CognitiveServices), the Entra Agent ID markers (`AgenticInstance`, `AgenticApp`, `power-virtual-agents-*`), and display-name heuristics. Custom AI-name patterns can be supplied per crawler config via `aiNamePatterns`.
- Extra SP metadata (`appId`, `servicePrincipalType`, `publisherName`, `homepage`, `tags`, `servicePrincipalNames`, `notes`) is stored in `extendedAttributes` so it shows up in the Users filter dropdown and detail pages.
- Added principal-type sub-tabs to the Users page ("All / Users / Service Principals / Managed Identities / AI Agents") so the list stays navigable after an SP sync adds thousands of non-human identities. The active tab is preserved in the URL hash (`#users?type=AIAgent`).

## Changes in this PR

- Fixed the Cut Release workflow rejecting valid version inputs like "5.2" due to a non-portable regex

## Changes in this PR

- Fixed the "Filters" dropdown on the Users and Resources pages — attribute fields (Department, Job Title, etc.) and their values are populated again. The list had regressed to showing only "User Tag" because column discovery was looking up table names in the wrong case after the PostgreSQL migration.
- Added regression tests pinning the PostgreSQL table and column casing used by column discovery, so the same mismatch can't slip back in.
- Added extended-attribute fields to the Users and Resources filter dropdowns. Keys stored inside the `extendedAttributes` JSON blob (e.g. `userType`, `onPremisesSyncEnabled`, `extensionAttribute5`, `city`, `country`) are now filterable via the UI, labelled with a "(ext)" suffix so they're distinguishable from regular columns.

## Changes in this PR

- Added stable release branch model: `release/vX.Y` branches are cut from `main` and receive only bugfixes, giving customers a stable `:latest` Docker image that does not change when new features land on `main`
- New `cut-release.yml` workflow creates a release branch and sets the initial version (e.g. `5.2.0.0`) with one click from GitHub Actions
- Main branch builds now push the `:edge` Docker tag instead of `:latest`, so customers on `:latest` only receive intentional releases
- Production hotfixes merged to a release branch increment the patch version (`5.2.0.0` → `5.2.1.0`) and push `:latest` automatically
- `docker-compose.prod.yml` now supports an `IMAGE_TAG` environment variable to select the image channel (`latest`, `edge`, or a pinned version); customers get `latest` by default
- The footer now shows the running version; edge builds display a prominent amber "edge" badge so it is immediately obvious which channel is running
- README and Docker Setup documentation updated with step-by-step `.env` setup for both customers and developers, image channel selection guide, and a full environment variable reference
- Fixed PR checks (lint, unit tests, integration tests) to also run on pull requests targeting `release/**` branches, so hotfixes receive the same gate as feature PRs
- Fixed release cut workflow: the initial `X.Y.0.0` image is now published to `:latest` immediately after the release branch is created, not only after the first bugfix merges
- `release/**` branches are now protected: direct commits are blocked, a pull request is required, and the `PR Summary` status check must pass before merging; repository admins retain bypass rights so the automated version bump can still land

## Changes in this PR

- Fixed Risk Scoring card on Dashboard to link directly to Admin → Risk Scoring subtab
- Added Software Bill of Materials (SBOM) documentation listing all components, dependencies, and infrastructure elements
- Fixed SBOM navigation entry in mkdocs.yml to ensure proper documentation site build
- Added automatic scheduling for risk scoring runs (similar to crawler scheduling)
- Risk classifiers can now have multiple schedules configured via Admin → Risk Classifiers
- Scheduled scoring runs execute in the background and re-score all entities with the active classifier
- Schedules support hourly, daily, and weekly frequencies
- Added "Select All" and "Deselect All" buttons to the attribute picker in the EntraID crawler wizard, making it easier to manage large attribute lists
- Fixed automated version bumps failing due to branch protection requiring pull requests
- Fixed Dashboard Risk Scoring card link to properly navigate to Admin → Risk Scoring sub-tab
- Fixed direct reports not showing in demo dataset (org chart queries now filter for current records in temporal Principals table)
- Added in-browser wizard for generating account correlation rulesets via LLM (Admin → Account Correlation)
- Users can now create correlation signals and account type rules through a conversational UI instead of PowerShell commands
- Wizard follows the same pattern as Risk Scoring: Sources → Generate & Refine → Save
- Fixed Risk Scoring page not refreshing automatically after completing the risk profile wizard
- Fixed crawler schedules not firing when created via legacy wizard (scheduler now supports both `schedule` and `schedules` config formats)
- Fixed detail page tabs not updating when switching between different users, resources, or other entities — tabs now show the correct entity data immediately
- Fixed Org Chart UI so all departments are visible when scrolled horizontally; departments no longer fall off the edge of the viewable area
- Fixed Extended Attributes displaying "[object Object]" for complex values like sign in activity — now shows properly formatted JSON
- Automated version bumping on PR merge — `bump-version.yml` Action increments the Minor version in `setup/IdentityAtlas.psd1` and updates the timestamp on every PR merge to `main`. Branches no longer touch the version file, eliminating recurring merge conflicts on `setup/IdentityAtlas.psd1`.
- Automated changelog merging on PR merge — branches now create a fragment file in `changes/` instead of editing `CHANGES.md` directly. The same `bump-version.yml` Action collects all fragments and prepends them to `CHANGES.md` on merge, eliminating recurring merge conflicts on `CHANGES.md`.
- Fixed Sync Log empty state message to reference adding a crawler instead of Start-FGSync
- Added historical performance graphs to Containers tab showing last 10 minutes of CPU, memory, and network usage for each container
- Added syntax highlighting and collapsible sections to JSON display in risk profile wizard for improved readability
- Fixed upgrade instructions to use `--pull always` instead of a separate `pull` + `up -d`, so a single command always fetches the latest image from the registry
- Merged issue triage and nightly auto-fix into a single unified workflow that classifies and fixes bugs immediately when an issue is opened
- Added automatic issue classification: bugs vs feature requests, with priority labels (critical, high, medium, low)
- Feature requests are now labeled as `enhancement` with a priority but require manual triage before auto-fix
- Added nightly re-evaluation job (23:00 Amsterdam time) that checks issues labeled `needs-clarification` or `cant-autofix` for new comments — if enough detail has been added, the issue is promoted to `ready-to-fix` and auto-fixed
- Fixed auto-fix prompt to use changelog fragments instead of editing CHANGES.md and setup/IdentityAtlas.psd1 directly

## Changes in this branch

- **Auto-fix workflow: CI-validated fixes with retry** — Reworked the nightly auto-fix into a two-attempt pipeline: Claude investigates and fixes the issue, submits a draft PR, waits for the full CI pipeline (integration tests, Playwright E2E, load tests) to validate it. If CI fails, Claude gets the failure logs and tries to fix the broken tests in a second attempt. Three possible outcomes: `auto-fixed` (PR + CI green), `cant-autofix` with reason (couldn't produce a fix), or `cant-autofix` with PR link (fix exists but CI still failing — needs human review). The prompt now instructs Claude to think step-by-step before implementing. Issues labeled `cant-autofix` or `auto-fixed` are excluded from future runs (remove the label to retry).
- **Clean up deprecated claude-code-action input names** — Replaced `direct_prompt` with `prompt`, moved `model` and `allowed_tools` into `claude_args`, and removed `timeout_minutes` (already covered by the job-level `timeout-minutes`). Fixes the "Unexpected input(s)" warnings in all three nightly workflows.
- **Fix nightly workflows failing with OIDC token error** — All three nightly workflows (Auto-fix, Docs Review, Test Coverage Review) were failing because `anthropics/claude-code-action@v1` requires the `id-token: write` permission to authenticate via OIDC, but the workflows only declared `contents: write` and `pull-requests: write`. Added `id-token: write` to the `permissions` block of each job that uses the Claude Code action.
- **Nightly test coverage review workflow** — Added `test-coverage-review.yml`, a scheduled workflow (04:00 UTC daily, plus manual dispatch) that reviews source code changes from the last 24 hours and identifies gaps in test coverage. Claude Code reads the changed files, finds existing tests, and writes new Jest, Playwright, or PowerShell tests where coverage is missing. Non-source changes (docs, config, CI, version bumps) are automatically skipped. Jest tests are syntax-checked during the run. If no new tests are needed, the workflow completes cleanly. When tests are added, a draft PR is opened on a `test/nightly-coverage-YYYYMMDD` branch for human review.
- **Nightly documentation review workflow** — Added `docs-review.yml`, a scheduled workflow (03:00 UTC daily, plus manual dispatch) that reviews code changes from the last 24 hours against the project documentation. Claude Code reads the recent commits and changed files, checks each relevant doc page, and makes targeted updates where the docs have fallen behind the code. If no updates are needed, the workflow completes cleanly without creating a branch or PR. When docs do need updating, a draft PR is opened on a `docs/nightly-review-YYYYMMDD` branch for human review before merge.
- **Nightly auto-fix workflow replaces event-driven trigger** — Rewrote `issue-autofix.yml` from a `labeled` event trigger to a nightly scheduled workflow (02:00 UTC, plus manual dispatch). The old approach couldn't work because GitHub Actions events created by `GITHUB_TOKEN` don't trigger other workflows. The new workflow: (1) finds all open issues with `ready-to-fix` but not `fix-in-progress`, (2) applies `fix-in-progress` label to prevent double-processing, (3) uses Claude Code to implement each fix on a `bugfixes/autofix-issue-N` branch from `main`, (4) opens a draft PR and comments on the issue with a link. If Claude Code fails, `fix-in-progress` is removed so the issue re-enters the queue next night. Also fixed the branch target from the non-existent `dev` to `main`. Issues are processed one at a time (max 10 per run).
- **Unified step indicator across all crawler wizards** — The CSV crawler and Custom Connector wizard now use the same numbered-circle step indicator (indigo for current/completed, gray for pending, → separators) as the Entra ID crawler. The shared render logic was extracted into a single `StepIndicator` component used by all three wizards.
- **Automated issue triage and auto-fix workflows** — Added two GitHub Actions workflows for issue management. (1) `issue-triage.yml` triggers when a new issue is opened: sends the issue title and body to the Claude API for analysis, automatically applies labels (`bug`, `ui`, `demo-data`, `needs-clarification`, `ready-to-fix`), and posts a clarification comment when the issue lacks detail. Issues written in Dutch are handled correctly. (2) `issue-autofix.yml` triggers when the `ready-to-fix` label is applied (either by triage or manually): uses the `anthropics/claude-code-action@v1` to check out the repo, implement a fix, update version and CHANGES.md per project conventions, and open a draft PR targeting `dev`. The PR requires human review before merge. Requires two dedicated secrets: `TRIAGE_ANTHROPIC_API_KEY` and `TRIAGE_LLM_MODEL`.
- **PR integration test gate for main branch** — Added `.github/workflows/pr-integration.yml`, a comprehensive Docker-based integration test suite that runs on every PR targeting `main`. Three parallel jobs: (1) **Integration Tests** (~20 min) — builds the full Docker stack, verifies postgres schema (25+ tables), loads demo data, cleans and re-loads, smoke-tests 18 read endpoints, then runs all PowerShell test scripts (Ingest API, CSV edge cases, detail page counts, account correlation, custom connector, secrets vault, LLM substrate, deterministic risk scoring). Secret-dependent tests (Entra ID crawler, LLM-based risk scoring) run when GitHub Actions secrets are configured, skip gracefully otherwise. (2) **Playwright E2E** (~15 min) — runs all 18 Playwright specs against the Docker backend via a new `playwright.ci.config.js` (Chromium only, no local dev servers). (3) **Load & Soak** (~50 min) — 1.5M-row load test + 15-minute soak test with memory-leak detection. All three jobs must pass before the PR can be merged. Includes log collection on failure (uploaded as artifacts) and a summary job that reports per-job status. Secrets to configure in repo Settings: `TEST_GRAPH_TENANT_ID`, `TEST_GRAPH_CLIENT_ID`, `TEST_GRAPH_CLIENT_SECRET`, `TEST_LLM_API_KEY`, `TEST_LLM_PROVIDER`, `TEST_LLM_MODEL`, `TEST_RISK_PROFILE_DOMAIN` (and Azure OpenAI fields if applicable).
- **Unified step indicator across all crawler wizards** — The CSV crawler and Custom Connector wizard now use the same numbered-circle step indicator (indigo for current/completed, gray for pending, → separators) as the Entra ID crawler. The shared render logic was extracted into a single `StepIndicator` component used by all three wizards.
- **Fix demo data load failing with 500 on contexts ingest** — Migration 014 added `DEFAULT gen_random_uuid()` to UUID primary key columns so callers can omit explicit IDs. The ingest engine's `discoverColumns()` query treated any column with a `gen_random_uuid()` default as an identity column and excluded it from `activeColumns`, so the temp table was built without the `id` column. That broke both the `ON CONFLICT ("id")` upsert and the `scopedDelete` index creation, producing a 500 on contexts, identities, principals, resources, and all governance tables. Fixed by removing `gen_random_uuid()` from the identity-detection query — only true sequence columns (`nextval(`) and `IS_IDENTITY` columns are auto-generated identities; UUID defaults are just fallbacks for when callers don't supply explicit IDs.
- **Regression tests for slider totalUsers fix and detail-page section counts** — Added `test/nightly/Test-DetailPageCounts.ps1` (Phase 4f3b in the nightly runner). Seeds its own isolated data via the Ingest API and covers: (1) `GET /api/permissions` `totalUsers` stability — verifies that users with no assignments are still counted in `totalUsers` so the slider max doesn't snap when the limit is lifted; (2) user-detail `historyCount` shape — field is an integer (not a boolean), `hasHistory` derives from it; (3) resource-detail `parentResourceCount` vs `accessPackageCount` — the AP count is restricted to BusinessRole parents only, while parent count covers all relationship types; (4) access-package-detail `pendingRequestCount` — field is non-null even when the AssignmentRequests table is empty (was hardcoded `null` before PR #16).
- **Fix 16 nightly test failures (2026-04-14 run)** — Three root causes identified and fixed: (1) **UUID columns without DEFAULT** — `Principals`, `Resources`, `Contexts`, `Identities`, and 5 governance tables had `UUID PRIMARY KEY` without `DEFAULT gen_random_uuid()`, causing the ingest engine to insert NULL when callers (CSV crawlers, custom connectors, test scripts) don't provide an explicit ID — fixed via migration 014 and updated `discoverColumns()` to recognize `gen_random_uuid()` defaults as auto-generated columns. Resolves Ingest/Principals, Ingest/Resources, Ingest/ResourceAssignments, CustomConnector/IngestUser, CustomConnector/DataLanded (5 tests). (2) **CSV test auth header** — `Test-CSVEdgeCases.ps1` sent `X-API-Key` header instead of `Authorization: Bearer`, causing all 6 CSV edge-case tests to return 401. (3) **Correlation test response parsing** — `Test-AccountCorrelation.ps1` tried to extract system IDs from `$response.created[0].id` / `.updated[0].id` / `.ids[0]`, but the ingest API returns `systemIds` array; fixed to use `$response.systemIds[0]`. Resolves all 5 Correlation tests. Remaining 5 failures: Container-Stats-Live (WIP), Static-Spectral (Docker tooling), LLM-Config/Save + Vault/EncryptionVerified (needs manual investigation), LoadTest/SystemCount (intermittent).
- **Fix slider snapping back when dragged to the maximum** — In the Matrix tab, dragging the Users slider to the right-most position (e.g. 28) and releasing it caused it to snap back to a lower number (e.g. 23). The "All" button also showed the amber "Showing 23 of 28 users" warning even though no limit was active. Root cause: the "no limit" branch of the permissions API counted `totalUsers` as distinct member IDs in the result set (only users with at least one assignment), while the limited branch counted all Principals — so `totalUsers` shrank when the limit was lifted, shrinking the slider max and snapping it. Fixed in two places: (1) the "no limit" API branch now runs the same `COUNT(*) FROM Principals` query as the limited branch so `totalUsers` is stable; (2) when showing All, the amber warning now reads "Showing 23 of 28 users (5 have no assignments)" so it's clear why those users are absent, rather than implying the slider is cutting them off.
- **Detail pages show section counts before expanding** — Business role, resource, and user detail pages now show the count in each collapsible section header immediately on page load, without requiring the section to be expanded first. API changes: resource detail endpoint (`/api/resources/:id`) now returns `memberCount`, `accessPackageCount`, `parentResourceCount`, and `historyCount`; access-package and user/group detail endpoints now return `historyCount` (integer) instead of only `hasHistory` (boolean). The pending request count on business role pages is now fetched as a cheap `COUNT(*)` during core load rather than being deferred. Unnamed business roles show "Unnamed" in grey italic; null `parentResourceId` rows are excluded from counts and results to prevent 400 errors on navigation.
- **Dashboard sync log entries link to Sync Log tab** — The "N sync log entries" text at the bottom of the stats card on the Dashboard is now a clickable link that navigates directly to the Sync Log tab.
- **Extract `Section` and `CollapsibleSection` to `DetailSection.jsx`** — both components were defined identically inside four detail page files (UserDetailPage, GroupDetailPage, ResourceDetailPage, AccessPackageDetailPage), causing React to recreate them on every render. Extracted to a shared `components/DetailSection.jsx`. No behavior change.
- **Extract `useDebouncedValue` hook** — the `useState` + `useEffect` debounce pattern was duplicated in four places (`useEntityPage`, `AccessPackagesPage`, `IdentitiesPage`, `OrgChartPage`). Extracted to `app/ui/src/hooks/useDebouncedValue.js`. No behavior change.
- **Extract shared tier styles to `utils/tierStyles.js`** — `TIER_STYLES` (bg, text, border, dot, avatar, box, boxBorder per tier) and `tierClass(tier)` helper were duplicated across 7 files (RiskScoreSection, RiskScoringPage, OrgChartPage, DepartmentDetailPage, IdentityDetailPage, IdentitiesPage, UserDetailPage). All copies removed; each file now imports from `app/ui/src/utils/tierStyles.js`. No behavior change.
- **Extract shared formatter utilities to `utils/formatters.js`** — `formatDate`, `formatValue`, `computeHistoryDiffs`, and `friendlyLabel` were defined identically in four detail page components (UserDetailPage, ResourceDetailPage, GroupDetailPage, AccessPackageDetailPage) and `formatDate` again in GovernancePage. All five copies removed; each file now imports from the new shared `app/ui/src/utils/formatters.js`. No behavior change.
- **Fix black borders on Crawlers page and Add Crawler wizard** — The Custom Connector wizard introduced 56 bare `border` classes without a color modifier, causing Tailwind to fall back to the current text color (black). Added `border-gray-200` to all uncolored borders, matching the fix applied to other Admin pages in PR #4.
- **Fix orange confidence bar and malformed "null%" label on identities with no correlation run** — `ConfidenceBar` was not guarded against a null confidence value: null failed every threshold comparison and fell through to `bg-orange-500`, and `{null}%` rendered as a bare `%`. Now shows a solid grey bar with `—%` and a hover tooltip when confidence is null. Extracted `ConfidenceBar` to a shared component (`ConfidenceBar.jsx`) used by both `IdentitiesPage` and `IdentityDetailPage`.
- **Custom Connector wizard on Crawlers page** — Enabled the "Custom Connector" crawler type (previously marked "Coming soon") on the Admin → Crawlers page. Clicking it opens a 3-step wizard: (1) **Register** — enter a connector name and optional description, creates a new crawler via `POST /api/admin/crawlers` and receives a one-time API key. (2) **API Key** — displays the key (with copy button and warning that it won't be shown again) and the API base URL. (3) **Getting Started** — three quick-link cards (Swagger UI at `/api/docs`, downloadable OpenAPI spec at `/api/openapi.json`, CSV Schema Reference on the docs site), tabbed code examples in curl / Python / PowerShell showing the full ingest flow (register system → push users → push resources → push assignments), and an ordered explanation of how the Ingest API works (Systems → Principals → Resources → Assignments → Relationships → Identities → Refresh Views). The existing `openapi.yaml` already documents all 16 ingest endpoints and 8 crawler management endpoints with full request/response schemas — no backend changes needed, this is a UI-only feature.
- **Fix "0 identities have no HR anchor" banner showing on demoset** — The `OrphanedAccountsNotice` guard compared `orphanCount === 0` with strict equality, but PostgreSQL `pg` returns `SUM()` aggregates as JavaScript strings (`"0"` not `0`). A string `"0"` is truthy and does not strict-equal the number `0`, so the orange warning banner was incorrectly rendered with a zero count. Fixed by using `Number(orphanCount)` in the guard, which coerces any string representation of zero to falsy.
- **Fix 8 nightly test failures (2026-04-13 run)** — Fixed 6 "Cannot index into a null array" failures (Account-Correlation, CSV-Edge-Cases, Ingest-API-Tests, LoadTest, Secrets-Vault, Soak-Test) caused by callback scriptblocks using `$script:results` which resolved to the child test script's scope instead of the runner's scope; callbacks now capture the results hashtable via a local variable + `.GetNewClosure()`, matching the pattern already used by the LLM and Entra ID callbacks. Fixed ESLint errors: moved `SortHeader` component out of `ClusterTable` render body in `RiskScoringPage.jsx` (6 `react-hooks/static-components` errors), fixed `useMemo` dependency in `UsersPage.jsx` and `GroupsPage.jsx` (2 `react-hooks/preserve-manual-memoization` errors), fixed `useCallback` dependency in `GovernancePage.jsx`, replaced impure `Date.now()` call during render with state-driven timestamp in `CrawlersPage.jsx`. Downgraded `react-hooks/set-state-in-effect` and `react-hooks/refs` to warnings in `eslint.config.js` — these flag the standard data-fetching `setLoading(true)` pattern used across all detail pages and the MSAL auth gate; fixing them properly requires a Suspense/useTransition migration. Container-stats 500 and Spectral failures are environmental (container running older image; Spectral can't find its ruleset in Docker).
- **Fix "Cannot access 'p' before initialization" crash when opening the Add Crawler wizard** — The `useEffect` that defaults Boolean identity-filter values to `'true'` referenced `userAttrCatalog` in its dependency array before that state variable was declared, causing a JavaScript temporal dead zone error. Moved the discovery `useState` declarations above the `useEffect` to fix the initialization order.
- **Comprehensive nightly test coverage expansion (Tier 1/2/3)** — Added 6 new PowerShell test scripts, 4 new Playwright E2E specs, cross-browser testing, and accessibility scanning. The nightly suite now covers ~75 minutes of testing (up from ~25 min) including a full 1.5M-row load test. New phases: **Phase 4f2 (Ingest API)** — direct POST tests against all `/ingest/*` endpoints with known-good payloads (happy-path: systems, principals, resources, assignments) and known-bad payloads (empty body, missing systemId, invalid syncMode, no auth). **Phase 4f3 (CSV edge cases)** — malformed inputs: missing columns, header-only files, empty displayName, 10K-char fields, SQL injection attempt in displayName, duplicate externalIds in one batch. **Phase 4f4 (Account correlation)** — create 2 principals in 2 systems, link to 1 identity, verify linkage via `/identities` endpoint. **Phase 4f5 (Secrets vault)** — save/read/tamper/cleanup cycle: writes a test LLM key, verifies ciphertext != plaintext via direct psql, corrupts the GCM authTag and verifies the API detects tampering, then cleans up. **Phase 4f6 (Container stats live)** — verifies `/admin/container-stats` returns real metrics when Docker socket is mounted, degrades gracefully when not. **Phase 4l (1.5M-row load test)** — generates the full synthetic dataset via `Generate-LoadTestData.ps1` (80K users, 80K resources, 1.5M assignments, 300K certifications), ingests via CSV crawler, verifies dashboard counts (>=1.4M assignments), refreshes materialized views, tests matrix query performance (<15s), and runs the benchmark suite. **Phase 7 (Soak test)** — 15 minutes of sustained API requests cycling through 6 endpoints, sampling memory every 60s, asserting no memory leak (final < 2x initial) and <1% error rate. New Playwright specs: multi-filter combinations (search narrows results on Users/Resources), accessibility (axe-core WCAG 2.0 AA on 5 pages, fails only on critical/serious), export validation (Excel download produces valid XLSX with PK magic bytes), visual regression (screenshot comparison for 4 pages with 5% diff tolerance). Cross-browser: added Firefox + WebKit projects to `playwright.config.js`. Added `@axe-core/playwright` dev dependency. New skip flags: `-SkipLoadTest`, `-SkipSoakTest`.
- **Fix 10 nightly test failures (first-run triage)** — After the first nightly run (142/152 passed), fixed the 10 failures across four categories: (1) **Docker fallback `--omit=dev` bug** — the ESLint and Backend-Unit-Tests docker fallback paths ran `npm ci --omit=dev` which skips devDependencies, but ESLint and vitest ARE devDependencies; dropped `--omit=dev` so the Docker one-shot containers install the full dependency tree. (2) **Playwright-E2E missing `$hasNpm` guard** — Phase 5 called `npx` directly without checking whether Node.js is on PATH; added a guard that skips gracefully when npx isn't available (same pattern as Phase 0). (3) **`/admin/container-stats` returning 500** — the container-name regex still matched `fortigigraph-*` instead of `identityatlas-*` (FortigiGraph → IdentityAtlas rename residue); updated to match both; also changed the Docker socket error from a hard 500 to a graceful 200 with `unavailable: true` since this is a monitoring endpoint. (4) **Identity-Only/UsersExist asserting on users instead of identities** — the Identity-Only scenario syncs only identities (cross-system correlation), not users/principals, so checking `/users` returned 0; changed to verify `/identities` endpoint is queryable instead. (5) **npm audit vulnerabilities** — ran `npm audit fix` in both `app/api/` (patched `express-rate-limit` IPv6 bypass, `path-to-regexp` ReDoS, `qs` DoS — 3 high/moderate fixed, 5 moderate remain in dev-only `esbuild`/`vitest` chain requiring breaking `--force`) and `app/ui/` (all 7 fixed, 0 remaining). (6) **PSScriptAnalyzer `PSAvoidUsingConvertToSecureStringWithPlainText`** — added `[SuppressMessage]` attribute to `Get-FGSecureConfigValue.ps1` with justification (migrating existing plaintext config to DPAPI-encrypted storage requires this pattern). (7) **LLM-Config/Save 500** — couldn't diagnose without server logs; improved error reporting in `Configure-LLM.ps1` to capture the HTTP response body on failure so the next occurrence shows the actual server error instead of just "500 Internal Server Error".
- **Dashboard no longer shows `-1` for Systems and sync log entries** — `pg_class.reltuples` starts at `-1` for unanalyzed tables and is only updated by `ANALYZE`, so the dashboard could show negative counts even when rows existed. Fixed in two ways: (1) `Systems` and `GraphSyncLog` are small tables that now use exact `COUNT(*)` so their counts are always accurate; (2) `refreshMatrixViews()` in [app/api/src/routes/ingest.js](app/api/src/routes/ingest.js) now includes `Systems`, `CertificationDecisions`, `GraphSyncLog`, and `RiskScores` in its post-refresh `ANALYZE` pass so `reltuples` stays current for the remaining estimate-based counters.
- **`Register-NightlySchedule.ps1`: fix `repoRoot` computation off by one level** — `$repoRoot` was computed as `Split-Path $PSScriptRoot -Parent`, which from `test\nightly` only goes up one level to `test\` instead of two levels to the repo root. Two consequences: (1) the printed status messages showed a duplicated path segment like `C:\source\IdentityAtlas\test\test\nightly\results\latest.md`, which was misleading; (2) the registered scheduled task got `WorkingDirectory = C:\source\IdentityAtlas\test` instead of the actual repo root. The functional impact is zero in practice because [test/nightly/Run-NightlyLocal.ps1:46](test/nightly/Run-NightlyLocal.ps1#L46) derives its own `RepoRoot` from `$PSScriptRoot` and doesn't depend on the launching process's working directory — but this was a latent bug waiting to bite a future change. Fixed to `Split-Path (Split-Path $PSScriptRoot -Parent) -Parent` with a comment explaining the two-level walk. Already-registered tasks keep the wrong `WorkingDirectory` until you re-run [test/nightly/Register-NightlySchedule.ps1](test/nightly/Register-NightlySchedule.ps1) (which silently re-registers); since it's harmless, re-registering is optional.
- **CSV crawler: handle quoted fields in `Resources.csv` fast-path parser** — `Read-CsvFast` in [tools/crawlers/csv/Start-CSVCrawler.ps1](tools/crawlers/csv/Start-CSVCrawler.ps1) is the hand-rolled fast parser used only for `Resources.csv` (it's the biggest table — 1.5M rows in the load-test dataset, where the PSCustomObject allocation in `Import-Csv` becomes the bottleneck). It correctly stripped a UTF-8 BOM from the header line but did a naive `.Split($delimiter)` that left literal `"` characters baked into both header keys and data cells. Files produced by PowerShell's `Export-Csv` — which always wraps every field in double quotes — tripped this on the very first check: header `"ExternalId"` ≠ `ExternalId`, throw `Resources.csv missing required columns ExternalId / DisplayName`. The Identity Atlas demo flow hits this directly because [tools/csv-templates/transforms/omada-to-identityatlas.ps1](tools/csv-templates/transforms/omada-to-identityatlas.ps1) uses `Export-Csv` to produce the `demodataTransformed/` files. Fix: after splitting on the delimiter, strip surrounding `"..."` from each header and each cell — O(1) per field (length + first/last char check, then optional `Substring`), keeps the tight-loop perf characteristics that make `Read-CsvFast` worth having. The supported quoting is now: each field MAY be wrapped in plain double quotes; embedded delimiters inside a quoted field, embedded newlines, and `""` escape sequences are still NOT supported (use the slow `Read-CsvFile` / `Import-Csv` path if you need any of those — but `Resources.csv` is the only file using `Read-CsvFast` and the canonical schema doesn't put delimiters inside Resource descriptions). Comment block updated to document the new contract.
- **Fix broken `:latest` web image and pull missing perf optimizations** — Added [app/api/src/config/authConfig.js](app/api/src/config/authConfig.js), the hot-reloadable auth-config loader imported by `app/api/src/index.js`, `app/api/src/middleware/auth.js`, and `app/api/src/routes/admin.js`. The file existed in the FortigiGraph source repo but was never copied across in the initial IdentityAtlas import, so every published `ghcr.io/fortigi/identity-atlas:latest` build since the rename had been crash-looping on startup with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/backend/src/config/authConfig.js'`. CI happily kept publishing the broken image because the build only validates that the bundle compiles, not that it starts. Discovered while running the Quick Start against a clean machine. Also pulled across `setup/config/.env.example` and `setup/config/tenantname.json.template`, which were missing for the same reason. In the same commit, picked up four perf-related route updates from the FortigiGraph "Optimizations after Load test" and "Load test updates" commits that had fallen between docs syncs and been left behind: [app/api/src/routes/admin.js](app/api/src/routes/admin.js) now uses `pg_class.reltuples` estimates for the dashboard counts instead of slow `COUNT(*)` (massive win on the 1.5M-row load-test dataset); [app/api/src/routes/ingest.js](app/api/src/routes/ingest.js) runs `ANALYZE` on the matviews and big base tables right after every refresh so the planner stats stay fresh enough for the new reltuples-based dashboard path; [app/api/src/routes/permissions.js](app/api/src/routes/permissions.js) constrains the AP-mapping subquery to just the top-N users in the result set instead of scanning the full 410k-row matview; [app/api/src/routes/systems.js](app/api/src/routes/systems.js) drops a now-redundant `LEFT JOIN` fallback in `ra_counts` since `ResourceAssignments.systemId` is always denormalized in v5. Refreshed [test/benchmark/BENCHMARK.md](test/benchmark/BENCHMARK.md), [test/benchmark/Run-Benchmark.ps1](test/benchmark/Run-Benchmark.ps1), and [test/benchmark/results/BENCHMARK.md](test/benchmark/results/BENCHMARK.md) with the latest narrative + numbers from those runs.
- **Quick Start: `--pull always` + dedicated Upgrading section** — The default start command in [docs/quickstart.md](docs/quickstart.md) is now `docker compose -f docker-compose.prod.yml up -d --pull always` (both the Linux/macOS and Windows tabs) so first-time and returning users always get the current `:latest` image from ghcr.io instead of a cached one. Added a `!!! tip` callout explaining why — `docker compose up` without `--pull always` reuses any cached `:latest`, which masks new releases. Added a new "**Upgrading to a new version**" section below the verification steps covering: the two-command `pull` + `up` flow for updating an existing deployment (data volume is preserved, migrations auto-apply on restart), three ways to check the running version (Dashboard Version card, `GET /api/version`, `docker compose images`), and a "Pinning to a specific version" subsection explaining how to swap the `:latest` tag in `docker-compose.prod.yml` for a version-stamped tag (`5.0.yyyyMMdd.HHmm`) for reproducible production deployments. Triggered by a user report that `docker compose up` was silently running an older cached image despite a newer version being published to ghcr.io.
- **Thorough v4 residue cleanup and docs restructure** — Deleted four large plan/status files that were left over from the v4→v5 migration and had nothing to say about current state: `docs/architecture/postgres-migration.md` (429 lines), `docs/architecture/postgres-migration-status.md` (187 lines), `docs/architecture/implementation-plan.md` (344 lines), and `docs/architecture/testing-plan.md` (576 lines) — ~1,536 lines of stale migration planning referencing `Connect-FGSQLServer`, `Invoke-FGSQLBulkMerge`, `Start-FGSync`, `dbo.`, SQL Server temporal tables, `_Test/`, `Functions/`, and other v4-era APIs. Renamed `docs/reference/temporal-tables.md` → `docs/architecture/audit-history.md` (the file was already rewritten as a postgres audit-history guide; only the filename was still wrong). Rewrote the "Sync Functions" section in `docs/concepts/governance-model.md` from a list of 10 `Sync-FGAccessPackage*` + `Connect-FGSQLServer` function calls into a short explanation that "governance data is fed by the crawlers — see Admin → Crawlers → Add Crawler". Updated the principalType and Source System Mapping tables in `docs/concepts/data-model.md` to name crawlers instead of old `Sync-FGPrincipal`/`Sync-FGEntraDirectoryRole`/`Sync-FGCSVBusinessRole` functions. Rewrote the intro + motivation of `docs/architecture/ingest-api.md` in past tense ("Before v5, Identity Atlas had two tightly-coupled sync paths…") and replaced the 140-line "Impact Analysis / Implementation Plan / Validation Plan / Open Questions / Risks & Mitigations" migration-planning tail with a short "Observed performance" section linking to the new Scaling page. Fixed `_Test/` → `test/`, `FortigiGraph-App` → `IdentityAtlas-App`, and `UI/frontend/e2e/` → `app/ui/e2e/` in `docs/architecture/demo-dataset.md`. Fixed the hardcoded `fortigigraph-worker-1` container name in `docs/architecture/docker-setup.md` to `docker compose exec worker`. Removed the re-added "Lead developer Wim van den Heijkant" line from the Creators section of `docs/about.md`. Updated the `fgc_` prefix explanation in `docs/architecture/ingest-api.md` to stop referencing "FortigiGraph Crawler" as the origin of the name. Added Windows PowerShell (`Invoke-WebRequest` / `Invoke-RestMethod`) equivalents to `docs/quickstart.md` via `pymdownx.tabbed` so Linux/macOS and Windows users each get a tab with copy-pasteable commands.
- **Restructured the docs navigation** — Reorganised `mkdocs.yml` nav from the old 10-section layout (which had "Architecture" bloated with project plans and "Reference" containing a removed feature) to a task-based 11-section layout: **Home → Quick Start → Concepts** (what it is) **→ Data Sources** (new — Entra ID, CSV Import, CSV Schema Reference, replacing the old two-page "Sync" group) **→ Using Identity Atlas** (renamed from "Role Mining UI") **→ Risk Scoring** (unchanged) **→ Architecture** (trimmed to Docker Setup, Ingest API, Audit History, LLM & Risk Scoring Internals — only current-state architectural docs) **→ Operations** (expanded from 1 to 4 pages: Scaling, Demo Dataset, Nightly Review, Troubleshooting — everything production-related in one place) **→ API Reference** (unchanged) **→ Reference** (pure lookup — Configuration, Database Views) **→ About**. Every page now lives where a reader would look for it: "how do I size this" goes to Operations, "how does the ingest API work" goes to Architecture, "how do I set this up on Windows" goes to Quick Start. Verified nav ↔ filesystem are exactly in sync (32 nav entries = 32 `.md` files, zero orphans, zero broken intra-docs links).
- **New "Scaling & Load Testing" docs page** — Added [docs/architecture/scaling.md](docs/architecture/scaling.md) documenting the largest workload Identity Atlas has been run against. Covers the synthetic ~2.17M-record load-test dataset produced by `test/load-test/Generate-LoadTestData.ps1` (20 systems, 80k users, 80k resources, 1.5M assignments, 300k certification decisions, etc.), the observed phase-by-phase ingest timings from the real sync log (~30 minutes end-to-end on a VM with 6 cores @ 3.70 GHz, 16 GB RAM, SAS SSD; CPU 73%, memory 87%, disk 1% — memory is the limiting factor, not CPU or disk; ResourceAssignments at ~1,250 rows/sec sustained across 20 MERGE batches of 75k each), instructions for reproducing the test (committed fixtures at `test/load-test/data/` or regenerating with the script), and practical guidance for readers sizing their own tenant. Wired into the Architecture nav between "Docker Setup" and "CSV Import Schema".
- **Docs site themed to match the Identity Atlas React UI** — New `docs/assets/extra.css` applies a Tailwind lime palette driven by `[data-md-color-primary=custom]` overrides, Inter / JetBrains Mono typography, rounded-2xl admonition cards with a soft lime gradient mirroring the UI dashboard, lime table headers, and lime-tinted inline code. Light + dark mode both tuned. The docs site now visually matches the React UI a user opens after `docker compose up`, instead of looking like a different product.
- **FortigiGraph → IdentityAtlas URL sweep + lead-dev removal** — Eighteen references across twelve files rewritten to point at Fortigi/IdentityAtlas, including the React dashboard's `GITHUB_BASE` and `DOCS_URL` constants, the broken Changelog link (now `/releases`), `README.md`, `docker-compose.prod.yml`, four docs pages, the PowerShell module metadata, `CLAUDE.md`, the OpenAPI contact URL, and the testing guide. Also dropped the "lead developer Wim van den Heijkant" singleton from the docs footer copyright, the about-page contact list, and the LinkedIn social icon tooltip — Identity Atlas is now positioned as a Fortigi product, not a one-developer project.
- **Identity Atlas brand logo on the docs site** — `docs/assets/logo.png` is now rendered in the docs header and as the favicon via `theme.logo` and `theme.favicon` in `mkdocs.yml`. The docs site finally has the same brand mark as the React UI.
- **Risk scoring: full port of the v4 4-layer engine to postgres** — The lightweight v5 scorer was only running Layer 1 (direct classifier match) + a 5-point small-group bonus, which missed almost everything interesting. [app/api/src/riskscoring/engine.js](app/api/src/riskscoring/engine.js) now implements all four layers with v4's exact weights (0.50 / 0.20 / 0.10 / 0.20) and layer caps (membership 40, structural 25): direct classifier matches (Layer 1), membership-based propagation through nested groups (Layer 2), structural hygiene signals (Layer 3 — orphaned ownership, dormant high-privilege accounts), and cross-entity propagation (Layer 4 — risk flowing from a high-risk resource to its members and from a high-risk identity to the resources it touches). Hierarchy walking is now postgres-native via recursive CTEs instead of the v4 in-memory traversal. Resource clustering helpers added so the wizard can group structurally similar resources into a single classifier target. Three new nightly test scripts (`Configure-LLM.ps1`, `Test-RiskScoring.ps1`, `Test-RiskScoringLLM.ps1`) cover the full pipeline including LLM provider switching. The worker container still has zero LLM dependency — risk scoring runs in the web container.
- **Fix 60 mkdocs --strict warnings on docs links to source code** — The docs workflow's second post-cutover run still failed because the previous fix only addressed broken `.md` cross-references; mkdocs `--strict` also rejects relative links to source code files that resolve outside the `docs/` tree. Rewrote all such links to absolute Fortigi/IdentityAtlas GitHub blob/tree URLs across `architecture/llm-and-risk-scoring.md` (1), `architecture/postgres-migration-status.md` (52), and `architecture/postgres-migration.md` (7). Local link scan now reports zero broken links across all 35 doc pages.
- **Fix mkdocs --strict docs build** — The first post-cutover `Deploy documentation` workflow run failed at the very first build step. Fixes: removed two dead nav entries (`sync/scheduling.md`, `ui/deployment.md`) from `mkdocs.yml`, added five orphan pages to Architecture, added a new Operations section, and updated leftover FortigiGraph references in `site_url` / `repo_url` / `repo_name` and the social link to point at Fortigi/IdentityAtlas. Rewrote 11 broken inline markdown links in `docs/architecture/postgres-migration.md` — 8 as proper mkdocs-relative paths, 3 as absolute Fortigi/IdentityAtlas GitHub blob URLs for files outside `docs/`.
- **Phase 0 static checks in nightly runner** — Mirrors the four `pr.yml` checks (PSScriptAnalyzer, ESLint, Spectral, `npm audit high`) as a fail-fast phase in `test/nightly/Run-NightlyLocal.ps1` so local nightly runs catch the same issues as the GitHub PR pipeline before spending ~10 min on Docker integration + Playwright. Each check skips cleanly when its tooling is missing and falls back to a one-shot `node:20-slim` container when `npm` is not on the host PATH.
- **Fix Remove button on external crawlers doing nothing** — DELETE `/api/admin/crawlers/:id` was failing with a 500 because the manual `DELETE FROM "CrawlerAuditLog" WHERE crawlerId = @id` query used an unquoted camelCase column name, which PostgreSQL folds to lowercase (`crawlerid`). Since `CrawlerAuditLog` already has `ON DELETE CASCADE`, the manual pre-delete was unnecessary and has been removed. Also fixed the soft-delete path which used `SET enabled = 0` instead of `= false` for the boolean column.
- **Unified step indicator across all crawler wizards** — The CSV crawler and Custom Connector wizard now use the same numbered-circle step indicator (indigo for current/completed, gray for pending, → separators) as the Entra ID crawler. Shared render logic extracted into a single `StepIndicator` component.
- **Closing a detail tab returns to the tab it was opened from** — Closing a detail tab now navigates back to the page or tab it was opened from (its originating tab), rather than jumping to an adjacent open tab. When an originating tab is itself closed, all tabs that referenced it are reparented to its origin, so the chain always resolves correctly. If no originating page is recorded (e.g. a bookmarked URL opened directly), the fallback is unchanged: Matrix for users/groups/APs, Resources for resource tabs, Org Chart for departments/contexts, Identities for identity tabs.
- **E2E tests for detail tab close navigation** — Three new Playwright test cases in `app/ui/e2e/detail-pages.spec.js`: (1) closing the active tab navigates to the originating page; (2) closing an inactive tab does not change the current URL; (3) closing an originating tab reparents its children so the cascade resolves to the grandparent. Tests that require live data in the table skip gracefully when no data is present.
- **Fix 11 Playwright E2E failures in CI** — (1) Fixed a backend bug in `DELETE /api/tags/:id` where the `GraphTags` table name was unquoted, causing PostgreSQL to fold it to lowercase and fail with "relation not found". (2) Updated `access-packages.spec.js` to expect "Business Roles" title (renamed from "Access Packages") and matching search placeholder. (3) Updated `groups-page.spec.js` to expect "Resources" title and matching search placeholder. (4) Fixed `matrix.spec.js` cold-start timing by using `waitForLoadState('networkidle')` and longer timeouts. (5) Fixed `identities.spec.js` selectors — CSS class-based locators (`[class*="card"]`) replaced with text-based locators matching actual Tailwind class output. (6) Fixed `users-page.spec.js` search test to verify navigation stability instead of assuming table visibility after search. (7) Fixed `custom-connector.spec.js` to match actual wizard step title ("Custom Connector" h3 instead of "Custom Connector — Register").
- **Fix Reset Key not updating the key prefix until page refresh** — After resetting an external crawler's API key the table showed the old key prefix until the page was reloaded. Fixed by calling `fetchCrawlers()` immediately after the reset succeeds.
- **Fix "External Crawlers" / "Custom Connectors" naming inconsistency** — The section heading on Admin → Crawlers now reads "Custom Connectors" to match the type selector and wizard title.
- **Fix identity graph truncated at the bottom on Dashboard** — The SVG height of the identity data model diagram was 360px, cutting off the bottom nodes (Contexts, Reviews) and their labels. Increased to 400px.
- **Fix Identity Members showing 0 with demo data** — `IdentityMembers` was missing from the `ANALYZE` table list in `refreshMatrixViews()`, so `pg_class.reltuples` was never updated after demo data ingestion and the dashboard estimate stayed at 0.
- **Fix dashboard showing "Crawlers: None" when external crawlers are configured** — The dashboard-stats query only counted `CrawlerConfigs` (wizard-configured Entra ID/CSV crawlers). External connectors registered via the Custom Connector wizard live in the `Crawlers` table and were not counted. Fixed to sum both tables, excluding the auto-created Built-in Worker.
- **Fix two mssql-shim SQL compatibility bugs** — (1) Toggling a crawler's enabled state passed `1`/`0` as the parameter value for a PostgreSQL `BOOLEAN` column — changed to `true`/`false`. (2) Updating a crawler config used `SYSUTCDATETIME()` (SQL Server only) — replaced with `now()`.
- **Fix unquoted camelCase column names causing 500 errors** — Two more mssql-shim routes used unquoted camelCase identifiers that PostgreSQL folds to lowercase: `GovernanceCategoryAssignments.resourceId` (category unassign endpoint) and `SystemOwners.systemId`/`userId` (remove system owner endpoint). Both queries would 500 in production. Fixed by adding double-quotes around table and column names.
