# Adjust tree — a generated organisation tree you can correct

**Status:** first slice built (§9). Stacked on the context-templates POC (`feature/context-change-requests`).
Sections 1–8 are the design as proposed; §9 records the decisions taken and how v1 differs.

The manager-hierarchy plugin turns `Principals.managerId` into a tree of organisational units. It
assumes that the result is right. In practice it rarely is: the manager chain and the HR department
fields describe the organisation imperfectly, and the analyst who knows the real structure ends up
rebuilding it by hand in Excel or Power Query. This document describes how the tool takes over that
work: a better first tree from the data, a full-width screen to correct it, and corrections that are
kept as named, reviewable **adjustments** that survive every re-run — so the corrected tree keeps
following the source instead of becoming a stale copy of it.

## 1. What an analyst does today, outside the tool

Collected from a practitioner who builds these structures for customers:

1. **Pick the top deliberately.** "Who has no manager?" also returns leavers, test accounts and dirty
   data. The analyst roots the tree on a job title (*CEO*) or on a named person — and often on the
   person *and their department*: the board (CEO, CFO, COO) is one department, while CFO and COO
   formally report to the CEO.
2. **Walk down the manager chain** from that top to get a global structure.
3. **Read the unit names from the people, not from the manager.** For each manager, look at the
   division, department and team values of the people reporting to them and distil which unit this
   is. (A manager's own department is usually the unit *above* the one they run.)
4. **Correct by hand.** Override a single manager relation; split a manager who runs two teams into
   two units; re-hang a unit that sits elsewhere in reality. Interim management is common: a head of
   department temporarily manages one or two units that belong to a completely different branch.
5. **Validate against the formal organogram** (slides or images on the intranet).
6. **Once the structure is trusted, map the sources onto it**: how do the HR divisions/departments/teams,
   the directory and system X each relate to this master structure?
7. **Keep it current** — in the tool, as a maintenance process, not in a spreadsheet.

Steps 1–4 and 7 are in scope for this design. Steps 5 and 6 are later phases (§8).

## 2. What exists today

On the POC branch the manager-hierarchy plugin (`app/api/src/contexts/plugins/manager-hierarchy*.js`)
emits a synthetic root plus one unit per manager (`externalId` = the manager's Principal id). The
parent of a unit is the manager's own manager; members are direct reports; the manager is the unit's
`Accountable`. Units are named from the **manager's** own attribute values (`nameFields`).

Three kinds of analyst edit already survive a re-run, each through its own mechanism:

| Edit | Mechanism | Where |
|---|---|---|
| Rename a unit | `Contexts.userRenamed` flag, UPDATE keeps the name | migration 033, `runner.js` `updateContextRow` |
| Move a unit to another parent | `Contexts.userReparented` flag, parent kept | migration 033, `runner.js` `linkContextParents` |
| Move a person to another team | `ManagerHierarchyOverrides` row (principal → effective manager) | migration 035, `routes/contexts/members.js` |

Gaps this design closes:

- **One unit per manager.** No split, no merge, no interim manager of a unit elsewhere in the tree.
- **The root is a catch-all.** Everyone without a manager lands under the synthetic root, next to the
  real top of the organisation.
- **Moving a manager (as a person) does not move their unit** — `buildManagerContexts` places units by
  the source `managerId`, not the override.
- **A re-run can silently lose edits.** A unit that leaves the plugin output is deleted, and
  `ON DELETE CASCADE` takes manual sub-units and analyst-moved units under it along.
- **Double membership.** Moving a person leaves an `addedBy='analyst'` membership behind; when the
  source later changes that person's manager, they can sit in two teams.
- **Edits leave no trail.** Two flags and a side table — there is no list of "what did we change, who,
  why", and no way to undo one edit.
- **The screen.** In the template UI the tree is a 384 px side panel shared with search and filters;
  drag-and-drop works only inside one source group; the run tab after "Create" only says *Go there
  now →* and does not even select the new tree.

## 3. The model: base tree + adjustments

The tree an analyst sees is

```
  shown tree  =  apply( adjustments , base tree from the plugin )
```

- The **base tree** is what the plugin derives from the source data on every run, exactly as today.
- An **adjustment** is one recorded correction: *move unit X under Y*, *move person P to unit Z*,
  *split unit X by department*, *rename*, … Adjustments are keyed on the plugin's stable
  `externalId`s, so they re-apply cleanly to every new base tree.
- Applying happens **in the runner, between the plugin and the reconcile** — not in the UI. Every
  consumer (matrix, reports, access review, owner pages) sees the corrected tree, and the plugin stays
  a pure "derive from source" function.

This is the existing generated-variant reconcile (decision principle **A4**), with the three
ad-hoc mechanisms of §2 folded into one: `userRenamed`, `userReparented` and
`ManagerHierarchyOverrides` become adjustments, migrated once. 🟡 A4 is not fully settled — this
generalises an existing side table rather than inventing a new lifecycle, but it should get an
architect's nod.

### 3.1 The adjustments table

```sql
CREATE TABLE "ContextTreeAdjustments" (
  id                 uuid PRIMARY KEY,
  "algorithmId"      uuid NOT NULL REFERENCES "ContextAlgorithms"(id) ON DELETE CASCADE,
  "scopeSystemId"    int  REFERENCES "Systems"(id) ON DELETE CASCADE,
  "sourceInstanceKey" text NOT NULL DEFAULT '',     -- which tree (same key the runner uses)
  seq                bigint NOT NULL,                 -- apply order
  op                 text NOT NULL,                   -- see 3.2
  "subjectKey"       text NOT NULL,                   -- externalId of the unit, or principal id
  payload            jsonb NOT NULL,                  -- op-specific
  reason             text,                            -- optional, shown in the log
  "validUntil"       date,                            -- interim arrangements
  status             text NOT NULL DEFAULT 'active',  -- active | orphaned | expired | reverted
  "statusDetail"     text,                            -- why it no longer applies
  "createdBy"        text NOT NULL,
  "createdAt"        timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  "lastAppliedRunId" uuid
);
```

Plus the usual `_history` trigger. A reverted adjustment stays in the table (status `reverted`) so the
log shows it; undo of a revert is a new adjustment.

### 3.2 Operations

| op | payload | Effect on the base tree |
|---|---|---|
| `moveUnit` | `{ toParent }` | unit's parent becomes `toParent` (a unit key) |
| `renameUnit` | `{ name }` | display name |
| `movePerson` | `{ toUnit }` | person's membership moves to `toUnit` (replaces `ManagerHierarchyOverrides`, but targets a **unit**, not a manager — after a split one manager has several units) |
| `splitUnit` | `{ by: attribute, values: [...] }` or `{ members: [...], name }` | people matching are carved out into a new child unit with a derived key `<unit>::<value>`; it can then be moved like any unit |
| `mergeUnits` | `{ into }` | the subject's members and children move into `into`; the subject disappears |
| `addUnit` | `{ key, name, parent }` | a unit that does not exist in the data (e.g. a "Board" level above CEO, CFO and COO) |
| `dissolveUnit` | `{}` | members and children go to the parent (a secretariat that is not a real unit) |
| `setManager` | `{ principalId, kind: 'Accountable' \| 'Interim' }` | role on the unit; `Interim` carries `validUntil` |

`apply()` is a pure function `(baseResult, adjustments) → { result, statuses }` in its own module,
unit-tested op by op, with the runner only calling it.

### 3.3 When an adjustment no longer fits

The source keeps changing; an adjustment can lose its footing. Rules:

- **Subject gone** (the unit or person left the base tree) → status `orphaned`, with the reason. Never
  silently dropped; shown in *Needs attention*.
- **Target gone** (`moveUnit` / `movePerson` to a unit that no longer exists) → the subject falls back
  to its generated place, adjustment `orphaned`.
- **Already true** (HR now has the person under that manager anyway) → status stays `active` but the
  screen marks it *now matches the source — remove?*.
- **Expired** (`validUntil` passed) → status `expired`, effect no longer applied, shown for review.
  Interim arrangements end visibly instead of lingering.
- **A unit that leaves the output is no longer cascade-deleted with what hangs under it.** Units that
  are only there because of an adjustment (`addUnit`, moved units, split units) re-attach to the
  nearest surviving ancestor and their adjustment is flagged. This replaces today's cascade loss.
- Because `movePerson` is applied *before* reconcile, the person is an ordinary algorithm member of
  exactly one unit — the double-membership bug disappears with it.

### 3.4 Manual and imported trees

- **Manual trees** have no base; the Adjust tree screen edits them directly (today's PATCH routes).
- **Imported trees** (crawled, uploaded lists) stay read-only — the source is edited, as the upload
  design already says. A later step can offer *Use as the starting point for an adjustable tree*.

## 4. A better base tree

New, optional parameters on the manager-hierarchy plugin. Defaults keep today's behaviour and
today's `externalId`s, so existing trees and their edits are untouched.

| Parameter | What it does | Why |
|---|---|---|
| `rootMode` = `auto` \| `person` \| `jobTitle` | `person`: `rootPrincipalIds`; `jobTitle`: `rootJobTitlePattern` (RE2) | Step 1 — choose the top instead of "everyone without a manager" |
| `rootTakesDepartment` | the root person's department colleagues form the top unit together | the board case: CEO, CFO, COO in one top unit |
| `nameFrom` = `manager` \| `members` | `members`: name a unit after the most common value among its members (fallback: manager's value) | Step 3 — a CFO sits in the board's department; their unit is *Finance* |
| `splitBy` (attribute) + `splitMinMembers` | a manager whose reports span several values of that attribute gets one unit per value (≥ min members); the largest group keeps the manager's key | the "manages two teams" and the interim-manager cases |
| `excludeInactive` | leave disabled / departed accounts out | leavers polluting the top |

People who are not under the chosen root land in a **Not placed** unit next to the tree, instead of
under the real top. It is visible, countable and a source of *Needs attention* items.

With `splitBy` off, the same detection still runs and produces *split candidates* in *Needs
attention* — one click turns a candidate into a `splitUnit` adjustment. So an analyst can start from
today's shape and split only where it matters.

**Worked example (fictional):** Bram heads IT. Two people from *Facilities* report to him on an
interim basis. With `splitBy = department`, Bram gets two units: *IT (Bram)* with the manager's key,
and *Facilities (Bram)* keyed `bram::Facilities`, initially under *IT*. One `moveUnit` adjustment hangs
*Facilities (Bram)* under *Operations*; a `setManager … Interim, validUntil 2027-03-31` records that it
is temporary. When the interim ends and HR moves those people to their new manager, the split unit
disappears from the base, the `moveUnit` becomes orphaned and is shown for clean-up.

## 5. The Adjust tree screen

A full-width app tab, type `adjust-tree`, one per tree.

**How you get there**
- After *New context tree → From the manager hierarchy*: the run tab is the Adjust tree tab. While the
  run is going it shows progress (today's `RunDetailPage` content); when it succeeds it turns into the
  editor on the new tree — no more "Go there now →".
- From any generated or manual tree: ⋯ → *Adjust tree*.
- For an imported tree the action is shown disabled with "This tree is maintained in its source".

**Layout**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Organisation (from Entra ID) · last refreshed 08:12 · 14 adjustments   [Refresh] │
├───────────────────────────────────────────────┬───────────────────────────────┤
│ [search people or units]   ☐ show people       │ Unit | Needs attention (7)    │
│                                               │      | Adjustments (14)        │
│ ▾ Board (Anna)                    3 · 2 412   │      | Since last refresh (5)  │
│   ▾ Finance (Carl)        ✎       48          │ ───────────────────────────── │
│      ▸ Accounting (Dina)          21          │ Finance                       │
│   ▾ IT (Bram)                     130         │ Manager  Carl Jansen          │
│      ▸ Workplace (Eva)            40          │ Why here reports to Anna;     │
│   ▾ Operations (Frank)            700         │          department "Finance" │
│      ▸ Facilities (Bram) ⏱ interim 12         │          (46 of 48 members)   │
│ ▸ Not placed                      17          │ Adjusted renamed by Wim,      │
│                                               │          10 Oct — "HR typo"   │
│                                               │ [Rename] [Split…] [Merge…]    │
│                                               │ [Add sub-unit] [Set manager]  │
└───────────────────────────────────────────────┴───────────────────────────────┘
```

- **Tree (left, ~60 %)**: the whole tree in one drag-and-drop area (one `DndContext`, @dnd-kit, already
  a dependency). Drag a unit onto a unit = move. Toggle *show people* to drag people between units
  (multi-select). Adjusted units carry a small mark; interim units a clock. Search finds people and
  units and expands to them.
- **Unit**: who manages it, why it is where it is (the source facts that put it there), what was
  adjusted, and the actions. Each action can take an optional reason.
- **Needs attention**: people *Not placed*; split candidates; managers who also run units in another
  branch; units without a manager; orphaned and expired adjustments; adjustments that now match the
  source. Each item has its one-click fix.
- **Adjustments**: the log — what, who, when, why, status — with *Undo* per line.
- **Since last refresh**: units that appeared or went, people the source moved, adjustments that
  stopped applying.

Edits take effect immediately; there is no separate "publish" step in v1 (see open question Q2).
Vocabulary follows the template-UI rules: *unit*, *manager*, *people* — no *plugin*, *variant*,
*principal*, *externalId*. Only users with `data.write.contexts` get the screen.

## 6. API

| Route | Purpose |
|---|---|
| `GET  /api/context-trees/:rootId/adjustments` | the log, with status |
| `POST /api/context-trees/:rootId/adjustments` | add one (validated per op), re-apply, return the changed units |
| `DELETE /api/context-trees/:rootId/adjustments/:id` | undo (status `reverted`), re-apply |
| `GET  /api/context-trees/:rootId/attention` | the *Needs attention* list |
| `GET  /api/context-trees/:rootId/changes?sinceRun=` | *Since last refresh* |

The existing `PATCH /contexts/:id` (rename / reparent) and `PATCH …/members/:id/move` on a
generated tree write an adjustment instead of the flags / override table, so older screens keep
working.

## 7. Delivery — a stack of PRs

1. **Adjustments model** — migration (table + migrating 033/035 state), pure `apply()` module, runner
   wiring, orphan/expiry rules, the cascade fix. API only. Unit tests per op and per orphan rule.
2. **Better base tree** — the §4 parameters, *Not placed*, split candidates. Existing trees unchanged
   (defaults), proven by a test that runs the old fixture with old params and compares keys.
3. **Adjust tree screen** — the tab, tree + Unit + Adjustments, run tab turns into the editor, ⋯ entry.
4. **Needs attention + Since last refresh** — the review side.

Later, separate designs:

5. **Map sources onto the tree** — per source (HR division/department/team, directory department,
   an application's own org field), a mapping of its values onto the adjusted tree, with coverage and
   a side-by-side view. This is "how does the HR source relate to the master organogram".
6. **Check against the formal organogram** — upload slides/images, a model reads them into a
   structure proposal (decision principle **B3**: a proposal for the analyst, never written as
   truth), diffed against the tree. Builds on the interview-extraction work.
7. **Maintenance by the people themselves** — the *manager survey* of
   [Ownership survey](ownership-survey.md): a unit's manager confirms "this is my team", and
   corrections come back as adjustments with `createdBy = survey`.

## 8. Open questions

- **Q1 — Unit keys after a split.** The largest group keeps the manager's key, the rest get
  `<manager>::<value>`. If the department value is renamed in HR, the derived key changes and the
  adjustments on it orphan. Acceptable (they are shown), or key on a department *code* where one exists?
- **Q2 — Immediate apply at scale.** Re-applying means re-running plugin + reconcile; at 200k people a
  full member replace is seconds, not milliseconds. Options: (a) keep the last base result per tree and
  re-apply only adjustments, with a diff-based member reconcile; (b) a draft mode that collects edits
  and applies them together. Recommendation: (a), measured on the scale rig before PR 3.
- **Q3 — One source or several.** v1 builds the base from one system (the HR source *or* the
  directory). Combining manager data from two systems (HR for the chain, directory for the team names)
  needs identity-level correlation and is deferred.
- **Q4 — Other generated trees.** The adjustments layer is generic (any plugin with stable keys).
  Should *Adjust tree* be offered on clustering / tag trees from day one, or only on organisation units?

## 9. Decisions and the first slice (built)

Decisions (2026-10-24):

1. **Apply immediately.** Every edit is applied to the stored tree at once; a few seconds for a large
   move is acceptable. No draft mode.
2. **When the source renames or re-keys, warn and ask.** An adjustment whose unit vanished is matched
   against the units that now hold most of its members; a split whose value matches nobody is matched
   against the value its people now share. Either way the adjustment goes to *needs your decision* with
   the proposal; nothing is followed silently. (Later: show the old and the new tree side by side for
   a large reorganisation.)
3. **Generic, not only organisation units.** The same screen and adjustments work on any generated,
   imported or hand-built tree — for example grouping a flat list of logical applications under a new
   level ("Physical access" above the badge, door and camera applications).

What v1 does differently from sections 3–6:

- **A tree is named by its source, not by a root id** (`contexts/adjustments/treeKey.js`):
  `gen~<algorithmId>~<instanceKey>` (a plugin tree), `sync~<systemId>~<template>` (every imported unit
  of one source and one template — a flat list of roots is one tree), `ctx~<rootId>` (a hand-built
  tree). Adjustments point at units by context id; ids are stable across runs and syncs, which also
  keeps change requests (#1452) valid.
- **Adjustments are applied to the stored rows after every rebuild**, not to the plugin output before
  reconcile: after a plugin run (`runner.js`, inside the reconcile transaction) and after an ingest batch
  or session of `Contexts` / `ContextMembers` for that source (`afterSync.js`). Every handler is
  idempotent; after any change all active adjustments of the tree are applied again in order.
- **Imported trees are adjustable** (decision 3). A unit an adjustment adds is a `manual` context, so a
  full sync of the source never deletes it.
- **Undo restores the recorded `before`** (old parent, old name, old Accountable, the unit a member came
  from), because an imported tree cannot be regenerated on demand.
- **Operations in v1:** move unit, rename, move member, add unit, split (by attribute for accounts, by
  picked members for any tree), set manager (optionally interim, with an end date). Merge and dissolve
  are not in v1. The old flags (`userRenamed`, `userReparented`) and `ManagerHierarchyOverrides` stay as
  they are; adjustments set the flags so the plugin keeps a moved or renamed unit in place.
- **The plugin runner no longer cascade-deletes** a unit that is not its own when its parent vanishes;
  it is lifted to the top level and its adjustment reports it.
- **Manager hierarchy options** (all optional, defaults unchanged): `topMode` (`auto` / `jobTitle` /
  `people`), `topJobTitle`, `topPrincipalIds`, `notPlacedUnit`, `nameFrom` (`manager` / `members`),
  `splitBy`, `splitMinMembers`, `excludeInactive`.
- **Not in v1:** *Since last refresh*, the side-by-side view of an old and a new tree, mapping sources
  onto the tree, reading organograms.
