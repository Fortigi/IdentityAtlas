# Session log — introducing the epic layer (September 2026)

What changed on 2026-09-07/08, in order, and why. Kept because the *reasoning* is the expensive part
and several of these choices were corrections to earlier ones.

For how the result works, see [`epic-layer.md`](epic-layer.md). For where it is going, see
[`autonomy-roadmap.md`](autonomy-roadmap.md).

---

## Starting point

A review of the architecture guidance (PR #1146) had found that **17 of 22 `awaiting-design` issues
were already answered** — the agent had proposed, nobody had replied. That reframed the problem: the
bottleneck was permission, not capability. It also found contradictions that only appear when
related features are read together, which is what led to the epic layer.

## What was built

### 1. Feasibility, verified before building

Two facts decided the whole approach:

- **No DoR workflow reads parent/child relations.** Grepped every `dor-*.yml` and `dor_*.sh`: zero
  references. So a hierarchy could be added without touching the pipeline.
- **`dor-triage` fires only on `enhancement`/`bug`** (`dor-triage.yml:27-28`). So epics without those
  labels trigger nothing — no board add, no AI interview, no tokens.

Both held. Every agent run on an epic concluded `skipped`.

### 2. Bottom-up: 7 epics over existing features

#1101–#1107, covering 32 features, each with a Fortigi-shaped body (doelstelling, Key Result,
meetmoment, acceptatiecriteria, afhankelijkheden, risico's) and a Key Result grounded in something
already in the repo — the load-test dataset, the audit tables, the design-system lint gate.

### 3. Top-down: 10 `state:decompose` items became epics

#672 first (its five-slice plan had been sitting unexecuted in a comment since 5 August), then #699,
#843, #939, #676, #207, #723, #875, #934, #837, plus a new governance epic #1139 and, later,
#1140/#1141/#1142 and #673.

31 new slice issues. Only the first slice of each epic carries `enhancement`; the rest wait.

### 4. Prioritisation

**Driver** (7 values, ranked) and **Effort** (S/M/L) on both boards. Effort was deliberately split
from Driver: *"too easy not to do"* is a cost, not a reason, and must cut across every driver.

### 5. Conflict round

Four parallel agents read every epic's children *together*, including what sits in open PRs. Results
posted as one comment per epic; 14 **decision issues** created with native `blocked by` links to the
30 features they block.

## Corrections made along the way

Recorded because the pattern matters more than the individual errors — several were mine, found by
the conflict round.

| | |
|---|---|
| **#1104's Key Result did not match its children.** It measured 8 Low/Info items from the maintenance audit; #783/#784/#785 are Medium items from a *different* document, and L-8's issue was closed as NOT_PLANNED | corrected in the epic body |
| **#1106's Key Result was unachievable.** It demanded "same semantics as other rights"; #921 deliberately does the opposite (query-time, opt-in, `I` badges). Its second half was measured by work parked in another epic | corrected |
| **#1107 invented a hard dependency its own child denies.** The epic said "#939 → #940 is hard"; #940 says *"Independent of #939… not a hard dependency"* | corrected |
| **#672 repeated a wrong cross-reference.** The DoR comment claimed #935 touches org-risk config; #935 is a natural-language chat interface. It was gating slice 3 for no reason | corrected |
| **#699's Key Result was unachievable as scoped.** "No `db.query` outside `src/data/`" — but 38 non-route files call it, including `perf/sqlTimer.js` which *defines* `timedQuery` | became decision #1150 |
| **Three features were placed on their title, not their content.** #680 is the Users list page, not the matrix. #84 is a per-page export button, not a report. #687 belongs with #679 (same file) | re-parented |
| **Three auto-update slices were parked on a blocker that no longer existed** — the `blocked-external` label had been removed by the epic conversion itself | corrected |

## Lessons worth keeping

**`issues.edited` is an agent trigger.** Correcting placeholder issue numbers after creation cost one
extra AI run per slice. Write slice bodies without sibling numbers; let the sub-issue relation carry
the ordering.

**`dor-blank-triage` catches everything without `enhancement`/`bug`** — including every epic and
decision issue, applying `needs-triage` plus three assignees. Predicted the `dor-triage` behaviour
correctly and missed this one entirely.

**Board #4's "auto-add sub-issues" workflow** pulls all children onto the epic board on every new
link. No API to disable it.

**`gh project field-create` does not set colours;** the GraphQL mutation does. Changing options
regenerates their IDs, so every value has to be re-set afterwards.

**Verify before asserting.** Two claims that survived checking (the umbrellas #777/#787 genuinely
cannot be split — their content is withheld in reports kept outside the repo) and one that did not
(the audit status tables are stale: #758 is closed while the table still says open, and two epic Key
Results are measured against those tables).

## Interview outcomes (2026-09-08)

Four deviations from the Fortigi approach, now deliberate rather than accidental:

| | |
|---|---|
| **Flow, no sprints** | Product development is not a customer implementation |
| **Epics *are* the objectives** | No separate layer above them; niveau 2 and 3 merge; Driver becomes the portfolio view |
| **One fixed review moment, all Key Results at once** | Not a date per KR |
| **The autonomy ladder is vocabulary, not mechanism** | Voordoen → Loslaten maps onto 🟡/🟢/autobuild, but no field is built for it |

Features flow; the review layer has a cadence. The approach's "fixed rhythm without breaking
governance" applies here at the epic layer rather than the feature layer.

## Review outcome (2026-09-08)

Two objections came back from review, and they turned out to be the same problem.

**On the levels.** *"An epic is a goal with features under it that contribute to reaching it. What
you call Epics are Features, and what hangs under them are stories."* Counted: **13 of 22 are
goal-shaped, 9 are features with implementation slices** — the split runs exactly along bottom-up
versus top-down. One word had been used for two operations without the difference ever being named.

**On the status field.** *"An epic cannot be ready to build; a feature can."* Correct, and the cause
was putting two kinds of value in one field — one intrinsic to the parent (`Conflict`,
`Ontwerp open`), one a roll-up of the children that GitHub already displays natively.

**Why they are one problem.** The evaluation above answered *"is the Effect layer covered?"* with
*"yes — the epics are the objectives"*. That premise holds for 13 and not for 9, which is why the
answer felt right and read wrong. All three of the approach's tiers already exist here; only the top
two shared a name.

**Resolution: type it, do not move it.** Add Issue Types `Epic` and `Slice`; re-parent nothing.
Grouping and conflict detection are level-agnostic — they work because things that must be judged
together sit together — so nothing built this session is lost. Steps A and B in
[`autonomy-roadmap.md`](autonomy-roadmap.md#the-plan).

**And the part the naming does not fix:** no Key Result has ever been measured. Of the two
objections and the gap they exposed, that is the one worth the most.

## State on close

22 epics · 67 features with a parent · `no:parent-issue` = 0 · 14 decision issues · 30 `blocked by`
· 10 epics on `Conflict` · 4 items left on `state:decompose` (two umbrellas that cannot be split
from repo content, correctly).

**Most urgent:** #937 is at `awaiting-approval` and is blocked by two open decisions (#1147, #1149).
Approving it before those close builds the contradiction in.
