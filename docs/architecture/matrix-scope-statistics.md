---
type: task
prereq: architecture/matrix.md
outcome: You can read the numbers a scope reports without mistaking one for another.
---

# Matrix — Scope Statistics

!!! info "Before this page"
    Assumes you have read **[Reading the Matrix](./matrix.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

> Companion to [`matrix.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/routes/matrix.js), [`scopeHistory.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/matrix/scopeHistory.js), [`MatrixScopePanel.jsx`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/components/matrix/MatrixScopePanel.jsx), [`TimeSeriesChart.jsx`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/components/TimeSeriesChart.jsx). See also [Audit History](audit-history.md).

## What it does

Whenever you build a matrix (a subject/resource filter), the **Scope Statistics** panel at the top summarises that selection:

- **Principals / Identities** in scope
- **Resources** in scope
- **Assignments** in scope, split into **governed vs non-governed** — the share managed by a Business Role / Access Package (the matrix's "managed / SOLL" semantics).

Expand **Trends & breakdown** for:

- A **historic timeline** of principals, resources, assignments, and — the headline — **% governed over time**.
- A **department-by-department** (or any principal attribute) breakdown of governed vs non-governed, where each row drills into that department's own governed-% trend.

It was built for reporting role-mining progress: "what share of access is governed, by department, and is it improving?"

## What counts as "governed"

A `(principal, resource)` membership is **governed** when it is **covered by a business role the user holds** — i.e. it appears in [`vw_UserPermissionAssignmentViaBusinessRole`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/013_matrix_matviews_and_indexes.sql): there is a `BusinessRole` that **Contains** the group (`ResourceRelationships.relationshipType = 'Contains'`) **and** the user holds that role (a `Governed` assignment to it). This is exactly what the matrix paints as **SOLL**.

This is deliberately *not* the same as `vw_ResourceUserPermissionAssignments.managedByAccessPackage`, which is only true for the rare assignment recorded directly as `Governed` on the group itself. In real data, users hold the **business role** while their group membership is recorded as `Direct`, so that flag reads as ~0% governed — which is why the whole feature (panel counts, the `Governed` / `Non-governed` toggle, and the trends) keys off business-role *coverage* instead, so every surface agrees.

**Owner memberships** are always **non-governed**: access packages provision Direct / Eligible / Member roles, never ownership.

## Matrix view behaviour

- The view toggle reads **All / Governed / Non-governed / Gaps** (renamed from SOLL / IST). *Governed* shows memberships covered by a held business role; *Non-governed* shows the rest (the role-mining backlog); *Gaps* shows memberships a held business role *should* grant but the user lacks.
- The **Non-governed** view hides the access-package (SOLL) columns — they only ever show governed memberships — and orders rows by member count (Direct desc → Eligible → Owner → total) rather than the AP staircase, since there are no AP columns to stair-step against.

## Where the history comes from

There is **no dedicated snapshot table** for scope statistics. The timeline is reconstructed on demand from the existing change-audit log (`_history`, see [Audit History](audit-history.md)).

`_history` records every INSERT / UPDATE / DELETE on the tracked tables with a full JSONB snapshot (`rowData` / `prevData`) and a `changedAt` timestamp. The state of any row as-of a past instant **D** is:

- the **`prevData` of the earliest change after D** — that change turned the row's state-at-D into its next state, so its `prevData` *is* the state at D (a NULL `prevData` means that change was an INSERT, i.e. the row didn't exist at D); or
- if the row has **no change after D**, its **current** row — it hasn't changed since D.

The union of those two branches is the exact set of rows alive at D, with the attributes they had at D. Applied to Principals, Resources, and ResourceAssignments, this yields point-in-time counts and the governed split for any sample date — using only `_history` plus the live tables.

```
 for each sample date D:
   alive(D) = { prevData of first change after D }  ∪  { current rows with no change after D }
   assignments(D)  = distinct (principal, resource) pairs in alive(D), within scope-at-D
   coverage(D)     = (user, group) where the user held a business role (Governed
                     assignment) that 'Contains' the group at D   ← reconstructed from
                     ResourceAssignments + ResourceRelationships history
   governed(D)     = assignment pairs that are in coverage(D)
```

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/matrix/scope-stats` | Live counts + governed split for the current filter. |
| `POST /api/matrix/scope-timeseries` | Reconstructed timeline (`points[]`, `historyStart`, `retentionDays`, `scopeMode`). Query: `days`, `points`. |
| `POST /api/matrix/scope-breakdown` | Per-attribute breakdown (default `department`) of the current filter. Query: `attribute`. |

All three accept the standard matrix `{ filter }` body.

## Limits & honesty

- **How far back:** the timeline can only reach as far back as the audit log is kept — `HISTORY_RETENTION_DAYS` (default **180**, configurable; `0` disables pruning). The endpoint returns `historyStart` (the earliest reliable instant) and `retentionDays`, and the UI states the boundary. Points before `historyStart` are returned flagged `beforeHistory` and not plotted. To report further back, raise `HISTORY_RETENTION_DAYS` **before** the period you want to see.
- **Department scope is reconstructed from attributes.** Departments/business units modelled as the principal `department` (or other) attribute reconstruct fully and accurately, because Principals are audited.
- **Context-membership scope is approximated.** `ContextMembers` is intentionally **not** audited, so a selection that scopes by *context membership* falls back to **today's** membership for past dates. Those responses carry `scopeMode: "context-current"` and the UI shows a caveat. Attribute-based selections report `scopeMode: "attribute"` (fully reconstructed).

## Testing

- Unit: [`scopeHistory.test.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/matrix/scopeHistory.test.js) — date sampling and as-of SQL construction (no DB).
- Integration: [`Test-MatrixScopeStats.ps1`](https://github.com/Fortigi/IdentityAtlas/blob/main/test/nightly/Test-MatrixScopeStats.ps1) — asserts live counts, breakdown consistency (per-department principals sum to the total; governed ≤ assignments), and that the timeline's most-recent point equals the live stats. With [`Simulate-History.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/test/demo-dataset/Simulate-History.sql) back-dating the audit log, it also asserts the timeline reconstructs real depth (governed % varies and grows across the window). Both run in CI.
