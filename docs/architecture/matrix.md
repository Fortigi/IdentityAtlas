---
type: task
prereq: ui/overview.md
outcome: You can read any cell in the matrix and say exactly how that access is held.
---

# Matrix view — architecture

!!! info "Before this page"
    Assumes you have read **[The app at a glance](../ui/overview.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

> **Status:** current as of May 2026.
> Companion to [`013_matrix_matviews_and_indexes.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/013_matrix_matviews_and_indexes.sql), [`024_matrix_view_all_assignment_types.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/024_matrix_view_all_assignment_types.sql), [`046_owner_as_resource.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/046_owner_as_resource.sql), [`049_governed_intent_rows.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/049_governed_intent_rows.sql).

## The grid

Rows are **resources**. Columns are **principals** (users / service principals / managed identities — *not* groups, see below). Each cell describes whether the column-principal has the row-resource and, if so, *how*.

```
                   alice    bob    carol    ...
Sales Team           D                       <- group membership
Reader on CRM        D       I              <- app role (direct vs. via group)
HR-Manager BR        D                       <- BusinessRole assignment
DelegatedPerm: …             D               <- OAuth2 user consent
```

(That last cell is an `OAuth2Grant` row — it renders as **D**, since the badge only carries *how* the user holds it; the `DelegatedPermission` resource type carries the *what*. See "Badge collapse" below.)

## Data source

A single materialized view: `vw_ResourceUserPermissionAssignments`. Refreshed at web boot via `bootstrap.js → refreshMatrixViews()` and at end-of-sync via `POST /api/ingest/refresh-views`.

Shape:

| Column | Purpose |
|---|---|
| `resourceId` | Row (joined to `Resources` for displayName etc.) |
| `principalId` | Column (joined to `Principals` — group-typed rows fall out at the JOIN) |
| `principalType` | Passed through; legacy filter against `'#microsoft.graph.group'` is dead in v5 but harmless |
| `membershipType` | What badge to render — see badge collapse below |
| `managedByAccessPackage` | Drives AP color overlay on the cell |

The view itself is a single `SELECT FROM "ResourceAssignments"` with no `assignmentType` filter — every type stored in the base table flows through automatically. The legacy hardcoded UNION of `Direct/Owner/Eligible/Governed` was removed in migration 024 so future assignment types don't need a migration to surface.

### Resource metadata columns (Contexts pinned left, `#` | Type | Description right)

Every resource row carries read-only metadata either side of the grid. The
pinned info block is **drag handle | Resource Name | Contexts**; the right-side
block is **`#` | Type | Description**. **Contexts** lists the Contexts the
resource belongs to — group category, tags, clusters, business processes — so
the category of a group is visible without an export. It sits in the pinned
block (where resource Type used to be) so it stays on screen while the grid
scrolls horizontally; Type moved to the right-side block in exchange.

It rides the flat-grid response as a sidecar, not a per-row fetch: `handleFlatGrid`
returns `resourceContexts: [{ resourceId, contexts: [{ id, displayName, contextType }] }]`,
computed by one indexed batch query over `ContextMembers` → `Contexts`
(`fetchResourceContexts` in `app/api/src/matrix/resourceContexts.js`), scoped to
the resources actually on the grid and to `memberType = 'Resource'`. The same
join backs `GET /api/resources/:id/contexts`. Rows are server-sorted by
`contextType`, then `displayName`; the cell shows the first two as chips and
collapses the rest behind a `+N` toggle, while the Excel export writes the full
comma-joined list.

Only **Resource-targeted** memberships appear — an Identity- or Principal-targeted
context (a department, an org unit) is a property of the people in a group, not of
the group, and never shows on a resource row. The column is display-only: filtering
by context stays in the filter wizard's context picker (`buildContextClause` in
`matrix/filterSql.js`). Flat per-subject grid only; the roll-up / layered /
attribute-fold views aggregate resources and have no per-resource row.

## Badge collapse — what each letter actually means

The user reads three letters. The DB stores a handful of assignment types. The translation lives in migration 049's CASE expression and is intentionally lossy:

| Raw `assignmentType` in ResourceAssignments | Displayed `membershipType` | Badge |
|---|---|---|
| `Direct` | `Direct` | **D** |
| `Indirect` | `Indirect` | **I** |
| `Eligible` | `Eligible` | **E** |
| `OAuth2Grant` | `Direct` | **D** |
| `AppRole` | `Direct` | **D** |
| `AppRoleViaGroup` | `Indirect` | **I** |
| `DirectoryRole` | `Direct` | **D** |
| `DirectoryRoleEligible` | `Eligible` | **E** |

There is **no `O` (Owner) badge and no `Governed` badge** — both concepts were retired as assignment types and never reach this table:

- **Ownership** is a `Direct` assignment on a separate `GroupOwnership` resource (migration 046), so an owner shows up as a normal Direct cell on the ownership row — see [Owner rows are their own resource](#owner-rows-are-their-own-resource) below.
- **Governed** access is a `Direct` assignment carrying the `governed=true` flag (migration 049); the flag drives the AP color overlay, not a badge.

The rationale: the *resource type* already says what *kind* of membership it is (`BusinessRole`, `DelegatedPermission`, `AppRole`, `GroupOwnership`). The badge is reserved for *how* the user holds the resource — Direct / Indirect / Eligible — not *why* the assignment exists.

**Cell coloring is independent.** `managedByAccessPackage` is computed from the `governed=true` flag (via the SOLL join in migration 049) so the AP color overlay correctly marks governed cells regardless of the badge.

The three-letter alphabet was chosen for an explicit reason: **`E` (Eligible) is not "current access"**. A user with an Eligible row could activate via PIM but right now has nothing. Folding `Eligible` into `Direct` would misrepresent reality and was rejected in design discussion.

## Expand semantics

A group can appear as a *principal* of other resources — that's how nested group membership and group-assigned app roles work. The matrix grid hides these rows (the column `INNER JOIN`s `Principals`, and groups live in `Resources`). The **expand** affordance surfaces them:

- `GET /api/groups-with-nested` — returns every group ID that is itself a principal on at least one row in `ResourceAssignments` (any `assignmentType`).
- `GET /api/group/:id/nested-groups` — returns every resource that group is a principal on, plus the user-level memberships of those resources.

Clicking the chevron on a group row fans out:
1. **Nested parent groups** — groups this one is a member of. Members of the row's group inherit them.
2. **App roles** — app roles assigned to this group. Members inherit them via the per-user `AppRoleViaGroup` rows (badge `I`).

The endpoints don't filter by `assignmentType` — any future "group-as-principal" type (directory roles assigned to groups, governed BRs assigned to groups, …) automatically surfaces.

## Why groups don't appear as columns

`Principals` is users + service principals + managed identities. Groups live in `Resources` (as `resourceType='Group'`). When a group is itself a principal of an assignment (e.g. nested membership), the row's `principalId` is a group's UUID — which has no matching `Principals.id`, so the matrix endpoint's `INNER JOIN Principals` drops the row. The expand endpoints query `ResourceAssignments` directly to surface those rows.

This is why we can store *both*:
- `(resourceId=AppRole_X, principalId=Group_Y, assignmentType='AppRole')` — Group Y has the role
- `(resourceId=AppRole_X, principalId=User_Z, assignmentType='AppRoleViaGroup', extendedAttributes.viaGroupId='Group_Y')` — User Z has the role because they're in Group Y

…without polluting the user-facing matrix grid. The first row is invisible there; the second row paints User Z's cell with an `I` badge.

## Owner rows are their own resource

A user who is both a member and an owner of a group holds two separate resources: the group itself (a `Direct` membership) and a synthetic `GroupOwnership` resource named `Owner @ <group>` (also a `Direct` membership). Migration 046 rewrote the old `assignmentType='Owner'` rows into Direct assignments on this ownership resource, linked back to the group by a `HasOwnership` relationship — mirroring how an `AppRole` hangs off its `Application`. The matrix therefore shows ownership as its own row, with a normal **D** badge, rather than a separate `O`-type cell on the group row. No client-side row-splitting is involved.

## Access-package columns — role scopes badge like memberships

The right-hand access-package block is driven by `ResourceRelationships` (`relationshipType='Contains'`), whose `roleName` holds the role scope as the source system names it — Graph stamps `accessPackageResourceRole.displayName` verbatim, so `Member`, `Owner` and `Eligible Member` all occur. That name maps to a badge letter the same way everywhere:

| `roleName` contains | Badge |
|---------------------|-------|
| `eligible` | **E** |
| anything else (`Member`, `Owner`, empty) | **D** |

There is **no `O` badge here either** — for the same reason as the membership badges: ownership is its own resource, and a package granting a group's Owner role still grants access the subject holds today. The mapping lives in `getApRoleBadge` (`app/ui/src/utils/accessPackageStyles.js`) and is shared by the grid (`MatrixGroupRow.jsx`) and the Excel export (`exportToExcel.js`) so the file can't disagree with the screen; migration 049 applies the same `%eligible%` rule server-side when it derives governed-intent rows.

## Performance notes

- The matview is refreshed `CONCURRENTLY` after the first run (which is non-concurrent because the matview starts empty).
- The unique covering index `(resourceId, principalId, membershipType)` is required for `REFRESH CONCURRENTLY` and also makes the matrix endpoint's per-principal lookups index-only.
- The Contexts sidecar is one extra indexed query per flat-grid request (`ix_ContextMembers_member`), bounded by the grid's distinct resources — computed once per resource, never per cell.
- The recursive CTE that previously expanded nested groups *inside* the matview was removed in 013 — it was the dominant cost on the load-test dataset and produced the same matrix for tenants without group-in-group nesting. Group-level expansion happens lazily at click time via the `/nested-groups` endpoint instead.

## Identity rows

The matrix can run with **identities** as subjects instead of individual principals. The choice is made in step 1 of the [matrix filter wizard](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/components/matrix/MatrixFilterWizard.jsx) (`rowType: 'principal' | 'identity'`):

- **User accounts** (`principal`) — each subject is one Principal (a single account). Best for clean-up sweeps and per-account audits.
- **Identities** (`identity`) — each subject is one correlated person, unioning across their linked accounts. A cell is filled if *any* underlying account has the assignment. Best for role-mining and birthright analysis.

When the orientation puts subjects on the column axis, an **identity column can be expanded into per-account sub-columns**. Clicking the chevron on an identity header (`MatrixColumnHeaders.jsx`) loads `GET /api/identities/:id/account-matrix`, which returns the identity's linked accounts plus each account's `(resourceId, membershipType)` rows drawn from the *same* `vw_ResourceUserPermissionAssignments` view the principal matrix uses — so the account sub-columns render cells identical to a principal-scoped matrix. The account sub-columns are visually tinted (blue) and labelled `displayName · accountType` to distinguish them from the rolled-up identity column.

### Context picker filtered by row type

The wizard's "+ Context" picker is filtered by the subject row type so an analyst can only pick contexts that actually apply to the rows:

| Row type | Subject-side contexts offered | Resource-side contexts offered |
|---|---|---|
| `principal` | `Principal` | `Resource`, `System` |
| `identity` | `Identity` | `Resource`, `System` |

(Resource/System contexts always apply to the resource axis; Identity and Principal contexts to the subject axis.)

### Identity extension-attribute filtering

The subject-condition step also offers an "+ Attribute" filter. When `rowType=identity`, the column list comes from `GET /api/matrix/columns?entity=Identity` (loaded lazily the first time the analyst switches to identities), so identities can be narrowed by their own attributes (department, jobTitle, companyName, city, country, employeeId, …) and by identity tag. Switching row type clears the subject conditions, since the available columns differ between principals and identities.

### Which fields the "+ Attribute" picker offers

The picker (`app/ui/src/components/matrix/AttributePicker.jsx`) lists every discovered column that carries a value list, minus a small hidden set: `id`, `principalId`, `resourceId`, `identityId` — opaque identifiers nobody filters by hand.

`displayName` is **not** hidden: filtering down to the specific subjects or resources you mean by name is a core role-mining ask ([#927](https://github.com/Fortigi/IdentityAtlas/issues/927)), and every layer beneath the picker already supports it (the columns endpoint serves the column with its values, `buildAttributeClause` in `app/api/src/matrix/filterSql.js` accepts it, and a `displayName` condition round-trips through a saved matrix unchanged). On a tenant with more names than fit one page, the value search below applies to it like any other column.

The wizard's **Sort / roll-up** options are a different list (`attributeOptions()` in `MatrixFilterWizard.jsx`) and do still exclude `displayName` — grouping by a near-unique value produces one group per row and nothing to fold.

### Attribute values — paged discovery, not a silent cap

A column can have far more distinct values than any dropdown can ship (`description` on `Resources` collects descriptions from every resource type, so a real tenant runs to tens of thousands). `GET /api/matrix/columns` therefore serves **one page** of values per column — the alphabetically first 500 by default — and sets `truncated: true` on any column that has more. Two rules follow:

- **The page is ordered, never arbitrary.** The per-column subquery orders inside the `LIMIT` (`db/columnCache.js`). Without that, Postgres is free to return any 500 distinct values, and the list an analyst browses alphabetically has unpredictable holes — a value they can see on the Excel export is simply absent, while later values are present ([#928](https://github.com/Fortigi/IdentityAtlas/issues/928)).
- **Everything outside the page stays reachable.** `GET /api/matrix/column-values?entity=&column=&q=` runs a bounded substring search (case-insensitive, 50 results) over *all* distinct values of one column. The "+ Attribute" picker filters the preloaded page client-side as you type, and for a `truncated` column additionally merges in server-side matches. The Field dropdown shows `description (500+)` for a truncated column so the count reads as a floor, not a total.

`column` is validated against the discovered columns / `ext.*` keys before it is interpolated into the SQL; the search term is always bound.

#### Verifying it on a deployment that has fewer than 500 distinct values

The capped path only appears once a column holds more distinct values than the page, so a test environment with a couple of hundred resources shows nothing. There is no need to create resources by hand — resources only enter Identity Atlas through crawlers, and there is no bulk-create UI. Two supported ways to get there instead:

| | What you change | Who can do it | What you end up looking at |
|---|---|---|---|
| **A. Load high-cardinality demo data** | A checkbox on the Demo Dataset crawler | Anyone with Admin access, from the browser | A real column with **more than 500** distinct descriptions — the reporter's scenario at full size |
| **B. Lower the page size** | `MATRIX_VALUE_PAGE_SIZE` on the web container | Whoever can recreate the container | The same behaviour at miniature scale, on whatever data is already loaded |

##### A. Load high-cardinality demo data (no configuration change)

Admin → Crawlers → **Demo Dataset** → tick **"Also load high-cardinality test data"** → Load Demo Data. The generator's opt-in volume slice (`test/demo-dataset/parts/DemoVolume.ps1`, switched on by `Generate-DemoDataset.ps1 -IncludeVolume`) appends ~520 extra groups `SG-Vol-0001…`, each with its own description, plus one sentinel group **`SG-Zzz-Cap-Probe`** whose description starts with `Zzz` so it sorts alphabetically *last* and is therefore guaranteed to fall outside the preloaded page.

Then walk the reporter's path — Matrix → Adjust matrix → Next → Next → **+ Attribute**:

1. The Field entry reads **`description (500+)`** — the `+` marks the count as a floor, so the list is a page rather than everything.
2. The listed values are the alphabetically first 500, in order — no holes anywhere in the middle.
3. Type `Zzz` into **Search values**. `Zzz - beyond the preloaded 500 (#928 probe)` comes back from the server even though it is not in the page. Tick it, add the filter, and the matrix shows `SG-Zzz-Cap-Probe`.

The slice is off by default: the public demo, the Capture-the-Flag answers, `Verify-DemoDataset.ps1`'s exact row counts and the E2E suite all assume the standard 39-resource company. `test/unit/DemoDataset.Tests.ps1` pins both halves: the slice crosses 500 with the sentinel behind the page, and the default dataset is unchanged without the switch.

To undo it, re-run the Demo Dataset crawler with the box unticked *and* clean the database first (Admin → Danger Zone → Clean Database). A plain re-run soft-deletes the extra groups, which is enough to clear them from the resource lists and the matrix — but value discovery reads the whole table, so their descriptions would keep appearing in the dropdowns until the rows are actually gone.

##### B. Lower the page size

The page size is the `MATRIX_VALUE_PAGE_SIZE` environment variable on the web container (default `500`, maximum `5000`; anything unparseable, zero or negative falls back to the default). It is the cache key alongside the 5-minute TTL, so a changed value takes effect on the next request rather than after the TTL expires.

Lowering it reproduces the same behaviour on any dataset without touching the data at all — useful when the deployment is connected to a real tenant and loading demo data is not an option. Both compose files pass the variable through, so an already-built stack only needs its web container recreated — no rebuild, no data changes:

```bash
# In the stack's directory, with the same -f flags it was started with
MATRIX_VALUE_PAGE_SIZE=5 docker compose up -d web
```

Then, in the matrix wizard's "+ Attribute" picker, any field with more than five distinct values behaves exactly as `description` does in a large tenant:

1. The Field dropdown reads `description (5+)` — the `+` marks the count as a floor.
2. The picker says *"Showing the first 5 values of more than can be listed"*, and those five are the alphabetically first ones — no holes.
3. Typing part of a sixth, out-of-page value into **Search values** finds it (that request is `GET /api/matrix/column-values`) and it can be ticked and added as a filter.

Restore the variable (or drop it) and recreate the container to return to the 500-value default. `app/api/contract-tests/columnValuesSmallTenant.contract.test.js` runs this exact recipe against a real database with twelve descriptions and a page size of five.

Independently of the page size, two things are checkable on any deployment, without changing its configuration: `GET /api/matrix/columns?entity=Resource` returns `description` values in alphabetical order (the ordering whose absence caused the holes), and `GET /api/matrix/column-values?entity=Resource&column=description&q=<text>` — the request the picker's search box makes — returns matches for text stored anywhere in the tenant.

### Filter shape — normalised at the wizard boundary

A matrix filter reaches the wizard from four places and only one of them is
guaranteed to carry every field:

| Source | Completeness |
|---|---|
| The wizard's own **Apply** | complete |
| A saved matrix (`SavedMatrixFilters`) | may predate a field, or be seeded with only a few |
| The `#matrix?filter=…` URL | shared from an older build, or hand-edited |
| The org-wide default matrix (auto-applied without opening the wizard) | as seeded — `Ingest-DemoDataset.ps1` seeds `rowType`/`orientation`/`subject`/`resource` and nothing else |

The wizard's steps read those fields directly (`sortAttributes.length`,
`subject.include`, …), so every filter entering wizard state — the `initialFilter`
prop *and* a matrix loaded from the saved-matrix dropdown — goes through
`normalizeMatrixFilter()` in [`app/ui/src/utils/matrixFilter.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/utils/matrixFilter.js)
first. It fills missing fields from `EMPTY_FILTER`, drops wrongly-typed values,
and deep-copies the source so wizard edits can't mutate the applied filter. The
grid-side consumers (`MatrixView`, `sortUsers`, the Excel export) already fall
back to `DEFAULT_SORT` on their own, so a partial filter renders — it was only
the wizard that assumed the full shape.

### Matrix identity — comparing two filters

"Is this the matrix I saved?" is asked by the summary bar
(`MatrixFilterSummary`), which labels the applied matrix with its saved name or
"Not saved". Filters are compared with `matrixFilterFingerprint()` — canonical
(key-order-independent) JSON of the **normalised** filter, minus the view-state
keys `rollupExpanded` / `rollupCollapsed` / `rollupPath` / `foldAttributes`.
Never compare filters with raw `JSON.stringify`:

* the applied filter is always the full shape while a stored one may carry only
  a few fields (and a `managed` key the filter itself doesn't have), so a raw
  compare made a matrix stop matching the saved row it was loaded from the
  moment the analyst opened the wizard and applied without changing anything;
* the view-state keys say where the analyst is *in* the matrix (which groups are
  folded, how far they've drilled), not which matrix it is, and the wizard
  rewrites them on every apply.

### Adjusting without changing anything

Opening "Adjust matrix", walking the steps and applying without touching a
control has to be a no-op — every step renders, and the matrix that comes back
is the same one, still carrying its saved name. That contract is what the two
regressions above broke, and it's covered end-to-end in
[`app/ui/e2e/matrix.spec.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/e2e/matrix.spec.js)
("Matrix — adjust without changing anything") for each way a filter reaches the
wizard: the org-wide default, a shared link, an identity matrix, and a second
adjust of the wizard's own output.

## Sorting, folding & server-side aggregation

The column axis can get very wide (one column per subject). Three mechanisms keep
it usable at scale; which one is in play depends on the wizard's **Sort** step and
the matrix size.

### Per-subject sort + fold (client-side, small matrices)

In the default per-subject grid (`MatrixView.jsx`) the columns can be **sorted by
1–6 attributes** (`sortAttributes`, e.g. `department` then `jobTitle`). Each sort
attribute becomes a grouping header row above the subject names, built from the
value-runs `computeAttributeSpans` (`matrix/sortUsers.js`) derives. A sort group
can then be **folded** into a single aggregate count column in place
(`collapsedGroups`); the aggregate column shows the number of child groups, the
user count, and a per-row count of Direct assignments. `▾`/`↳` explode an
aggregate back into its members (direct + indirect, or direct only). This is all
**client-side** on the flat per-subject payload — it changes what is *rendered*,
not what is *fetched*.

**Two header styles, chosen adaptively (`matrix/headerMode.js`).** The grouping
rows render either as the original **rotated** rows (one 120 px row per level,
values written vertically inside merged cells) or as a **cross table**
(`MatrixCrossTableRows.jsx`): one 20 px row per distinct value of a level, its
label written horizontally in the corner area, with a `✕` in every subject
column that carries the value. A folded group shows `▤` there instead, an
exploded one `▾`, and below its fold level an aggregate keeps its child-group
count in a cell spanning that level's value rows. Each contiguous run of columns
is one real `<button>` carrying the same fold/unfold click and accessible name
the merged cell had, so every interaction survives the change of style.

The cross table is used only when it is **no taller** than the rotated stack it
replaces — `Σ distinct values × 20 px ≤ levels × 120 px`, i.e. an average of at
most six values per level. The decision is taken over the **unfolded** subject
set across **all** configured sort levels, and the whole stack switches together
(never a per-row mix). Two consequences are deliberate: the style is a property
of the matrix *definition*, so folding or exploding a column never re-styles the
header under the user's click (#1049); and because folding can only ever draw a
subset of those values, a cross table that fits in that worst case stays shorter
than today's header in every reachable state.

### Size gate

Folding does not shrink the fetch, so a flat per-subject matrix has a hard size
limit. `MatrixFilterWizard.jsx` (`matrixIsBlocked`) blocks an oversized flat
matrix (`> BLOCK_ASSIGNMENTS`); the server adds a backstop that returns `413`
rather than overflowing `JSON.stringify` (V8's ~512 MB max string length) past
`MAX_FLAT_ROWS` rows. Only **server-aggregated** views (below) are exempt — they
return counts, never per-subject rows, so they load at any size.

### Layered server-aggregated views (large matrices)

Two views aggregate on the server and render through `RollupMatrixView.jsx` as a
**stacked, expand-in-place** grid (columns = groups, cells = Direct counts). They
share the same payload shape (`layered: true`, `nodes[]` with `pathIds`/`pathNames`
/`depth`, `counts[]`, `maxDepth`) so they use one renderer:

| View | Trigger | Tree | Default depth | Server cut |
|---|---|---|---|---|
| **Manager Hierarchy** | `sortHierarchy: {contextId}` | a `ManagerHierarchy` Context tree | top level (1 row); **expand to drill deeper** | `buildContextCutSql` — root's children, with any *expanded* node replaced by its children (`rollupExpanded`) |
| **Attribute fold** | `foldAttributes` (set by the wizard for an oversized foldable matrix) | the chosen `sortAttributes` | **full depth** (all attribute rows shown); **fold to collapse** | `attributeCut.js` — each subject's visible tuple, truncated at the first *folded* prefix (`rollupCollapsed`) |

Note the inverse defaults: the hierarchy starts shallow and **expands** (depth
unknown); attribute fold starts at full depth and **collapses** (depth = the
attributes you picked). Counts are computed only for the *visible frontier*
(`buildContextRollupSql` / `buildAttrCutCellsSql`), so the payload stays small
regardless of subtree size. The `sortHierarchy → context roll-up` translation
lives in the `/api/matrix/data` handler in `matrix.js`.

**Empty-branch hiding.** A column only appears if at least one in-scope resource
has a Direct count for that node's subtree, so scoping the matrix to a few
resources drops the org branches / attribute groups those resources aren't used
in.

**Scoped header counts.** A Manager-Hierarchy column header shows
`direct / total` members — and both are **assignment-scoped**
(`buildContextScopedMemberCountsSql`): only people who actually hold a shown
resource, so the header agrees with the cells and with the member drill-down.

**Sticky headers.** With many header rows, only the *deepest* (layered views) or
the *names* row (per-subject grid) stays pinned on vertical scroll; the upper
grouping rows scroll away. The per-subject grid does this by making the whole
`<thead>` sticky with a negative `top` equal to the grouping rows' combined
height — the summed cross-table row heights, or `levels × 120 px` in rotated
mode.

### Excel export

Both renderers export an `.xlsx` that mirrors the on-screen header stack: one
header row per shown level (every sort attribute / every org level) — including
when the screen shows the cross table, which is a display choice only. On-screen
merged spans are written as the **same value repeated** across each column — cells
are not merged in the file (`exportRollupToExcel.js`, `exportToExcel.js`). All
externally-influenced cells route through `safeCell` (formula-injection guard).
The per-subject export mirrors the grid's column order: **Contexts** (every context
name, comma-joined and untruncated) sits in the info block next to Resource Name,
and the right-side block is `#`, Type, Description.

## Related references

- Crawler emits — [`tools/crawlers/entra-id/Start-EntraIDCrawler.ps1`](https://github.com/Fortigi/IdentityAtlas/blob/main/tools/crawlers/entra-id/Start-EntraIDCrawler.ps1) (phases `Assignments`, `PIM`, `Governance`, `OAuth2Grants`, `AppRoles`)
- Frontend renderer — [`app/ui/src/components/MatrixView.jsx`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/components/MatrixView.jsx) and `app/ui/src/components/matrix/*`
- Badge color map — [`app/ui/src/utils/colors.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/utils/colors.js) (`TYPE_COLORS`)
- Permissions endpoint — [`app/api/src/routes/permissions.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/routes/permissions.js) (`GET /api/permissions`, `GET /api/groups-with-nested`, `GET /api/group/:id/nested-groups`)
