---
type: reference
---

# Architecture Guidance Review — September 2026

!!! warning "Proposal for review — @Wim / @Taeke please comment"
    This is a draft analysis, following the pattern of
    [`docs-gap-audit.md`](../docs-gap-audit.md) and the
    [UX](../ux/assessment.md) / [security](../security/maintenance-audit-2026-06.md) assessments:
    a read-only audit first, remediation second. Nothing here is adopted until an architect ratifies
    it. The proposed guidance itself lives in
    [`decision-principles.md`](decision-principles.md), kept separate so it can be read on its own.

**Method.** Read every file under `docs/architecture/`, the subdirectory `CLAUDE.md` files, the
`docs/process/` DoR pipeline docs, and `docs/risk-scoring/`. Read the full body + comment trail of
all 22 open `state:awaiting-design` issues and all 14 open `state:decompose` issues. Searched closed
issues/PRs for precedent on five specific leads (business-role-as-matrix-row, the context plugin
catalogue, the risk-scoring plugin tier, decompose-threshold precedent, and buried architectural
rulings in comment threads). No files were changed as part of the audit itself.

**Headline finding, stated up front because it reframes everything below:** most of the
`awaiting-design` backlog is not stuck on *missing* guidance. **17 of the 22** `awaiting-design`
issues (#749, #750, #752, #757, #762, #764, #768, #769, #772, #776, #779, #783, #784, #788, #789,
#790, #796) were auto-routed there by the DoR spec-agent on **2026-07-28, 12:44–12:50 UTC**, each
with a templated comment that already lists 2–3 concrete options. **None have a follow-up reply of
any kind** — not even a rejection. This is an unanswered ratification queue, not an open architecture
question. The single highest-leverage fix available is a process one — a batch "design triage" pass,
or a "ratify by silence after N days unless objected" rule — and it is **not** something a sharper
architecture document can fix on its own. See [Impact estimate](#impact-estimate) for how this
changes the numbers.

That said, the review also found genuine content gaps, one real doc-vs-doc contradiction, and one
doc-vs-precedent recurrence worth fixing regardless of the process question. Those are below.

---

## 1. Contradictions found

### 1.1 Doc-vs-doc: two incompatible risk-scoring plugin architectures for the same slot
`docs/architecture/risk-scoring-plugins.md` proposes an **in-tree Node.js plugin tier** (JS modules
registered like the context-plugin registry, reusing its `reconcile()`), explicitly unbuilt — issue
#672 is its tracking issue, and its own status header says "Proposal for review — not yet
implemented." `docs/risk-scoring/plugin-architecture.md` describes a **different, incompatible**
architecture for what reads as the same conceptual slot — Python `ScoringPlugin`/`DiscoveryPlugin`
ABCs, YAML "classifier packs," a `plugins/community/` filesystem layout, an `idrisk` CLI — aimed at a
third-party/open-source contributor ecosystem. It carries **no status header** distinguishing it as
speculative, unlike every other design doc in the repo (`context-redesign.md`,
`assignment-model-redesign.md`, `effective-access-engine.md`, and `risk-scoring-plugins.md` itself
all have one). It also directly contradicts `context-redesign.md §9`'s stated non-goal — "A
user-facing plugin SDK — plugins remain in-tree code modules until there's a clear case for
third-party plugins" — since its entire premise *is* third-party plugins.

Investigation confirmed neither document is shipped, and #672's comment trail never references
`plugin-architecture.md` at all — the two were developed independently and never reconciled. **This
is a live hazard for the A5 "architecture fit" gate**: an AI probe asking "does a new risk-scoring
capability fit the existing architecture?" would get two contradictory answers depending which doc it
happened to read. Recommend: add a status header to `plugin-architecture.md` disambiguating it as a
long-horizon product-vision doc, not a near-term implementation target, and cross-link both documents
to each other so the conflict is visible rather than latent. *(Done as part of this review — see
§2.5 below.)*

### 1.2 Doc-vs-precedent: "fix at the source" is written down but has no structural check
CLAUDE.md's own cautionary example for "fix at the source, not the surface" is the matrix's old
client-side "owner as its own row" simulation, fixed in PR #446 by giving ownership a real
`GroupOwnership` resource. That fix is exactly six weeks old (by commit history) when the **same
defect shape recurred**: issue #937 shows `BusinessRole` rows leaking into the matrix's resource axis
for the identical reason — a resource-listing query with no `resourceType` exclusion. The DoR bot's
own certification comment on #937 draws the parallel explicitly, citing `resources.js:82-88`'s
existing `BusinessRole` exclusion as "an exact precedent for the fix."

The principle exists in prose (CLAUDE.md) but nothing turns it into a repeatable check — there's no
"every new resource-axis query must state which resourceTypes it excludes" item on any checklist.
Recommend promoting it to a named checklist item (`decision-principles.md` §A1 does this) rather than
leaving it as a narrative example a future author has to remember to apply.

### 1.3 Doc-vs-precedent, but resolved on inspection: #749 does not actually contradict the Style Guide
The security/maintenance audit's own H1 finding describes #749 as fixing UI that contradicts "the
documented 'blue is the single interactive accent' rule." On inspection, `docs/contributing/
style-guide.md §1` does not say that — it defines **two** intentional accent roles (green = brand,
blue = interactive) and forbids only introducing a **third** (no indigo/emerald/teal). TaekeK's
comment on #749 ("the Dashboard's lime accent is intentional brand ... isn't the right direction
without a product/brand decision") is the Style Guide reasserting itself correctly, not a new
architectural ruling that contradicts it. **The audit finding's paraphrase drifted from what the
Style Guide actually says**, and issue #749 inherited the drift — it's currently scoped as "demote
lime/indigo," when the buildable slice (per the Style Guide as written) is "demote indigo only."
Recommend re-scoping #749's title/body before it's picked up again; no doc change needed, the Style
Guide is already correct.

### 1.4 Doc-vs-doc drift, already caught and fixed — cited for completeness
`context-redesign.md §4.2`'s plugin catalogue undercounted (documented 5, two of which never
shipped, one misnamed) against the actual 10 registered plugins. This was flagged by
`docs/docs-gap-audit.md` (A4) and fixed by PR #805. No outstanding action — included here because it
is the clearest evidence in this repo that **plugin catalogues drift the moment a new plugin ships
without a doc-update habit**, which is relevant to how much weight to put on any catalogue-style doc
going forward (treat counts in `context-redesign.md` as illustrative, not authoritative — the source
of truth is `app/api/src/contexts/plugins/registry.js`).

### 1.5 Cross-doc pattern fragmentation (not a contradiction, but adjacent)
Three different design docs each solve "which rows came from an automated process vs. a human, and
does a re-run clobber the human's edits" with three different, non-interoperating vocabularies:
Contexts' `synced`/`generated`/`manual` variant axis (shipped), `risk-scoring-plugins.md`'s
finding/override model (proposed), and `rule-mining-discussion.md`'s
proposed/approved/implemented lifecycle (exploratory). None reference each other. This isn't wrong in
any one document, but it means the next author solving this exact problem (candidates: #672, #676,
and a hypothetical future BloodHound-derived-finding feature) has no single pattern to reach for. See
`decision-principles.md` §A4.

---

## 2. Proposed architecture document diff

There is **no single canonical "architecture principles" document today** — that absence is itself a
finding. The only place architecture-fit criteria are written down at all is one table cell in
`docs/process/definition-of-ready.md` (four words: *"registry vs engine, additive vs
mutate-shared-contract, matview vs query-time, migrations"*), plus CLAUDE.md's four process-level
"Coding Principles" (reuse-before-creating, fix-at-source, coverage-never-down, keep-files-small),
which govern *how* to build, not *what shape* to build. The 30+ files under `docs/architecture/` are
each a single-feature design spec — rich in reasoning, but none of them is a cross-cutting reference,
and nothing points from the DoR gate to any of them.

The diff below is against the two places that currently function as "the architecture document,"
plus one new file that becomes the real one.

### 2.1 New file: `docs/architecture/decision-principles.md`
The sharpened guidance itself — 13 principles, each phrased as a testable question with a
🟢 high-confidence / 🟡 needs-human-review label and 1–2 cited example issues. See the file directly;
summarized by section:

- **A. Data model & type shape** — governance-row exclusion (A1, 🟢), extendedAttributes vs. column
  promotion (A2, 🟢), closed enum vs. free-form type (A3, 🟢), reuse the variant+reconciliation
  pattern (A4, 🟡).
- **B. Compute strategy** — materialize vs. compute-on-demand (B1, 🟡), never silently truncate (B2,
  🟢), deterministic vs. LLM for anything persisted (B3, 🟢).
- **C. Extensibility** — default to the registry/plugin pattern (C1, 🟢), with the risk-scoring
  contradiction flagged inline.
- **D. UI/design-system boundary** — this is a *routing* correction, not new architecture content: it
  says which of these questions belong to the Designer/Style-Guide track instead of the Architect
  track (D1–D3, mixed 🟢/🟡).
- **E. Sizing & decomposition** — a first-draft rubric for the single largest gap found (all 🟡,
  expect revision after a few uses).
- **F. Explicitly out of scope** — names the security/hardening cluster and says why it doesn't
  belong under "architecture fit" at all.

### 2.2 `docs/process/definition-of-ready.md` — sharpen the A5 gate criteria
```diff
- | **Architect / tech lead** | Technical approach; coherence of the codebase | registry vs engine, additive vs mutate-shared-contract, matview vs query-time, migrations |
+ | **Architect / tech lead** | Technical approach; coherence of the codebase | registry vs engine, additive vs mutate-shared-contract, matview vs query-time, migrations, closed-enum vs free-form type axis, deterministic vs LLM for persisted output — see [`decision-principles.md`](../architecture/decision-principles.md) for the full testable checklist and its confidence ratings |
```
*(Applied as an actual edit alongside this doc — see the diff on this branch.)* This is the one-line
change that gives the spec-agent's A5 probe something to actually read instead of four words with no
worked criteria behind them.

### 2.3 `CLAUDE.md` — one pointer, not new prose
Added under "Coding Principles," matching the existing bold-lead-in style of the other four
principles, kept to a few lines since this file loads into every session:

```diff
+ > **Architecture fit is a checklist, not a vibe.** When a feature request raises "does this fit
+ > the existing architecture" — a new resourceType, a new plugin, a materialize-vs-query-time
+ > choice — check it against [`docs/architecture/decision-principles.md`](docs/architecture/decision-principles.md)
+ > before treating it as an open question for a human. Each entry is a testable question with a
+ > confidence rating and cited examples; 🟢 entries are safe to apply directly, 🟡 entries should
+ > still go to the architect the first few times.
```

### 2.4 Enforcement table — new row
The existing CLAUDE.md table distinguishes hard CI gates from reviewer judgement. Architecture fit is
squarely reviewer judgement — no gate should be invented for it — but it deserves a row so that's
explicit rather than implied by omission:

```diff
+ | **Architecture fit** (registry vs special-case, closed vs free-form types, matview vs query-time, sizing/decomposition) | Reviewer/architect judgement per `docs/architecture/decision-principles.md` — no automated gate. The 🟢/🟡 confidence labels are the only signal of how settled an answer is. |
```

### 2.5 `docs/risk-scoring/plugin-architecture.md` — status header (applied)
Added the missing status header every other design doc in the repo carries, and a cross-link
resolving §1.1 above:

```diff
+ !!! danger "Status: speculative long-horizon vision — not the risk-scoring plugin tier being built"
+     This describes a hypothetical **third-party/open-source** contributor ecosystem (Python ABCs,
+     YAML classifier packs, a CLI). It is unrelated to and inconsistent with
+     [`docs/architecture/risk-scoring-plugins.md`](../architecture/risk-scoring-plugins.md) — the
+     actual (also unbuilt) in-tree Node.js plugin-tier proposal tracked by issue #672 — and
+     conflicts with `context-redesign.md`'s stated non-goal of a third-party plugin SDK. Do not
+     treat this page as architecture guidance until an architect reconciles the two.
```

### 2.6 `mkdocs.yml` — nav entries
Both new pages registered under the existing "Quality & audits" and "Design archive" sections,
matching how `docs-gap-audit.md` and `risk-scoring-plugins.md` are already listed.

---

## 3. Impact estimate

Of the **36** open `awaiting-design` + `decompose` issues surveyed:

**17 are blocked on process, not content** (#749, #750, #752, #757, #762, #764, #768, #769, #772,
#776, #779, #783, #784, #788, #789, #790, #796) — the spec-agent already proposed answers; nobody
ratified or rejected them. A sharper architecture document has **near-zero marginal effect** on this
group by itself. It has a *secondary* effect on a few of them (see below) where the proposed answer
*is* now also a written 🟢 principle, meaning the next probe could self-certify instead of waiting for
a human reply at all — but the 17-item backlog is fundamentally a process gap. **Recommend a
companion process fix** (batch design-triage pass, or a time-boxed "ratify by silence unless
objected" rule) as at least as important as anything in this document.

**Directly resolvable by the proposed `decision-principles.md` content** (the AI could self-certify
on next probe without waiting on a human), roughly **6–9 of the 36**:

| Issue | Principle applied | Confidence |
|---|---|---|
| #676 | C1 — registry/plugin default | 🟢 |
| #754 | D1(Q1) — zero importers, no design gate needed | 🟢 (factual check) |
| #776 | A1 — already answered by Wim in-thread, citing fix-at-source | 🟢 |
| #921 | A3 — closed/free-form axis + AzureRM precedent, matches Wim's own redirect | 🟢 |
| #939 | A3 — closed-enum extension is a known, safe operation | 🟢 |
| #843 | E — its own bundle-vs-boundary litmus test, promoted to a citable doc | 🟢 (definitional part only; sizing still needs a human) |
| #788, #796 | B2 — rules out "cap and lose data," narrows the option space | 🟡 |
| #207 (slice B) | D3 — localStorage default | 🟡 |

**Genuinely need a human, and this document doesn't change that** — roughly **10–13 of the 36**,
spread across three *different* hats the current `state:awaiting-design` label conflates into one:

- **Designer/Style-Guide, not Architect:** #750, #757, #762, #764, #768, #769, #772 — these are form
  questions (`definition-of-ready.md`'s own role table already says so) that need a Style-Guide
  decision, not an architecture one. Recommend re-routing these to reference
  `docs/contributing/style-guide.md` explicitly and, longer-term, considering whether
  `state:awaiting-design` should split into two labels matching the two hats it currently merges.
- **Security/product policy, not Architecture:** #779, #780, #782, #783, #784, #785 — see
  `decision-principles.md` §F.
- **Genuine novel judgment calls with no usable precedent found:** #931 (new filter-condition kind),
  #837 (buy-vs-build an external workflow engine — a real licensing/dependency tradeoff), #752
  (build-vs-adopt a UI dependency, 🟡 default offered but not a confident answer), #934 (already
  resolved via requestor answer per the survey — dev-authored reports only, phase 2 deferred),
  #837/#839 (blocked on sequencing, not a design question — see the decompose-routing note in
  `decision-principles.md` §E).

**Umbrella issues** (#787, #777, #723, #699) are decompose-by-design or intentionally parked and
aren't "resolved" by any document — they're tracking issues for already-triaged backlogs.

**Net honest estimate:** roughly a **quarter** of the current backlog (6–9 issues) becomes directly
self-certifiable by the AI once this document is ratified. A further large fraction (17 issues) needs
a five-minute human ratification pass that has nothing to do with document content. The remainder
needs a human, but this review at least tells you *which* human (architect vs. designer vs. security
owner vs. product board) instead of leaving everything addressed to "the architect."

---

## 4. Backlog restructuring proposals

### 4.1 Merges — small related items into one build item

- **#757 (border-radius scale) + #762 (semantic design-token layer).** Radius is a token category;
  standing up `index.css` tokens covers both in one pass. Building them separately means two
  functional-test environments clicking through the same visual surfaces twice.
- **#768 (Apply/Save verb rework) + #769 (rotated-matrix reduced-mode signal) + #776 (unify "governed"
  definition in the rotated view).** All three are findings against the **same component**
  (`RotatedMatrixView` / the matrix save flow) from the **same audit cluster** (C-03, H-09, H-10).
  Currently three separate awaiting-design tickets that would each need their own review pass on the
  same screen. Recommend one "Rotated matrix UX pass" issue.
- **#788 + #796.** Already explicitly cross-referenced by the requestor ("align with #788 so we don't
  ship two pagination idioms") — these should not be built as independent parallel slices. Either
  merge, or make #796 formally block-on / consume #788's decision rather than sitting in the same
  `awaiting-design` state as an unrelated peer.
- *(Positive precedent, no action needed)*: **#779** already bundles three audit sub-findings
  (L-1/L-2/L-3, all PowerShell-worker hardening) into one issue — cite this as the model other
  audit-derived clusters should follow.

### 4.2 Missing epic-level groupings

- **Component-consolidation epic** — #750 (Button), #752 (Modal), #754 (Section/StatCard), #764
  (detail-page family unification) are four facets of one initiative (UX audit H-01/H-02: "no shared
  component layer," "two products in one"). Each is currently an independently-stalled ticket
  re-asking a slice of the same underlying component-API-shape question. Recommend one epic that
  settles the component API shape once (Button variants, Modal API, Section/StatCard API) with #764
  as the epic's capstone consumer, rather than four parallel `awaiting-design` tickets.
- **Matrix scale/perf epic** — #788 (cursor pagination), #789 (column virtualization), #790
  (incremental matview refresh), #796 (endpoint pagination) are four faces of "handle a very large
  tenant's matrix." Currently four independent tickets, each partially blocked on conventions the
  others would set. Recommend a shared epic that fixes the pagination convention once (#788) and
  treats the rest as sequenced consumers.
- **BloodHound integration epic** — #939 (crawler/ingestion) → #940 (attack-path risk plugin) → #941
  (reverse feed/export) are three phases of one integration story, already loosely sequenced by
  content but not structurally linked. Recommend a parent epic issue with these as sub-issues (the
  repo's GitHub sub-issue feature is already used elsewhere per the DoR docs), so the dependency is
  visible on the board instead of implied by title similarity.
- **Deployment-hardening epic** — #779, #780, #782, #783, #784, #785, and umbrella #787. Each ships
  as its own small, subsystem-disjoint PR (don't literally merge these — combining PowerShell IEX
  hardening with Postgres TLS with container limits in one PR would blow past the one-issue-per-branch
  and file-size/complexity discipline), but grouping them under a visible parent epic gives the
  Product Board one initiative to prioritize instead of seven scattered low-priority tickets that
  individually never clear the bar for attention. Note per §F above: this cluster is a security-policy
  epic, not an architecture one — route it to a policy owner, not "the architect."

### 4.3 Cross-item contradictions in the backlog

- **#749 as currently scoped contradicts the Style Guide it's meant to enforce** (detailed in §1.3).
  Needs re-scoping to "demote indigo only" before it's buildable — filing it as-is and building it
  literally would violate `style-guide.md §1`'s two-role color system.
- **#843 (Logical Applications) and #937 (Business Roles excluded from matrix rows) are each
  individually reasonable but risk drifting out of sync** if built as two independent point-fixes.
  Both are instances of the *same* underlying rule (§1.2 / `decision-principles.md` A1: exclude
  synthetic/governance resourceTypes from general resource-axis queries). Recommend #843's
  implementation explicitly extend the same exclusion mechanism #937 introduces (or vice versa,
  whichever ships first), rather than each adding its own ad hoc filter — which is exactly how #937
  itself recurred after #446 fixed the same problem for `GroupOwnership`.
- **#931 and #680 (new matrix subject-filtering UI) vs. #788/#789 (matrix subject-axis pagination and
  virtualization)** are not yet a live contradiction, but both pairs touch the same subject axis's
  data-fetch contract concurrently. If #931/#680 ship UI that assumes a fully-loaded, unbounded
  subject list while #788 simultaneously moves the grid to keyset pagination, whichever ships second
  risks silently breaking the other's assumption. Flagging now so the two pairs are sequenced or
  explicitly agree on one fetch contract, rather than discovering the conflict in a later PR.

---

## 5. What this review is not confident about

Stated explicitly per the task's own instruction to flag uncertainty rather than guess:

- The **E. Sizing & decomposition** rubric in `decision-principles.md` is the most speculative content
  in this whole review — synthesized from patterns across 12 issues, with no existing precedent to
  lean on. Expect it to need real revision after a handful of live uses.
- **B1 (materialize vs. compute-on-demand)** and **A4 (reuse the variant/reconciliation pattern)** are
  well-evidenced syntheses across multiple docs, but nobody has ratified them as forward-looking
  rules — they're inferences from consistent past behavior, not quoted decisions.
- The **17-issue "just needs ratification" count** rests on there being no comment after the
  templated proposal; it's possible some of those 17 have context (a Slack thread, a verbal
  conversation) this review couldn't see that would change the answer. Worth a quick human sanity
  check before treating the whole batch as ready to close in one pass.
- This review did not attempt to assess the **security/hardening cluster's actual content** (§F) —
  only that it's mis-routed as an architecture question. What the right rotation cadence, rate-limit
  layer, or vault posture *should be* is outside this review's scope and needs its own pass by
  whoever owns that policy.
