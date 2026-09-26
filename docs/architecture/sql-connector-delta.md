# SQL Connector: Delta Loading (design)

!!! warning "Design, not yet built"
    This page is the plan for incremental loads through the [SQL connector](../sync/sql.md).
    Several of its steps depend on how the source records changes. Those are written down
    as **assumptions** (A1–A9) with the discovery query that settles each one and what
    changes if it turns out false. Nothing here is implemented until the assumptions it
    rests on are confirmed.

## Why

A full read of an identity-governance database at production size (180,000 identities,
800,000 entitlements, 40 million entitlement grants) takes hours to read, send and index,
and needs tens of gigabytes of scratch space (see
[Scale Rehearsal](https://github.com/Fortigi/IdentityAtlas/blob/main/docs/architecture/scale-rehearsal.md)). A full reload is a migration, not an operation.
Routine refreshes must read what changed.

A refresh has two halves, and they need different mechanisms:

| Half | Mechanism | What it reads |
|---|---|---|
| **Additions and changes** | A per-statement **watermark** on the source's `modified` timestamp | Only rows changed since the last run |
| **Removals** | A periodic **key sweep**: the complete set of keys, no attributes, anti-joined against what Identity Atlas holds | Two ids per row, nothing else |

A timestamp cannot find a removal: a row deleted at the source never bumps its own
timestamp. The existing timestamp reconcile (`POST /ingest/reconcile`) cannot help either
in a delta run, because it removes the rows a run did *not* touch, and a delta run
touches almost nothing.

## Part 1 — the watermark

### Mechanics

- A statement opts in by binding `@Since` and naming a **watermark column** it returns
  (new slot field `watermarkColumn`, e.g. `modified`):

  ```sql
  SELECT ie.identity_id AS principalId, ma.id AS resourceId,
         COALESCE(ie.modified, ie.created) AS modified
  FROM spt_identity_entitlement ie
  JOIN spt_managed_attribute ma ON ma.application = ie.application
                               AND ma.attribute = ie.name AND ma.value = ie.value
  WHERE ie.type = 'Entitlement'
    AND COALESCE(ie.modified, ie.created) >= @Since
  ```

- **Where the watermark is stored:** the existing `DeltaTokens` table (migration 020, one
  row per `(systemId, endpoint)`), with `endpoint = 'sql:' + slot name + ':' + hash(SQL text)`.
  Editing a statement changes its hash and therefore starts it from zero, instead of
  silently skipping rows its new shape would have returned.
- **What is stored:** the largest watermark value the statement returned, minus the
  **overlap** (A3). It is taken from the rows read, so no extra query is needed and it
  works for any statement.
- **When it is stored:** only after the whole run succeeded, *including*
  [verification](../sync/sql.md#verification-source-against-database). A failed or
  unverified run re-reads the same window next time. Upserts are idempotent, so a
  re-read costs time, never correctness.
- **No token** (first run, edited statement, or "Force full sync next run" via
  `nextRunMode`) binds `@Since` to the beginning of time: the statement reads everything.
- A statement **without** `@Since` reads in full every run. That is right for small
  tables (the catalogue, roles, role assignments, see A6/A7), and it makes that slot
  **complete**, which matters for removals below.

### Reconcile follows completeness, not run mode

Today a full run reconciles every scope and a delta run reconciles none. With watermarks
that becomes per slot: **a slot that read its complete set may reconcile its scope in any
run; a slot that read a window never does.** Role assignments (1M rows, read in full in
seconds) are then kept exact on every run without a sweep.

### Assumptions

| # | Assumption | If false | Settled by |
|---|---|---|---|
| **A1** | `created` / `modified` are `numeric(19,0)` epoch **milliseconds** written by the **application**, not datetimes written by the database. | `@Since` binds as `datetime2` and the overlap becomes an interval; the logic is unchanged. | discovery §2 (column types) |
| **A2** | `modified` is `NULL` on a row never updated, and set on **every** update. | If `NULL` means something else, drop the `COALESCE`. If some updates do not bump it, that table cannot use a watermark and reads in full. | discovery §8 (`has_modified`, `modified_after_created`) |
| **A3** | Several application servers write, and their clocks may drift, and a transaction can commit after rows with later timestamps. | The overlap must exceed the worst skew plus the longest write transaction. **Default 15 minutes**, configurable. The cost of too large an overlap is re-reading rows; too small loses rows silently. | not measurable from the database; ask how many application servers write and whether they are time-synchronised |
| **A4** | Aggregation updates grant rows **in place** and only when they change. | If aggregation deletes and re-inserts unchanged rows, every aggregated row looks new: the delta reads most of the table, and during the delete→insert gap a row is briefly absent (see A5 on the sweep). | discovery §8 churn (rows changed in the last 1 / 7 days) against aggregation frequency; compare `created` distribution on `spt_identity_entitlement` |
| **A5** | Removals are **physical** `DELETE`s (grants, identities, entitlements), not flags. | If a flag marks them (e.g. `aggregation_state`), a removal is just a change and the watermark finds it; the sweep becomes unnecessary for that table. | discovery §7 (`assigned, granted_by_role, source` breakdown), plus the values of `aggregation_state` |
| **A6** | `spt_identity_assigned_roles` has **no** timestamp columns. | If it has one, it can use a watermark like any other table. | discovery §2 |
| **A7** | The logical-application catalogue is one small `spt_custom` row. | Nothing: it is read in full every run either way. | discovery §6 |
| **A8** | Editing an entitlement's logical application (inside its XML) bumps that entitlement's `modified`. | If it does not, membership changes only arrive with a full read of the membership statement, which at 800,000 short rows is acceptable every run. | discovery §8, plus one test edit in a non-production instance |
| **A9** | Removing a grant bumps the owning identity's `modified` (the identity is refreshed after aggregation). | The sweep cannot be narrowed to changed identities (Part 2, option B) and stays a full key sweep. | a before/after comparison on one identity in a non-production instance |

## Part 2 — the key sweep

### Shape

For each large scope with physical deletes (entitlement grants, Direct and Indirect):

1. Read the **complete key set** from the source: the statement with `@Since` bound to
   zero, wrapped as `SELECT DISTINCT resourceId, principalId FROM (…)`. There are no
   attribute columns, so each row is two ids.
2. Stream the keys into a **stage** on the Identity Atlas side.
3. **Finalize** the stage in "remove what is absent" mode: soft-delete every row of the
   system + scope that is not in the stage, an anti-join inside PostgreSQL.

Steps 2 and 3 use the **shared staging primitive** the bulk-load work is building
(open a stage for table + system + scope, stream batches into an unindexed per-sync
staging table, finalize). The sweep is one extra finalize mode, "delete target rows in
scope that are not in the stage", on that same mechanism. It is not a second staging
path and not a narrow endpoint of its own. A keys-only stage needs nothing special,
because the stage's columns follow whatever is sent. The API shape is the bulk-load
work's to define; this design is written against the concept.

**Not** an option: "touch" every present row so the timestamp reconcile can find the
rest. That rewrites 40 million rows per sweep, floods the write-ahead log, and the audit
history trigger turns each rewrite into about a kilobyte of audit
([Scale Rehearsal](https://github.com/Fortigi/IdentityAtlas/blob/main/docs/architecture/scale-rehearsal.md)).

### Cost

At full size the sweep moves 40 million pairs of 32-character ids, about 2.6 GB of ids
before encoding. That is a fraction of a full read, which also carries every attribute
and pays for every index update, but it is not free. Two ways to make it smaller, in
order of preference:

- **Option A: schedule.** Run the sweep nightly or weekly, and deltas hourly. A removal
  then shows within one sweep interval. This works regardless of A9.
- **Option B: narrow to changed identities** (only if A9 holds). Sweep only the grants of
  identities whose `modified` moved since the last sweep, and finalize with the stage's
  principal set as an extra bound ("delete rows in scope *for these principals* that are
  absent"). This needs that bound from the staging primitive. Raise it with the bulk-load
  work before relying on it.

### Timing and flapping

If aggregation deletes and re-inserts rows (A4 false), a sweep that runs *during*
aggregation sees rows missing that are about to come back. `ResourceAssignments` is a
soft-delete table and a re-ingested row clears its own tombstone
([Soft-Delete & Tombstones](soft-delete.md)), so a flapped row heals on the next delta.
It still leaves audit noise and a window in which access looks revoked. So: **schedule
sweeps outside aggregation windows**, and have the crawler refuse to finalize a sweep
that would remove more than a configurable share of a scope (default 5%) without an
explicit override. The refusal is logged with the count. A sweep that suddenly wants to
remove a third of all grants is far more likely to have read a half-aggregated source
than to reflect reality.

### Verification

A sweep reads the complete key set, so a sweep run is also when the scope's **total** can
be verified: after finalize, the database count of the scope must equal the source's
distinct key count. That is the same check a full run makes today. A delta run verifies
what it touched (rows touched since the run started equal the delta's distinct keys).

## Part 3 — order of work

Staged after a full load is proven end to end, as agreed:

1. **Watermark for the grant statements** (A1, A2, A3). Token storage, `@Since`, the
   overlap, and storing the token only after verification.
2. **Reconcile by completeness.** Full-read slots reconcile in delta runs (A6, A7).
3. **Key sweep**, on the shared staging primitive once it exists (A5, and the 5% guard).
4. **Narrowed sweep**, only if A9 holds and the primitive supports a principal bound.

Each step lands with its own tests against the
[IdentityIQ-shaped fixture](https://github.com/Fortigi/IdentityAtlas/tree/main/tools/iiq-fixture). Its
timestamps already follow A1/A2, and it needs a mutation script (update some grants,
delete some, re-insert some) to rehearse a delta and a sweep. That script is the next
piece of fixture work.
