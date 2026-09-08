# The epic layer

Features are built one at a time. Some questions cannot be answered one at a time.

This page describes the layer added on 2026-09-07/08 above the feature backlog: what it is, how
it is wired, and the conventions that keep it from interfering with the
[Definition of Ready](definition-of-ready.md) pipeline underneath it.

!!! info "Companion pages"
    [`definition-of-ready.md`](definition-of-ready.md) — the process a *feature* runs through.
    [`dor-state-machine.md`](dor-state-machine.md) — the board columns as a state machine.
    [`autonomy-roadmap.md`](autonomy-roadmap.md) — where this is going, and what is still missing.
    `docs/architecture/decision-principles.md` — the rules an architecture question is checked
    against before it becomes a human question at all.

---

## Why

Three problems, all of which are invisible when each feature is specced in isolation.

**Questions get asked N times.** Seven `awaiting-design` tickets (#749, #750, #752, #754, #757,
#762, #764) were one question — *what is our shared component and token API?* — asked seven times
and stalled seven times.

**Contradictions surface at merge, not at spec.** #370 requires the business-role row to exist
("when collapsed, only the business role should remain visible"); #937 removes it from the matrix
resource axis by default. Both were individually certified. The clash was only visible with both
in view.

**Every feature needs its own test environment.** Features from one epic, reviewed together, need
one environment and one pass — the build-side half of this is not yet implemented, see the
roadmap.

## Structure

Native GitHub **sub-issues** carry the hierarchy — no labels, no naming convention. A parent gets a
progress bar; a child gets a *"Tracked by #N"* breadcrumb.

```
[EPIC] Analist begrijpt wat hij ziet          #1103   label: epic
  ├─ [BESLISSING] BR-rij: feature flag?       #1147   label: decision  ⛔ blocks #937, #370
  ├─ [BESLISSING] Rotated view: volwaardig?   #1148   label: decision  ⛔ blocks #769, #776
  ├─ #937  Business roles not as a matrix row         ← blocked by #1147, #1149
  ├─ #370  Collapse managed resources                 ← blocked by #1147
  └─ …
```

Three levels occur. An epic may hold a **sub-epic** which holds slices — used where a decomposed
item is itself large (#939 BloodHound under #1107; #837 role review under #1139; #673 auto-update
under #1140).

### Two directions

| | Origin | Example |
|---|---|---|
| **Bottom-up** | Features already existed; the epic is a new container over them | #1101–#1107 |
| **Top-down** | A `state:decompose` item *becomes* the epic; slices are created beneath it | #672, #699, #843 |

The second is what `state:decompose` was always asking for. An epic with one child is not an epic —
it is an item whose slices do not exist yet, which is exactly the signal that route should give.

!!! warning "One word, two things — being fixed"
    Those two directions did not produce the same kind of object, and calling both "epic" hides it.
    Counted on 2026-09-08: **13 of the 22 are goal-shaped** (a *doelstelling* with features
    contributing to it) and **9 are features with implementation slices** — and the split runs
    exactly along bottom-up versus top-down.

    The agreed fix is to **type them, not move them**: add GitHub Issue Types `Epic` and `Slice`
    alongside the existing `Feature`, so each issue says what it is without anything being
    re-parented. Grouping and conflict detection do not depend on the level, so nothing here stops
    working in the meantime. See
    [`autonomy-roadmap.md`](autonomy-roadmap.md#naming-the-layer-honestly) — steps A and B.

## Boards

| Board | Holds | Driven by |
|---|---|---|
| [#2 Feature Pipeline](https://github.com/orgs/Fortigi/projects/2) | features + slices | the DoR automation, unchanged |
| [#3 Bug Pipeline](https://github.com/orgs/Fortigi/projects/3) | bugs | unchanged; bugs are deliberately out of the epic layer |
| [#4 Epics](https://github.com/orgs/Fortigi/projects/4) | the 22 epics | manual |

An issue can sit on several boards. Features keep their `state:*` label, their Status and their
position on board #2 — the epic layer adds a relation, it does not move anything.

### Fields

**Driver** — why this matters, in priority order. On both boards.

| | | |
|---|---|---|
| 1 | **Product trust** | consistency, correctness, anything that undermines confidence in the product |
| 2 | **Klantvraag** | a named customer is waiting |
| 3 | **Marktkans** | a segment we want to open, no customer yet |
| 4 | **Adoptie** | simpler, friendlier, easier to install |
| 5 | **Nieuwe feature** | new capability close to the core |
| 6 | **Innovatie** | exploratory, further from the core |
| 7 | **Bouwsnelheid** | internal quality: CI, tech debt, how fast we build tomorrow |

**Effort** — `S` / `M` / `L`, on the feature. Deliberately a *separate* field from Driver: "too easy
not to do" is a cost, not a reason, and it should be able to cut across every driver. `Effort:S` is
the shortlist of things that can jump the queue whatever their driver.

**Status** (board #4) — `Conflict` · `Ontwerp open` · `Klaar om te bouwen` · `Loopt` ·
`Geblokkeerd` · `Geparkeerd` · `Klaar`. `Conflict` and `Ontwerp open` are deliberately separate:
children contradicting each other is a different problem from one unanswered question.

!!! warning "This field holds two different things — being split"
    An epic cannot be *ready to build*; only a feature can. Review on 2026-09-08 established that
    two kinds of value were put in one field: `Conflict` and `Ontwerp open` are **intrinsic to the
    parent** — a contradiction *between* children is a property of the level above — while
    `Klaar om te bouwen`, `Loopt`, `Geblokkeerd` and `Klaar` are a **roll-up of the children** that
    the native sub-issue progress bar already shows.

    The field becomes **`Besluit`**: `Conflict` · `Ontwerp open` · `Geen open besluit`. Progress
    comes from the sub-issues themselves.

**Conflict** (text, board #4) — the clashing pair plus the decision issue, so the board row says
what is wrong without opening anything: `#937 ↔ #370 (+migr 061) · rotated view ×4 → #1147 #1148`.

Features **inherit Driver from their parent epic**; exceptions are set by hand and are then visible
as a row that differs from its epic (#935 is the only one today). Effort is read from the issue body
where the audit issues already carried `**Effort:** S/M/L`.

## Decision issues

A contradiction is not a dependency between two features — it is a *decision* both are waiting on.
So it gets its own issue.

- Label **`decision`**, no `enhancement`/`bug` — it stays out of the DoR pipeline.
- Sub-issue of its epic: visible on board #4, counted in the progress bar.
- Blocked features carry it as **`blocked by`** (native GitHub issue dependencies), so the block is
  visible from the feature, not only from the epic.
- Body states: the clash with quoted evidence, the question in one sentence, the options, what it
  blocks.
- **Closing the issue is the decision.** Both features unblock automatically.

`label:decision is:open` is the answer to *"where do we have a conflict?"*

## Conventions

**An epic never carries `enhancement` or `bug`.** `dor-triage` fires only on those two labels
(`dor-triage.yml:27-28`), so an epic triggers no board add and no AI interview. Verified: every
agent workflow run on an epic conclusions as `skipped`.

**No DoR workflow reads parent/child.** Grepped across all `dor-*.yml` and `dor_*.sh`: zero
references. The relation layer is invisible to the automation, which is why the whole layer could be
added without touching the pipeline.

**Only buildable slices carry `enhancement`.** The first slice of an epic enters the pipeline; the
rest are created without labels and are labelled when their dependency lands. Each parked slice says
so in its body. This keeps the board honest and prevents N simultaneous interviews.

**Converting a `state:decompose` item to an epic:**

1. Remove `enhancement` and `state:decompose`, add `epic` *(do this first — `unlabeled` is not an
   agent trigger, but `edited` is, so relabel before editing the body)*
2. Prepend the epic framing; keep the original body in a `<details>` block
3. Remove from board #2 — otherwise `dor_reconcile.sh:253` reports 🕳️ *"on the board with no
   `state:*` label"* every hour
4. Add to board #4, set Driver and Status

**Write slice bodies without cross-referencing sibling issue numbers.** `issues.edited` is an agent
trigger, so correcting numbers after creation costs one extra AI run per slice. Let the sub-issue
relation and the epic's slice table carry the ordering instead.

## What this layer deliberately does not do

- **No new gate.** The two GitHub-enforced human gates (value, merge) are untouched. An epic on
  `Conflict` does not stop anything mechanically — it is information, and the reconcile check that
  would flag it is still on the roadmap.
- **No bugs.** They run their own pipeline on board #3.
- **No change to any feature's labels, Status or board position.**

## Known papercuts

| | |
|---|---|
| **`dor-blank-triage`** applies `needs-triage` plus three assignees to every issue without `enhancement`/`bug` — so to every epic and every decision issue. Cleaned by hand each round. Fix is a two-line condition excluding `epic`/`decision`. | tracked under #1142 |
| **Board #4's "auto-add sub-issues" workflow** pulls every child onto the epic board on each new link. Removed by hand each round; there is no API to disable it — Project #4 → ⚙️ → Workflows. | manual |

## State on 2026-09-08

22 epics · 67 features with a parent · `no:parent-issue` = 0 · 14 decision issues · 30 `blocked by`
links.

| Status | |
|---|---|
| Conflict | 10 |
| Ontwerp open | 5 |
| Klaar om te bouwen | 3 |
| Geblokkeerd | 3 |
| Geparkeerd | 1 |

Ten epics have children that contradict each other. That number is not new — it was invisible while
it sat one issue at a time.
