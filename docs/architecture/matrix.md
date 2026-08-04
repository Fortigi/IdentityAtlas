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

## Performance notes

- The matview is refreshed `CONCURRENTLY` after the first run (which is non-concurrent because the matview starts empty).
- The unique covering index `(resourceId, principalId, membershipType)` is required for `REFRESH CONCURRENTLY` and also makes the matrix endpoint's per-principal lookups index-only.
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

## Sorting, folding & server-side aggregation

The column axis can get very wide (one column per subject). Three mechanisms keep
it usable at scale; which one is in play depends on the wizard's **Sort** step and
the matrix size.

### Per-subject sort + fold (client-side, small matrices)

In the default per-subject grid (`MatrixView.jsx`) the columns can be **sorted by
1–6 attributes** (`sortAttributes`, e.g. `department` then `jobTitle`). Each sort
attribute becomes a merged header row above the subject names
(`computeAttributeSpans` in `matrix/sortUsers.js`). A sort group can then be
**folded** into a single aggregate count column in place (`collapsedGroups`); the
aggregate column shows the number of child groups, the user count, and a per-row
count of Direct assignments. `▾`/`↳` explode an aggregate back into its members
(direct + indirect, or direct only). This is all **client-side** on the flat
per-subject payload — it changes what is *rendered*, not what is *fetched*.

### Business-role fold (rows)

The column fold above collapses *columns*; the **business-role fold** collapses
*rows*. A business-role row (`resourceType='BusinessRole'`) carries a chevron
that hides the rows of the resources that role grants — its `Contains` children
— leaving the role row with an "*N* resources folded" chip. A **Fold roles /
Unfold roles** toolbar pair does it for every role at once, which reduces the
grid to exactly "business roles + resources no role grants" — the role-mining
view without the duplication between a role and its contents.

The parent → child mapping is not derived client-side: it is the same
`ResourceRelationships` / `relationshipType='Contains'` data that
`GET /api/access-package-groups` already delivers for the SOLL columns
(`accessPackageGroups`). Folding is pure view state, the same tier as the column
fold and the nested-group expand — it changes what is *rendered*, never what is
fetched, counted or exported. It lives in
[`hooks/useBusinessRoleFold.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/hooks/useBusinessRoleFold.js)
and is applied last in the row pipeline, so it composes with the
All / Governed / Non-governed / Gaps toggles and with injected nested sub-rows.

Rules worth knowing:

- **Default expanded.** Fold choices persist per matrix filter in versioned
  localStorage (`fgraph-rolefold-<filter>`), the mechanism the custom row order
  uses — so two different matrix slices keep independent fold state.
- **A resource granted by several roles** stays visible until *every* role
  granting it that is present in the grid is folded.
- **A role with no row of its own** (nobody visible holds it) gets no fold
  affordance and hides nothing — a resource never disappears without a visible
  parent to unfold it from.
- **The folded role's own cells are untouched.** Folding hides rows; it never
  rolls a child's assignments up into the parent row.
- **Ownership rows are not folded** — they hang off a group by `HasOwnership`,
  not off a role by `Contains`.
- The AP staircase promotes a **business role's own row to the top of its
  bucket**, directly above the resources it grants, so a parent is always
  adjacent to the children it folds away.

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
grouping rows scroll away.

### Excel export

Both renderers export an `.xlsx` that mirrors the on-screen header stack: one
header row per shown level (every sort attribute / every org level). On-screen
merged spans are written as the **same value repeated** across each column — cells
are not merged in the file (`exportRollupToExcel.js`, `exportToExcel.js`). All
externally-influenced cells route through `safeCell` (formula-injection guard).

## Related references

- Crawler emits — [`tools/crawlers/entra-id/Start-EntraIDCrawler.ps1`](https://github.com/Fortigi/IdentityAtlas/blob/main/tools/crawlers/entra-id/Start-EntraIDCrawler.ps1) (phases `Assignments`, `PIM`, `Governance`, `OAuth2Grants`, `AppRoles`)
- Frontend renderer — [`app/ui/src/components/MatrixView.jsx`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/components/MatrixView.jsx) and `app/ui/src/components/matrix/*`
- Badge color map — [`app/ui/src/utils/colors.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/utils/colors.js) (`TYPE_COLORS`)
- Permissions endpoint — [`app/api/src/routes/permissions.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/routes/permissions.js) (`GET /api/permissions`, `GET /api/groups-with-nested`, `GET /api/group/:id/nested-groups`)
