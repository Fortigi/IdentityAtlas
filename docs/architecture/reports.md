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

`components/ReportsPage.jsx` lists the reports from `GET /api/reports` and renders the selected one
through a **form-renderer map** (`components/reports/formRenderers.js`) keyed on the report's `form`
— never on its name. A new report of an existing form costs nothing in the UI; a new *form* is one
entry in that map plus its renderer component. A report declaring a form this UI version doesn't
know renders an explanatory panel rather than breaking the page.

## The reports

| Name | Form | What it lists |
|------|------|---------------|
| `orphaned-accounts` | `list` | Accounts with no `IdentityMembers` row — i.e. belonging to no identity — excluding service principals, managed identities and AI agents, with the detected account type for each. |

Orphaned Accounts shares its definition with the `orphaned-accounts` **context plugin** via
`app/api/src/accountlinking/orphanQuery.js`. That is deliberate: the report and the context answer
the same question, so they must not be able to drift apart. Note that before account linking has run
there are no `IdentityMembers` at all, so every account is legitimately listed — the report's
description says so.

## What keeps the seam honest

- `app/api/src/reports/reportNames.guard.test.js` — a static scan asserting that **no engine file**
  (the registry, the types, the routes, `ReportsPage.jsx`, the renderers) contains a report name, and
  that each template is registered from exactly one import line. Same shape as
  `ingest/assignmentTypes.guard.test.js`.
- `app/api/src/routes/reports.test.js` — a live seam test: a template registered by the test alone is
  listed and served, with zero engine edits.
- `app/api/contract-tests/reports.contract.test.js` — the orphan anti-join against real PostgreSQL.

## Not in scope yet

Export and sharing, deep links to a specific report, stored report runs, a parameters UI, and
scheduling are all deliberately out — see the follow-up slices of the reporting epic.
