# Dashboard — Trends tab

> Companion to [`027_dashboard_snapshots.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/027_dashboard_snapshots.sql), [`scheduler.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/scheduler.js), [`DashboardTrendsTab.jsx`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/components/DashboardTrendsTab.jsx), [`TimeSeriesChart.jsx`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/components/TimeSeriesChart.jsx).

## What it does

The Trends tab on the Dashboard plots growth over time:

- **% Governed** — share of assignments wrapped by an Access Package / Business Role. The headline chart.
- **Users / Resources / Assignments** — raw counts as separate small charts.
- **Governed (raw)** — secondary chart, useful when total assignments are flat and the % is shifting only because governance is growing.

Range selector: 30 days / 90 days / 1 year / 2 years.

## Architecture

```
┌──────────────┐       60s tick       ┌──────────────────────┐
│  scheduler   │ ─────────────────▶   │ DashboardSnapshots   │
│   tick()     │   captureDashboard…  │  (one row per day,   │
└──────────────┘                       │   ON CONFLICT noop)  │
                                       └──────────────────────┘
                                                  │
                                                  │  SELECT … WHERE date >= today - N days
                                                  ▼
                              ┌─────────────────────────────────┐
                              │  GET /api/admin/dashboard-      │
                              │       timeseries?days=N          │
                              └─────────────────────────────────┘
                                                  │
                                                  ▼
                              ┌─────────────────────────────────┐
                              │  DashboardTrendsTab.jsx          │
                              │   ─► TimeSeriesChart.jsx (×4)    │
                              └─────────────────────────────────┘
```

## Data — `DashboardSnapshots`

| Column | Type | Notes |
|---|---|---|
| `snapshotDate` | `DATE` PK | One row per UTC day |
| `capturedAt` | `TIMESTAMPTZ` | When the row was actually written (debugging) |
| `systems` | `INT` | Exact count |
| `resources` | `INT` | `pg_class.reltuples` estimate (fast on large tables) |
| `businessRoles` | `INT` | Exact `COUNT(*) WHERE resourceType='BusinessRole'` |
| `principals` | `INT` | Estimate |
| `identities` | `INT` | Estimate |
| `assignments` | `INT` | Estimate |
| `governedAssignments` | `INT` | Exact `COUNT(*) WHERE assignmentType='Governed'` (indexed) |
| `relationships` | `INT` | Estimate |
| `contexts` | `INT` | Estimate |
| `identityMembers` | `INT` | Estimate |
| `certifications` | `INT` | Estimate |

The estimate vs. exact choice mirrors the live `/admin/dashboard-stats` endpoint: estimates are good enough for a trend line (well within a couple of percent), exact counts are reserved for filtered columns that need to be on-the-nose (`Governed` for the headline %, `BusinessRole` for the bare number).

## Snapshot capture — when and how

`scheduler.js → captureDashboardSnapshotIfMissing()` runs on every 60-second tick. The function is structured as a cheap existence check + a one-shot INSERT:

```js
const row = await db.queryOne(
  `SELECT 1 FROM "DashboardSnapshots" WHERE "snapshotDate" = CURRENT_DATE`
);
if (row) return;  // already captured today
await db.query(/* INSERT with ON CONFLICT DO NOTHING */);
```

- **First tick of a new UTC day**: writes the row (~50–100 ms).
- **Every other tick (so, hundreds per day)**: one tiny SELECT, no-op.
- **Container restart mid-day**: existence check sees today's row, skips.
- **Migration applies on an already-running stack**: scheduler writes today's row on the next tick.

The INSERT uses `ON CONFLICT ("snapshotDate") DO NOTHING` for defence-in-depth: if two ticks race (e.g. across a clock skew), one wins, the other is a no-op.

## No backfill — deliberate

The `_history` audit table records every INSERT and DELETE per row, so reconstructing daily counts from history is technically possible. We don't, for one reason: **pre-v6 coverage was partial**. Migration 018 widened the history trigger to composite-PK tables (`ResourceAssignments`, `ResourceRelationships`, `IdentityMembers`) only as of mid-2026. A reconstructed early section would tell a misleading "we grew governance from 0%" story when the early days were simply not tracked.

So the chart starts as a single point on the day migration 027 applied and grows from there. After ~2 weeks the line shape becomes informative; after a quarter, the growth narrative is real.

If a future migration adds a robust backfill (e.g. by replaying `_history` insert/delete events), the chart will need a visual marker on the boundary so analysts know which range is reconstructed and which is captured live.

## Frontend — `TimeSeriesChart`

Hand-rolled SVG, no external chart library. The component:

- Accepts `data: [{ date: 'YYYY-MM-DD', value: number }]`.
- Auto-fits the Y axis with a `niceStep`-rounded scale, or pins it (`yMin=0, yMax=100` for percentages).
- Renders an area fill + line + endpoint dot. Per-point hit zones via transparent rects with `<title>` tooltips.
- Empty-state message rendered inside the SVG so the parent container's height stays consistent across data states.
- Dark-mode aware via `useIsDark()` — grid / axis colors swap at render time.

The chart is lazy-loaded — `DashboardTrendsTab` and `TimeSeriesChart` only enter the bundle when the user clicks the Trends tab.

## API — `GET /api/admin/dashboard-timeseries`

| Param | Default | Range | Notes |
|---|---|---|---|
| `days` | 90 | 1 – 730 | Caps at 2 years so the request stays bounded |

Response:
```json
{
  "days": 90,
  "data": [
    { "date": "2026-05-18", "systems": 1, "principals": 8093, "resources": 11375, "assignments": 364883, "governedAssignments": 6827, /* ... */ }
  ]
}
```

`data` is sorted ascending by date. Missing days (e.g. if the scheduler was down) are simply absent from the array — the chart connects across the gap. If you want to detect downtime, compare `data.length` to `days`.

## Related references

- Live dashboard cards endpoint: [`/admin/dashboard-stats`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/routes/admin.js) — used by the Overview tab. Same fast-path technique (reltuples + targeted COUNTs).
- Migration: [`027_dashboard_snapshots.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/027_dashboard_snapshots.sql).
- Scheduler: [`scheduler.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/scheduler.js) — `captureDashboardSnapshotIfMissing` is the first call in each tick.
- Frontend entry: [`DashboardPage.jsx`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/src/components/DashboardPage.jsx) — tab strip between Overview and Trends.
