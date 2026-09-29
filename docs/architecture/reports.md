# Reports

The Reports tab answers standing questions about the data — "which accounts belong to nobody?" — as
a list you can act on. It is deliberately a **framework with reports plugged into it**, not a page
with reports coded into it.

## Adding a report = one template file + one registry line

That is the whole contract, and it is enforced rather than merely intended.

1. Write `app/api/src/reports/templates/<name>.js`, default-exporting a template.
2. Add one `import` line for it in `app/api/src/reports/templates/index.js`.

There is no step 3. No route changes, no registry changes, no UI changes — as long as the report uses
a presentation form the UI already knows (today: `list`). If your second report needs an engine
change, the seam is in the wrong place; fix the seam, not the report.

This mirrors two registries the codebase already runs on: the
[crawler manifests](crawler-architecture.md) and the context-algorithm plugins
(`app/api/src/contexts/plugins/registry.js`). The report-template shape is intentionally the
context-plugin shape, with `form` + `columns` where a plugin has `targetType`.

## The template contract

```js
// app/api/src/reports/templates/orphaned-accounts.js
export default {
  name: 'orphaned-accounts',            // stable slug; the URL path parameter
  displayName: 'Orphaned Accounts',
  description: 'Accounts that are not linked to any identity…',
  form: 'list',                          // which renderer draws it
  parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [
    { key: 'displayName', label: 'Account' },
    { key: 'email',       label: 'Email' },
  ],
  async run(params, ctx) {
    return { rows: [ /* { displayName, email, _entity: { kind: 'user', id } } */ ] };
  },
};
```

- **`columns`** drive the table headings *and* which row keys are read. The UI has no column list of
  its own.
- **`run(params, ctx)`** returns `{ rows }`. Each row is a plain object keyed by the column keys.
- **`_entity: { kind, id }`** is optional. When present, the row's first cell becomes a link that
  opens the matching entity detail tab (`#user:<id>`), so a finding can be acted on rather than only
  read.
- **`ctx.log?.(…)`** is an optional progress logger; templates must work without it.

The full JSDoc contract lives in `app/api/src/reports/types.js`.

## Refreshable by construction

Report content is computed **at request time**. There are no stored runs or snapshots, so "refresh
against the latest data" is not a cache-invalidation problem — the UI's Refresh button simply
re-fetches, and the result reflects whatever the last crawler or account-linking run left behind.
`generatedAt` in the response is the moment the rows were computed.

## API

| Route | Purpose |
|-------|---------|
| `GET /api/reports` | Metadata for every registered template: `name`, `displayName`, `description`, `form`, `parametersSchema`, `columns`. |
| `GET /api/reports/:name/rows` | Runs one template and returns that metadata plus `rows`, `total`, `generatedAt`. Unknown name → 404. A template that throws → a generic 500, with the detail only in the server log. |

Both are documented in `app/api/src/openapi.yaml`. Query parameters are passed through to the
template as its `params`. Auth is `authMiddleware` only — reports are an analyst surface exposing
nothing the Contexts page doesn't already show, so there is no admin permission gate.

## UI

Reports is an **optional** nav tab (`optional: true` in `utils/navTabs.js`, allowlisted in the API's
`routes/preferences.js`): off by default, switched on per user under Settings → Visible Tabs, exactly
like Systems and Logs. Hiding it only declutters the nav — `#reports` and `#report:<name>` stay
reachable by URL either way.

`components/ReportsPage.jsx` lists the reports from `GET /api/reports` and renders the selected one
through a **form-renderer map** (`components/reports/formRenderers.js`) keyed on the report's `form`
— never on its name. A new report of an existing form costs nothing in the UI; a new *form* is one
entry in that map plus its renderer component. A report declaring a form this UI version doesn't
know renders an explanatory panel rather than breaking the page.

## The reports

| Name | Form | What it lists |
|------|------|---------------|
| `orphaned-accounts` | `list` | Accounts with no `IdentityMembers` row — i.e. belonging to no identity — excluding service principals, managed identities and AI agents, with the detected account type for each. |
| `application-access-review` | `list` | One row per entitlement of a named logical application, sectioned into *requestable, not in a role* / *not requestable, not in a role* / *part of a role*, with the certification frequency and entitlement owner as stored and the holders split Direct vs Indirect. |

Orphaned Accounts shares its definition with the `orphaned-accounts` **context plugin** via
`app/api/src/accountlinking/orphanQuery.js`. That is deliberate: the report and the context answer
the same question, so they must not be able to drift apart. Note that before account linking has run
there are no `IdentityMembers` at all, so every account is legitimately listed — the report's
description says so.

## Downloads, and which formats carry the notices

`app/api/src/reports/export.js` is keyed on the **format** name, never on a report name, so every
registered template is downloadable the moment it exists. Today: `csv`, `xlsx`, `json` — in that
order, which is the order the UI offers them and the first is the default.

Notices used to be stripped from every download, on the rule "a download is the rows". That was
really a statement about CSV rather than about downloads: a CSV *is* a table, so anything above the
header row breaks every parser that reads it. A workbook has room above the table and a reader who
expects context there.

So the decision belongs to the format and is declared there:

```js
xlsx: { contentType: '…spreadsheetml.sheet', carriesNotices: true, serialize: toXlsx },
```

`routes/reports.js` strips `notices` for every format that does not claim them, so **csv and json are
byte-for-byte what they were**. A future format (pdf, html) opts in the same way, and the route still
never asks which report it is serving — only what the chosen format can hold.

Two consequences worth knowing:

- **A serializer may be async.** The route awaits every format, because a workbook is assembled and
  zipped rather than concatenated.
- **The xlsx serializer writes cell values raw** — no leading-apostrophe guard. The CSV guard
  (security finding M-05) exists because a CSV cell has no type and the spreadsheet decides what
  `=cmd|calc` means when it opens the file. An xlsx cell *is* typed: a string is stored as a string,
  never as an `<f>` formula. The apostrophe would be a character of corruption, not a defence, so the
  tests pin the invariant that actually matters — the cell round-trips with its exact original text
  **and** with cell type `String`. (The UI's own xlsx exports do apply the apostrophe; that is a
  separate, older path and was left alone.)

## Counting assignments at scale

A report that counts assignments per resource is the one shape in this framework that can degenerate
into a whole-table scan, and `ResourceAssignments` is the largest table in the product — 46 million
rows on the deployment these numbers come from. Three things were measured on a Postgres 16 copy of
an IdentityIQ-shaped dataset (96,140 entitlements, 4,969,395 assignments, 842 MB heap), counting the
holders of the largest application's 16,387 entitlements — 864,796 assignment rows in scope.

| Query shape | Time | Plan |
|---|---:|---|
| Entitlement ids as a **CTE sub-select** (`WHERE "resourceId" IN (SELECT id FROM ent)`) | **12,478 ms** | Merge join against a **full index scan of all 4.97M rows** — the planner has no row estimate for a CTE, so it falls back to its default and prices a whole-table merge as cheap. |
| Ids as an explicit `uuid[]` parameter, `count(DISTINCT …)` inside the aggregate | 2,315 ms | Index scan on `ix_RA_resourceId` + incremental sort; 642k random heap reads. `count(DISTINCT …)` forces a sorted `GroupAggregate`. |
| Ids as a `uuid[]`, de-duplicated by an **inner `SELECT DISTINCT`** | **809 ms** | Parallel seq scan + hash aggregate. Same numbers, no random access. |

So the two rules for any report doing this:

1. **Resolve the ids first and pass them as an explicit array.** A CTE or a sub-select hides the set
   size from the planner; an array parameter does not. Worth 12× here on its own.
2. **De-duplicate with an inner `DISTINCT`, not `count(DISTINCT …)`.** The de-duplication is needed —
   the governed model stores intent and actual as two assignment rows differing only in `governed`,
   so `count(*)` reports one person as two — but doing it inside the aggregate forces a sort and with
   it the random-access plan. Worth another 2.9×. The same rewrite took the scope-wide unique-user
   count from 1,014 ms (with a 41 MB on-disk sort) to 313 ms.

**A covering index was measured and deliberately not added.**
`("resourceId", "principalId", "assignmentType") INCLUDE ("identityId") WHERE "deletedAt" IS NULL`
turns the count into a heap-free index-only scan: 809 ms → 515 ms, and the unique-user count
313 ms → 243 ms. That is 1.4× on the shape we ship, for 330 MB on an 842 MB heap (≈3 GB at the
production row count), permanent write amplification on the hottest ingest path, and a
`CREATE INDEX` that the migration runner executes **inside a transaction** during container startup —
the failure mode that crash-looped a deployment when migration 055's index build outran the startup
probe. 1.4× does not buy that. If a deployment does hit the wall, the index is the fix, built
`CONCURRENTLY` outside the migration runner rather than inside it.

## What keeps the seam honest

- `app/api/src/reports/reportNames.guard.test.js` — a static scan asserting that **no engine file**
  (the registry, the types, the routes, `ReportsPage.jsx`, the renderers) contains a report name, and
  that each template is registered from exactly one import line. Same shape as
  `ingest/assignmentTypes.guard.test.js`.
- `app/api/src/routes/reports.test.js` — a live seam test: a template registered by the test alone is
  listed and served, with zero engine edits.
- `app/api/contract-tests/reports.contract.test.js` — the orphan anti-join against real PostgreSQL.

## Custom reports

Analysts can also build their own reports; a saved one is served through this same
registry as a `list` report named `custom-<id>`, so the report tab, refresh and
download work for it with no engine change. The engine still never names a report.
The definition language, the local model that fills one in, and the seams are in
[Custom Reports Internals](custom-reports.md).

## Not in scope yet

Export and sharing, deep links to a specific report, stored report runs, a parameters UI, and
scheduling are all deliberately out — see the follow-up slices of the reporting epic.
