# Definition of Ready v3.2 — the "ready-to-build" process

**Purpose.** Produce a spec complete enough that building, testing and documenting run with **zero *functional* human decisions and zero silent *functional* assumptions** — while spending the fewest possible **human round-trips** getting there. Non-functional decisions (architecture, design/UX, product fit) are **routed to the role that owns them**, *batched*, and resolved in as few interactions as possible. *Form* is expected to need a **feedback loop**, because taste is a see-it reaction that can't be fully pre-specified.

**The realistic bar.** "One perfect spec → build once" is reachable for **function**, not **form**. Front-load every *functional* decision; route every *architectural / design / product* decision to its owner; keep round-trips minimal; treat post-build feedback as a normal, cheap loop.

---

## The process at a glance

```mermaid
flowchart TD
  classDef req fill:#dbeafe,stroke:#3b82f6,color:#0b1f4d
  classDef ai fill:#ede9fe,stroke:#7c3aed,color:#2a0f52
  classDef arch fill:#dcfce7,stroke:#16a34a,color:#0a2e14
  classDef po fill:#ffe4e6,stroke:#e11d48,color:#4a0a1e

  start([Feature idea]):::req --> pre{PO pre-screen}:::po
  pre -->|no| drop([Park / drop]):::po
  pre -->|yes| intv[Phase A — Intent interview<br/>ONE sitting · GENERATIVE · scope battery · time-travel]:::ai
  intv --> probe[Phase B — probe · adversarial · CI dry-run]:::ai
  probe -->|re-probe until nothing new — AI only, no human| probe
  probe --> collate[Collate ONCE: decisions to ratify +<br/>blocking questions grouped by role]:::ai
  collate --> packet[[Single consolidated packet<br/>batched per role · one packet if one person]]:::ai
  packet --> c1[Requestor: answer + confirm]:::req
  packet --> c2[Architect: answer + sign off]:::arch
  packet --> c3[Designer confirm + PO GO]:::po
  c1 --> rtb([READY-TO-BUILD + APPROVED]):::po
  c2 --> rtb
  c3 --> rtb
  rtb --> build[Autonomous build on SK3<br/>implement · fixture-AC tests · SEED validation data · docs · PR · CI green · deploy]:::ai
  build --> bd([BUILD-DONE · report ACs + green run]):::ai
  bd --> val{Requestor functional validation<br/>vs ACs + time-travel criteria}:::req
  val -->|disappointed / form| fb[Feedback = new intent]:::req
  fb --> intv
  val -->|happy| appr[Approve PR → merge → Shipped]:::req
```

## Roles (lanes)

One human may wear several hats. The point is not headcount; it's that **each question is answered by the right *hat*, a hat with no open question is not consulted, and a hat is touched as few times as possible.**

| Role | Owns | Answers questions about |
|------|------|-------------------------|
| **Requestor** | Intent + functional decisions; scope; the time-travel success/failure criteria | what it should do, for whom, how *complete/general* it should be, "just another attribute vs. a new surface" |
| **Architect / tech lead** | Technical approach; coherence of the codebase | registry vs engine, additive vs mutate-shared-contract, matview vs query-time, migrations |
| **Designer** | Form: interaction model, information architecture | how it looks/feels, integrate with an existing control or stand alone |
| **Product Owner** | Desirability / product coherence — the GO | does this move the product forward or just add complexity/bloat |
| **Builder (AI)** | Runs Phases A/B, then builds/tests/documents autonomously | — |

## Minimise human round-trips — batch, don't ping-pong

Every *return* to a human costs real time. Routing to the right role is worthless if it produces *more* interactions. So:

- **Efficiency = few round-trips, not few questions.** This discipline limits how often you *return* to a human — it does **not** thin out the first interview. A *complete* spec reached in two touchpoints beats a *thin* one reached in two touchpoints. Ask freely in the one sitting; batch your *returns*.
- **Exhaust the AI-resolvable work before touching any human.** The Phase-B probe, adversarial passes and CI dry-run are an **AI-internal loop** — never a reason to go back to a person.
- **Prefer a proposed decision over a question.** If the AI can pick a defensible default from the code/model, record it for **bulk ratification**. Only escalate as a **blocking question** what genuinely needs a human's judgment. *(But scope-ambition is the requestor's call — surface it, don't default it away; see A8.)*
- **Batch by role, ask once.** Group all blocking questions + decisions-to-ratify by owning role in a **single async packet**; fold a role's questions into its **sign-off**.
- **One person, one packet.** When one human wears several hats, present a single consolidated packet, not separate meetings.
- **Target: two human touchpoints** — the Phase-A interview, and one consolidated sign-off/GO packet.

**Optionality rule.** Only pose a question to a role if a genuine question is *owned* by that role. Skip hats with no open questions.

---

## Phase A — Intent interview (GENERATIVE, one sitting)
**Generative, not extractive.** Do not just transcribe the opening description — actively help the requestor find the *best and most complete* version of the feature. An open brain-dump alone tends to **under-scope**; start with the open description, then run the **scope-elicitation battery** below as explicit choices. All of this is touchpoint #1 — no round-trips.

- **A1 Problem & value** — a user/governance question, not a solution; who for; why now.
- **A2 Scope boundaries** — what it deliberately does NOT do.
- **A3 Backlog context** — related/precondition/duplicate issues; weighed against the whole backlog.
- **A4 External dependencies** — known and secured, or N/A.
- **A5 Architecture fit** — fits the existing architecture, or *raises* an architectural question → tag for the architect, don't resolve with the requestor.
- **A6 Documentation needs.**
- **A7 Time-travel pre-mortem (Rob's question).** *"We fast-forward to the moment I show you the finished feature. You're delighted because…? You're disappointed because…?"* The "disappointed because" answers become explicit accept/reject criteria — where *form* preferences surface before code.
- **A8 Scope-elicitation battery (ask as explicit choices).** These dimensions most change what gets built; surface each and let the requestor include or *consciously* defer it — never default it away silently:
  - **Generality** — a specific case, or a general capability? (Name the first case as the example, but pin the scope the requestor actually wants — build the general version if that's the intent.)
  - **Operation completeness** — beyond the minimal operation, the full set? (e.g. existence → count/threshold → range; view → edit; single → bulk.)
  - **Symmetry & variants** — inverse directions, related entities, adjacent cases the same mechanism naturally covers.
  - **Surface / reach** — one page, or everywhere the pattern exists?
  - **Adjacent / phase-2 opportunity** — a natural bigger or reusable version (persist / save / reuse) worth acknowledging, even if deferred to a follow-up.
  - **Driver & priority** — what's pushing it now (frames the issue and the cut line).

**Pin the chosen scope explicitly** (feeds B4). A minimal cut is fine — but as a *conscious choice*, never a silent default.

## Phase B — Build-readiness probe (AI-internal; no human until it's exhausted)
Intent is fixed. **Draft the actual implementation against the real code and schema — far enough to hit the walls.** A dry-run, not a re-read.
- **B1 Trace every value to its real storage** — write the real query; multi-hop → write the join path; not modelled as assumed → raise it.
- **B2 Enumerate consumers** of every shared contract/function/wire-format/table/component touched.
- **B3 Resolve every choice to one option** — no "A or B", no "TBD". Includes **UX-shaping words** ("alongside / integrated / inline").
- **B4 Pin the exact scope set** — the concrete list, matching the scope chosen in A8.
- **B5 Delivery decomposition** — one PR or a required stack, and the order.
- **B6 Adversarial pass (independent)** — *"find where this spec contradicts the real code/schema — hidden hop, unlisted consumer, unhandled empty/edge case, ambiguous UX word."*
- **B7 Dry-run the CI / Definition of Done** (appendix) — not just the schema.
- **B8 Classify each open item** as a **proposed decision** (ratify in bulk) or a **blocking question**; tag each by owning role.
- **B9 Outputs:** **decisions register** (decision + reason + owning role, ratify/blocking) · **fixture-backed ACs** (input → expected output vs the REAL model; incl. empty/zero/error) · **validation-data plan** (what representative data — instances *with* and *without* the condition — must be seeded so the requestor can actually exercise the feature) · **form artifact** for UI · **test plan** · **docs + changelog targets.**
- **B10 Loop** the probe + adversarial pass until a pass surfaces nothing new — all AI, no human.

## Phase C — Consolidated sign-off (batched; one packet if one person)
Present the collated output as a **single packet**, batched per role. Answering a role's questions and taking its sign-off are the **same touch**.
- **C1 Requestor** — answers batched functional questions, confirms the functional summary + scope + time-travel criteria ⇒ *functional* `ready-to-build`.
- **C2 Architect** — answers batched architectural questions, signs off the technical approach ⇒ *technical* ready.
- **C3 Product Owner** — GO ⇒ `approved`. Only now may autonomous build start. (Designer confirms the form artifact here too.)

## Phase D — Build, validate, and the feedback loop (first-class)
- **D1 Autonomous build** on SK3: implement, run the fixture-AC tests, **seed the representative validation data** (instances with and without the condition, per the B9 plan) so the feature can actually be exercised, docs, changelog, PR, CI green, deploy ⇒ `build-done`. The build-done handoff **reports the acceptance criteria and their green test run** (the fixture-AC contract test file + result), so real testing is visible and distinct from manual validation.
- **D2 Functional validation** by the requestor against the fixture ACs **and the time-travel criteria** — check the numbers and the "disappointed because" list, using the seeded data.
- **D3 Feedback loop.** Disappointment (usually *form*, sometimes *missed scope*) is captured as **new intent** and re-enters at Phase A. Expected and cheap. Happy ⇒ approve PR ⇒ merge.

---

## Appendix — Definition of Done the probe must design against
- **Coverage** — aggregate + per-file ratchet (only up) + diff-coverage. New code ships with tests.
- **File size** — >1000 lines must split; >600 is a smell.
- **Complexity** — per-unit cyclomatic + cognitive ratchets; new/touched units under the per-language threshold.
- **Duplication** — jscpd gate; reuse before creating.
- **Contract tests** — real PostgreSQL; each test **DELETEs its own rows** (never DROP/TRUNCATE, never assume a clean shared DB).
- **OpenAPI** — a new router must be documented in `openapi.yaml` or allowlisted.
- **UI** — dark mode from the start; WCAG AA contrast (no bare `text-*-300/400`); real accessible names; no native `alert/confirm/prompt`; `@ui/` alias (no relative traversal); nothing crawler-specific under `app/ui/`.
- **Changelog** — a fragment under `changes/` for functional changes (never edit `CHANGES.md`; docs-only needs none).
- **Merge** — 1 approval; never admin-merge.

**Baseline precondition.** Verify `main` (and the target Sidekick) is green *before* starting. A pre-existing failure is repo debt, not a feature defect — fix it as a disclosed separate chore.

## The bar
A fresh builder given ONLY the spec builds, tests and documents it with **zero functional decisions and zero silent functional assumptions**, reached with **≈two human touchpoints** — and the spec is the **complete** version the requestor actually wanted, not the floor. End-validation is mechanical against the fixture ACs + time-travel criteria, using seeded data. Residual *form* gaps go through the D3 feedback loop.

## Version history (generalized lessons)
- **v1 → v2:** "no open design questions" was satisfiable by *review*; v2 requires an *executed* build-readiness probe. Added consumer-enumeration, no-A-or-B, pinned scope, adversarial pass, fixture ACs.
- **v2 → v3:** v2 collapsed a product team into "the requestor." Added role-routing, the time-travel pre-mortem, a form artifact for UI, CI/DoD dry-run, and a first-class feedback loop.
- **v3 → v3.1:** role-routing without batching risks *human ping-pong*. Added the round-trip discipline — exhaust AI work first, prefer proposed-decisions, batch per role, one packet, ≈two touchpoints.
- **v3.1 → v3.2:** the efficiency discipline *starved the interview* — a from-scratch run built a thin feature (2 edges, existence-only) because Phase A was extractive. Clarified **efficiency = few round-trips, not few questions**; made Phase A **generative** with a **scope-elicitation battery** (generality / operation-completeness / symmetry / surface / phase-2 / driver); required **validation-data seeding** on the Sidekick so the requestor can actually test; and **AC-result transparency** at build-done.
