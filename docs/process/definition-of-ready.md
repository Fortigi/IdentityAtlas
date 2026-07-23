# Definition of Ready v2 — the "ready-to-build" checklist

**Purpose.** Produce a spec so complete that building, testing and documenting run with **no human decisions mid-build and no silent assumptions**. All human decisions are front-loaded into intake. The build is decision-free; the only human step after is a *mechanical* functional check against fixture-backed acceptance criteria.

**Gate.** A spec is `ready-to-build` only when **Phase A and Phase B are complete and Phase B's final pass surfaced nothing new**, and the requestor has confirmed the summary. It is buildable only after the separate product GO (`approved`). Missing any of this ⇒ `needs-clarification` (hard blocker — the build must not start).

---

## Phase A — Intent interview (what & why)
- **A1 Problem & value** — stated as a user/governance question, not a solution; who it's for; why it's worth doing now.
- **A2 Scope boundaries** — what it deliberately does NOT do, written down.
- **A3 Backlog context** — related issues identified; anything that is a *precondition* (must be done first) or overlaps/duplicates; the feature is weighed against the rest of the backlog, not in isolation.
- **A4 External dependencies** — known and secured, or explicitly N/A.
- **A5 Architecture fit** — it fits the existing architecture, OR it names exactly which architecture principle must change (and that change is agreed).
- **A6 Documentation needs** — what a user/developer will need to understand it, surfaced now.

## Phase B — Build-readiness probe (can it actually be built?) ← the part that makes a spec *real*
Intent is now fixed. **Draft the actual implementation against the real code and schema — far enough to hit the walls.** This is an implementation dry-run, *not* a second read-through: contradictions only appear when you write the real thing. (Re-reading with intent is what let the last defect through — the author had already read the schema.)

- **B1 Trace every value to its real storage.** For each value, condition, edge, or derived field the feature needs, locate the EXACT storage (table+column, JSON path, relationship, matview) and **write the real query / pseudocode that produces it.** If a value spans more than one hop or table, write the full join path. If a value the feature assumes does not exist as modelled — it's derived, lives in a blob, or is several hops away — that is a question: raise it, don't paper over it.
- **B2 Enumerate consumers of everything you touch.** For any shared contract, function, wire-format, table, or component the change modifies, list its CURRENT consumers and state the compatibility approach for each.
- **B3 Resolve every choice to one option.** No "A or B", "either/or", or "TBD" survives into a ready spec. Each is decided, with the reason.
- **B4 Pin the exact scope set.** Enumerate the concrete items the slice ships (the exact list), never "whatever the registry/config/data happens to contain."
- **B5 State delivery decomposition intent.** One PR, or a required stack — say which, and the order.
- **B6 Adversarial pass (independent).** A second reviewer whose only job is: *"find where this spec contradicts the real code/schema — assume there is a hidden hop, an unlisted consumer, or an unhandled empty/edge/error case."* Single-pass self-review is not enough.
- **B7 Required outputs of the probe:**
  - **Decisions register** — every decision made + option taken (sign-off reviews *decisions*, not prose).
  - **Fixture-backed acceptance criteria** — concrete input state → expected output, computed against the REAL model. These double as the automated tests and make end-validation mechanical. Include empty / zero / error cases.
  - **Test plan** that keeps the coverage ratchet green — which layers, and contract tests for SQL-heavy paths.
  - **Docs + changelog targets.**
- **B8 Loop.** Every question the probe raises goes to the human; answer; re-probe. Repeat until a probe pass surfaces nothing new. Only then is Phase B done.

## Phase C — Sign-offs
- **C1 Requestor confirmation** — the interview+probe summary is read back; the requestor confirms it is correct ⇒ `ready-to-build`.
- **C2 Product GO** — a product owner decides: does this move the product toward its goals, or does it only solve a narrow edge case and add complexity/bloat? ⇒ `approved` (only now may autonomous build start). *Optional:* a cheap coherence pre-screen BEFORE Phase A, so you don't fully spec features you'll reject.

---

## The bar (how we know a spec passed)
A fresh builder given ONLY this spec — no author, no thread, no tribal memory — builds, tests, and documents it with **zero human decisions and zero silent assumptions**, and the end functional check is mechanical against the fixture ACs. If the builder has to ask or assume, Phase B was incomplete: that gap is a defect, folded back into this checklist.

## Why v2 differs from v1 (generalized lessons, not feature facts)
- v1 gated on "the design has no open questions" but let a *review* satisfy it. v2 requires an *executed* dry-run (B1) — because a value can look modelled and not be (wrong hop-count, blob, derived) in a way only writing the query reveals.
- v1 said "keep the touched contract equivalent" without forcing you to list who depends on it (B2).
- v1 tolerated "A or B" and "the exact set is whatever the data contains" (B3, B4).
- v1 had no independent adversarial pass (B6) and no fixture-backed ACs (B7) — so a subtly-wrong result could ship green and pass a casual human glance.
