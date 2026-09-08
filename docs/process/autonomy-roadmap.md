# Autonomy roadmap

Where the DoR pipeline and the [epic layer](epic-layer.md) are going, measured against the Fortigi
implementation approach — and what is deliberately not being done.

!!! warning "Working document"
    Written 2026-09-08 from a working session. The evaluation is grounded; the phases are a
    proposal. Nothing here is committed to a date.

---

## The two goals

1. **Better overview, better prioritisation, contradictions surfaced early, and design + functional
   testing optimised** by grouping related work into one epic and building it together on one
   worker.
2. **More autonomy.** Features that stall in `awaiting-design` or `awaiting-requestor` should keep
   moving, by making choices at a higher level of abstraction that individual features can then be
   checked against.

### Is goal 2 realistic?

Yes, with one reframing that changes what to build.

Of the 22 issues sitting in `awaiting-design`, **17 already had an answer** — the agent had posted a
proposal, and nobody had said yes or no. The bottleneck was never that the AI could not decide. It
was that nobody had given it permission to.

So the realistic target is not "the AI decides everything" — that is not even desirable; the value
gate exists for a reason. It is: **every decision is made by a human exactly once, and never again.**
That is a ratchet. Each epic-level decision that generalises becomes a rule, and the next time it is
automatic. It does not converge on 100% — new product choices keep arriving — but it does converge.

A better model helps with the *judgement* questions (intake matching, conflict detection, sharper
probes). It does not help with the *permission* questions. Those are ours.

## Where we are

| Goal | Component | State |
|---|---|---|
| 1 | Overview, prioritisation | ✅ 22 epics, board #4, Driver × Effort × Status |
| 1 | Contradictions surfaced | ✅ one manual round; 14 decision issues, 30 `blocked by` |
| 1 | Contradiction detection as a *mechanism* | ❌ the round was run by hand |
| 1 | Build + test per epic on one worker | ❌ touches reservation, branching *and* acceptance |
| 2 | Decompose → epic → slices | ✅ 10 of 14; mechanism proven |
| 2 | Higher-level rules to check against | 🟡 `decision-principles.md` — PR #1146 open, not merged, not ratified |
| 2 | `awaiting-design` keeps moving | ❌ the bottleneck moved up a level, it did not go away |

And one structural finding that actively undermines goal 2: **the build-readiness probe reads
`main`, so it is blind to work that is built but not merged.** That is exactly why #937's probe
missed #370 — it sits on open PR #933. Until that is fixed, letting the AI decide *more* means
letting it decide on an incomplete picture.

---

## Measured against the Fortigi implementation approach

### Sturen op effect

| Layer | Here |
|---|---|
| **Producten** — sprint products against acceptance criteria | ✅ features with fixture ACs from the probe |
| **Resultaten** — measurable Key Results at agreed moments | ❌ a KR per epic, written; **none measured yet** |
| **Effect** — what we steer on | 🟡 true for 13 of 22 — *see below* |

**Decision (2026-09-08): the epics *are* the objectives.** No separate layer above them. Each epic
body already carries both a *doelstelling* and a *Key Result*, so the approach's three tiers collapse
into two for a team this size. Consequence: **niveau 2 and niveau 3 merge** — the Key Result Review
*is* the Doelstellingen Review. The **Driver** field takes over the portfolio view that a separate
objectives layer would otherwise have provided.

**Correction (2026-09-08, after review):** that decision rests on a premise that holds for only
part of the set. Counted: **13 of the 22 are goal-shaped; 9 are features with implementation
slices** — and the split runs exactly along how they were created (bottom-up grouping produced
goals, top-down conversion of a `state:decompose` item produced features). So the Effect layer is
covered for 13 and not for 9. See [Naming the layer honestly](#naming-the-layer-honestly) — that
section is the answer to both this and the reviewer's naming objection, which turn out to be the
same problem.

### De gesloten cirkel

Doelstellingen → Key Results → Product Backlog → Sprint Backlog → Sprintproducten → Resultaten → back
to Doelstellingen.

Present: Key Results, Product Backlog, sprint products. Absent: **Sprint Backlog** (deliberate, see
below) and **Resultaten** — nobody has measured a KR yet, so the circle does not close. Closing it is
what phase 3.2 and 3.3 are for.

### Drie niveaus van projectbesturing

| | Here |
|---|---|
| **Niveau 1** Sprint Review — products | 🟡 functional acceptance per feature (D2), not per sprint |
| **Niveau 2** Key Result Review — results | ❌ no moment agreed yet — *decision taken, see below* |
| **Niveau 3** Doelstellingen Review — effect | merged into niveau 2 |

**Decision (2026-09-08): one fixed review moment, all Key Results at once.** Not a date per KR.

### Agile ontwikkelen, beheerst implementeren

**Decision (2026-09-08): deliberate deviation — flow, no sprints.** Product development is not a
customer implementation; features flow through as they become ready.

But note what the interview produced: features flow, while the *review* layer gets a cadence. That
is a coherent hybrid, and it is worth naming as such — the approach's "fixed sprint rhythm without
breaking governance" applies here at the **epic layer** rather than the feature layer.

The second half of that page — Change → Test → Release → **Productie** — is a real gap. The DoR ends
at *merge*. The step to production in a customer environment is not in the pipeline at all. That is
#673 (the auto-update apply half), currently blocked with a blocker nobody recorded.

### Kwaliteit ontstaat voor de sprint

| | |
|---|---|
| Definition of Ready | ✅ v3.4 |
| Definition of Done | ✅ the appendix: coverage, file-size, complexity ratchets |
| Acceptatiecriteria | ✅ fixture ACs |
| Testscenario's | ✅ test plan (B9) |
| Afhankelijkheden | ✅ B2, and now native `blocked by` |
| **Risico's** | ❌ **no DoR gate.** Epics have a risk section; features do not |

Five of six. The missing one is a concrete, small addition — see *Worth considering*.

### Kennisoverdracht

Voordoen → Samen doen → Meekijken → Loslaten. Written for handover to a customer team, but it maps
onto the AI's autonomy levels: 🟡 = samen doen, 🟢 = meekijken, the autobuild carve-out = loslaten.

**Decision (2026-09-08): use it as vocabulary, not as a mechanism.** No extra field, no promotion
rule. Useful for talking about where a decision type sits; not something to build.

---

## Naming the layer honestly

Two objections arrived from review, and they turn out to be one problem.

**"How much of the approach have we actually realised?"** The evaluation above answered *the Effect
layer is covered, because the epics are the objectives*.

**"An epic is a goal with features under it that contribute to reaching it. What you call Epics are
Features, and what hangs under them are stories. And an epic can't be *ready to build* — that is a
feature status."**

The second shows the first was half true. Counted:

| Origin | Count | What it actually is |
|---|---|---|
| Bottom-up — existing features grouped | 13 | **goal** (#1103 *Analist begrijpt wat hij ziet*, #1141 *Engineering-kwaliteit*) |
| Top-down — a `state:decompose` item *became* the epic | 9 | **feature with slices** (#843 *Logical Applications*, #672 *Risk scoring tier*) |

One word was used for two operations and the difference was never named. All three of the approach's
tiers already exist here — Effect → Resultaat → Product as Doel → Feature → Slice, and three places
are already correctly nested (#1107→#939, #1139→#837, #1140→#673). What is missing is a *name* for
the top two, which is exactly why the Effect question could not be answered cleanly.

**What does not change.** Grouping and conflict detection are level-agnostic — they work because
things that must be judged together sit together, not because the container is called an epic. The
22 groupings, 14 decision issues, 30 `blocked by` links, Driver, Effort and the conflict round all
stand.

### The fix: type it, do not move it

**Add GitHub Issue Types.** The org has `Task` / `Bug` / `Feature`; add **`Epic`** and **`Slice`**.
Nothing is re-parented — a feature currently sitting at top level stays there and simply reads
`Feature`. `type:Epic` becomes the filter for what is genuinely a goal.

| Type | Carries | Roughly |
|---|---|---|
| **Epic** | doelstelling + Key Result + meetmoment | 13 |
| **Feature** | acceptance criteria, independently valuable | ~85 |
| **Slice** | implementation step, no standalone user value | ~30 |

**Split the Status field.** The reviewer is right that an epic cannot be *ready to build*. Two
different things were in one field: `Conflict` / `Ontwerp open` are intrinsic to the parent — a
contradiction *between* children is a property of the level above — while `Klaar om te bouwen` /
`Loopt` / `Geblokkeerd` / `Klaar` are a roll-up the native sub-issue progress bar already shows.
The field becomes **`Besluit`**: `Conflict` · `Ontwerp open` · `Geen open besluit`.

**Later and incrementally:** the 9 top-level features can take an Epic parent as it becomes obvious
(#699 and #875 under #1141, #207 under #1103, #676 under #1105). Two need a real choice — #672 would
require widening #1107 from *attack paths* to *risk made visible*, and #843 does not fit #1139 as
named. A feature without an epic is not wrong, only not yet placed.

### One caution on vocabulary

"The features underneath are user stories" holds for some and not others. #931 (*a matrix showing
which access packages a group of users hold*) is a user story; #788 (*cursor/keyset pagination for
the flat grid*) is not, and does not become one by relabelling. Under the feature-shaped epics the
children are **slices** — steps with no standalone user value (#1108: *framework + schema, no UI*).

User story is a *format*; INVEST is the *criterion*, and the DoR already enforces the substance —
independently valuable, testable ACs, one buildable cut. Keep the criterion; do not force the label,
or you get *"As a developer I want a migration so that…"*, which helps nobody.

### What remains after the naming fix

The Effect layer becomes genuinely covered. **The Resultaten layer does not.** No Key Result has
ever been measured; niveau 2 — the review that, in the approach, sets the priorities for the coming
period — has no date, no owner and no measurement. That is worth more than the taxonomy.

---

## The plan

Steps A–E come out of the review above; phases 0–3 were set earlier in the session and still stand.

| | | Cost | Why there |
|---|---|---|---|
| **A** | Add Issue Types `Epic` + `Slice`; set the type on ~110 issues | org setting + script, ~1h | Must land **before phase 1.2** — the intake check will teach the agent whatever level structure it finds |
| **B** | Split Status into `Besluit` | ~30 min | Clearly right, small |
| **C** | Key Result Review: a date, an owner, a first round | an agreement, no building | The real gap in the approach |
| **D** | Risks as a DoR gate | S | Closes the sixth element of the quality framework |
| **E** | Give the 9 features an Epic parent | half a day, incremental | Can run alongside; no need to do it at once |

A and B are this week. C is an agenda item. D and E run with phase 1 below.

### Phase 0 — Decisions, no building *(days)*

| | | Why first |
|---|---|---|
| 0.1 | **Merge + ratify `decision-principles.md`** (PR #1146) — or just the 🟢 half | Without it the agent has no rules it is *allowed* to decide against |
| 0.2 | **Batch-ratify** the 17 waiting agent proposals | One hour; clears the standing pile |
| 0.3 | **The three urgent decisions**: #1147 (BR row flag — #937 is at approval), #1149 (hide-a-resourceType mechanism, before #937 lands), #1150 (guard scope) | Together they touch five epics |
| 0.4 | **Policy: ratification by silence** — a proposed decision stands after N days without a veto | **The largest lever in this plan.** The only thing that stops 0.2 being needed again in three months |

### Phase 1 — Close the loops *(weeks, small changes)*

| | | Size | Unlocks |
|---|---|---|---|
| 1.1 | **Probe reads `main` + open `dor/*` branches** | S | Closes the blind spot; precondition for everything below |
| 1.2 | **Intake check** — agent proposes a parent epic and Driver for a new feature (extends phase A3) | S | Keeps the epic layer alive. Start with *proposing*; a human links |
| 1.3 | **Agent checks A5 against `decision-principles.md`** and cites the rule on a 🟢 call | S | Depends on 0.1 |
| 1.4 | **Feedback loop** — an epic decision that generalises produces a proposed diff to the principles | M | The ratchet |
| 1.5 | **Reconcile check** — `ready-to-build` while the parent is on `Conflict`, or `blocked by` an open decision → flag | S | Connects the epic layer to the automation without adding a gate |
| 1.6 | Papercuts: `blank-triage` excludes `epic`/`decision`; auto-add off | XS | |

### Phase 2 — Build and test per epic *(weeks, real design)*

| | | Size | Note |
|---|---|---|---|
| 2.3 | **Epic-level acceptance** — who accepts feature B when A's requestor did not ask for it? | — | **Discuss first.** A role question, not a technical one |
| 2.1 | **Epic-keyed reservation** — `~/.dor-reservation` holds one `<PR> <ISSUE>`; becomes a list per epic | M | `dor_build_lib.sh:201` |
| 2.2 | **Stacked branching within an epic** — slice 2 branches off slice 1; order from the epic's slice table | M | The build agent must know the base branch |
| 2.4 | **Build order from the epic** rather than arrival order | S | Depends on 2.2 |

Trade-off worth stating: epic affinity means an epic's features build *serially* on one box. That is
the coherence we want, but it trades away parallelism — the reason the pool exists.

### Phase 3 — Measure *(later)*

| | | Size |
|---|---|---|
| 3.1 | **Conflict round as a recurring job** — per epic, when a child changes state or is added | M |
| 3.2 | **Key Result as a CI check** where machine-measurable (matrix < 3s on the load-test dataset) — niveau 2, partly self-filling | M |
| 3.3 | **Ratification metric** — how many decisions per month still reach a human, and in which category. The yardstick for goal 2 | S |

### If you do one thing

**0.4.** Zero building, one agreement between three people. Everything else in this plan makes the AI
*smarter*; this is the only item that gives it *permission*.

Then 0.1 → 1.1, in that order.

---

## Worth considering — not yet in the plan

- **A risk gate in the DoR.** The approach's quality framework has six elements; the DoR has five.
  Risks are captured at epic level and nowhere at feature level. Small addition, closes the gap.
- **Who owns the Key Result Review.** The decision is "one fixed moment, all KRs" — it still needs a
  cadence, a date and an owner, or it will not happen.
- **Integration health under flow.** With no sprint review, nothing asks *"does the product still
  hang together after N merges?"* Per-feature acceptance does not answer that.
- **The route to production.** #673 is the missing half of "beheerst implementeren", and its blocker
  was never written down.
- **Effort coverage.** 24 of 67 features have an Effort value, read from audit bodies. The probe
  already sizes work — it could fill the rest.
- **Bugs are outside the epic layer.** Deliberate for now. Whether a bug should inherit an epic's
  Driver for prioritisation is an open question.
- **`decision-principles.md` §E (sizing and decomposition)** is the most speculative content in that
  document — synthesised from patterns across 12 decompose items, with no precedent. Expect it to
  need revision after a few live uses.
