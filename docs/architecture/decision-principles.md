---
type: reference
---

# Architecture decision principles

!!! warning "Proposal for review — not yet adopted"
    This page is a draft, written to sharpen the DoR spec-agent's **A5 "Architecture fit"** gate
    (today just four words in [`definition-of-ready.md`](../process/definition-of-ready.md#phase-a--intent-interview-generative-one-sitting):
    *"registry vs engine, additive vs mutate-shared-contract, matview vs query-time, migrations"*).
    Nothing here is enforced until an architect (Wim / Taeke) ratifies it. See
    [`architecture-guidance-review-2026-09.md`](architecture-guidance-review-2026-09.md) for the
    analysis this page came from — the contradictions found, the issues cited as evidence, and the
    confidence rating behind each entry below.

**Purpose.** Every principle below is phrased as a **testable question** the DoR spec-agent (or a
human) can run against a specific feature request, with a **confidence label**:

- 🟢 **High confidence** — directly derived from a pattern applied consistently 2+ times in shipped
  code/docs, or from a decision an architect already made and is quoted verbatim.
- 🟡 **Needs human review** — a synthesis across multiple precedents that nobody has explicitly
  ratified as a forward-looking rule yet. Cite it, but still route to the architect the first few
  times it's used, and strike this label once it's been applied without objection.

Each entry names the issues it was built from, so a future correction can go straight to the
evidence instead of re-litigating from scratch.

---

## A. Data model & type shape

### A1. Governance/relationship rows must not leak into a general resource listing 🟢
**Q:** Does this feature add or touch a query that lists "all resources" / "all resource rows"
without a `resourceType` filter? If so, does it need to exclude synthetic/governance resourceTypes
(`GroupOwnership`, `BusinessRole`, `AppRole`, `ServicePrincipalOwnership`, …) the way
`resources.js:82-88` already does for `BusinessRole`?

**Why:** A relationship or governance construct (ownership, a business-role bundle) must be modeled
as a real `Resource` + `ResourceAssignment`, never faked as a UI-only row — that's the origin of
CLAUDE.md's "Fix at the source" principle (PR #446, the matrix's old client-side "owner as its own
row" simulation). But the fix landed as *one query's* exclusion list, not a structural rule — six
weeks later the same defect shape recurred in a different query (issue #937: `BusinessRole` rows
leaking into the matrix's resource axis) because nothing checked "does every new resource-axis
query state which resourceTypes it excludes?" Treat this question as mandatory on any new/changed
resource-axis query, not just the matrix's.

**Evidence:** PR #446 (origin), issue #937 (recurrence), `docs/architecture/matrix.md` § *Owner rows
are their own resource*.

### A2. `extendedAttributes` JSON vs. a first-class column 🟢
**Q:** Is the new attribute read in a hot/inner loop (per-row during resolution, rendering, or
sorting) **and** does it need a database index? Both yes → first-class column. Otherwise →
`extendedAttributes` JSON.

**Why:** This is already a stated, numeric decision rule — just buried in one design doc instead of
being general guidance. `effective-access-engine.md §15.1` promotes `effect`/`propagationScope` to
real columns because they're read in the innermost resolution loop and JSONB can't be cleanly
indexed; `§15.8` keeps `propagates` in JSONB because the traversal only reads a bounded (~20-hop)
window, with an explicit threshold for revisiting that choice: *"when any hierarchy in production
exceeds 500 nodes with >10% of edges having `propagates=false`, or when a deny-bearing source is
scoped — whichever comes first."*

**Evidence:** `docs/architecture/effective-access-engine.md §15.1, §15.8, §15.9`.

### A3. Closed enum vs. free-form type 🟢
**Q:** Does the new value describe a **universal, cross-source fact about *how*** access is held
(like `assignmentType`) or ***what kind* of relationship** exists between two resources (like
`relationshipType`)? → a **closed enum**, extended only via a coordinated migration + the existing
static-scan guard (`assignmentTypes.guard.test.js`'s pattern). Does it instead describe a
**source/domain-specific *what*** (a system-specific resource kind, e.g. a new BloodHound edge
type)? → `resourceType` (free text) or `extendedAttributes`.

**Why:** `assignment-model-redesign.md` is the origin story: `assignmentType` was deliberately
narrowed to a closed, statically-guarded enum *because* it carries a universal cross-source
semantic, while `resourceType` stayed free-form because it carries source-specific detail. This
reasoning has never been extracted for the next author to find — it currently requires reading a
~300-line redesign doc and inferring it.

**Applies to:** #939 (BloodHound crawler needs new `PRINCIPAL_RELATIONSHIP_TYPES` values — this is a
safe, well-defined operation following the `assignmentType` precedent, not a blocked question); #921
(directory-permission holder pivot — Wim's own redirect toward "a new resourceType, mirroring how
this works in the AzureRM crawler" is exactly this rule, just not written down before the issue hit
`awaiting-design`).

**Evidence:** `docs/architecture/assignment-model-redesign.md`, `docs/architecture/ingest-api.md:328-330`.

### A4. Reuse the `synced` / `generated` / `manual` variant + reconciliation pattern 🟡
**Q:** Does this feature need to track whether a row came from a crawler, an algorithm, or a human
edit, and survive re-runs without clobbering manual edits? → reuse Contexts' variant axis and
reconciliation-by-stable-external-id (`context-redesign.md §3.2, §4.4`) instead of inventing a new
ownership/lifecycle vocabulary.

**Why not 🟢:** the pattern is well-proven (10 shipped context plugins), but two *other* in-repo
design docs already invented incompatible alternatives for the same underlying problem —
`risk-scoring-plugins.md`'s finding/override model and `rule-mining-discussion.md`'s
proposed/approved/implemented lifecycle. Adopting this rule going forward is low-risk; retrofitting
those two proposals to match is a real decision an architect should make once, explicitly, rather
than have it fall out of whichever of #672/#676 gets probed first.

**Evidence:** `context-redesign.md`, `risk-scoring-plugins.md`, `rule-mining-discussion.md`; applies
to #672, #676.

---

## B. Compute strategy

### B1. Materialize (matview/snapshot) vs. compute-on-demand 🟡
**Q:** Is the derivation traversal **bounded** (a few hops, small result set per view) **and** does
the source data have **complete history coverage**? → compute on demand / query-time, scoped to what
is actually being viewed. Is the derivation **unbounded or combinatorial** (a deep hierarchy × many
grants), **or** would reconstructing from `_history` be misleading because of coverage gaps? →
materialize (a matview, or a dedicated snapshot table).

**Why not 🟢:** every individual instance is well-justified, but no doc states the rule connecting
them — this is my synthesis across four precedents that point the same direction, not a rule anyone
has ratified. Treat it as a strong default, not a certified answer, until an architect has applied it
a few times without objection: `matrix.md` (migration 013 removed matview-side recursive expansion —
too costly, replaced by lazy click-time expansion), `effective-access-engine.md §2` (same choice,
generalized: "materialize vs. compute on demand," compute-on-demand wins), `matrix-scope-statistics.md`
(reconstructs from the audit log at query time — no dedicated snapshot table) all chose
compute-on-demand; `dashboard-trends.md` chose the **opposite** — a dedicated `DashboardSnapshots`
table, explicitly because pre-migration-018 history coverage was partial and reconstruction "would
tell a misleading... story." Both are right for their own case; nobody wrote down what separates them
until now.

**Applies to:** #790 (incremental/conditional matview refresh — frames the tradeoff but doesn't fully
resolve "how far do we go," since that's also a cost/ops-budget question, not purely an architecture
one).

**Evidence:** `docs/architecture/matrix.md`, `effective-access-engine.md §2`,
`matrix-scope-statistics.md`, `dashboard-trends.md`.

### B2. Never silently truncate or cap 🟢
**Q:** Does this endpoint/query return a potentially-unbounded collection? It must either (a)
genuinely return everything, or (b) cap it **and** expose an explicit `truncated` marker plus a
search/lookup path that reaches anything outside the cap — the shape `GET /api/matrix/columns` +
`GET /api/matrix/column-values` already ships.

**Why:** practiced identically and independently in two unrelated subsystems
(`effective-access-engine.md §7/§13.3` and the matrix's 500-value attribute paging), never named as
a standalone rule. A cap with no escape hatch is not an acceptable design.

**Applies to:** #788/#796 (this doesn't choose cursor vs. offset pagination for you, but it does rule
out "just cap the flat grid and lose rows" as an option — whatever mechanism #788 lands on must keep
the rest reachable).

**Evidence:** `docs/architecture/matrix.md` § *Attribute values — paged discovery, not a silent cap*;
`docs/architecture/effective-access-engine.md`.

### B3. Deterministic/rule-based over LLM/probabilistic for anything persisted or authoritative 🟢
**Q:** Is this output **persisted** and treated as ground truth for an audit/compliance decision (a
classification, a correlation match, a risk score, a matched account pair)? → deterministic,
rule-based, reproducible given identical inputs (seed any RNG). Is the output purely
**interpretive/generative** and never itself the record of truth (drafting a profile description, a
chat explanation)? → an LLM is fine there.

**Why:** practiced consistently five times and never stated as an explicit gate criterion:
account-linking is a dictionary + certainty slider, "there is no LLM" (`account-linking.md:20`);
`resource-cluster-algorithm.md` is deterministic, no embeddings; `demo-dataset.md`'s CTF answers must
be true on every run, "no LLM is involved"; `rule-mining-discussion.md` requires plugins be
"deterministic given identical inputs... analysts lose trust if candidate columns reshuffle";
`llm-and-risk-scoring.md` explicitly rejected an earlier "LLM wizard" shape for correlation.

**Applies to:** #940 (BloodHound attack-path risk plugin — the external analytics must land as
deterministic findings, not an LLM interpretation of the BloodHound output); #935 ("small simple LLM"
feature needs to be scoped to interpretive-only output, never a persisted classification).

**Evidence:** as cited inline above.

---

## C. Extensibility pattern

### C1. Default to the existing registry/plugin pattern 🟢
**Q:** Does the new capability (a) run independent of one specific request — schedulable or
on-demand — and (b) derive/produce rows (context membership, a finding, a report) from data that
already exists? → register it in the matching existing registry family (context plugin, crawler
manifest, future risk-finding plugin). Do **not** hand-roll a bespoke service or add a branch to
shared code for it.

**Why:** this is the single most consistently-applied pattern in the codebase — crawler manifests
(`tools/crawlers/CLAUDE.md:199-214`, "core API code must never branch on a crawler-type string"),
the 10 shipped context plugins (`context-redesign.md §4.3`: "crawlers ingest, plugins derive — no
more derivations in crawlers"), and `risk-scoring-plugins.md`'s explicit corollary that new plugin
families must **reuse** the context runner's `reconcile()` rather than duplicate it. Every located
context-plugin PR (#570, #534, #535) shipped as a routine, additive, ungated change — this is safe to
treat as pre-approved.

**Applies to:** #676 (context set-builder + principal clustering — should be a registered context
plugin, not a bespoke service, per its own probe's framing).

**Evidence:** `tools/crawlers/CLAUDE.md`, `docs/architecture/context-redesign.md`,
`docs/architecture/risk-scoring-plugins.md`.

**Known contradiction this doesn't yet resolve:** `docs/risk-scoring/plugin-architecture.md`
describes a *third*, incompatible plugin shape for the same conceptual slot (Python ABCs, YAML
"classifier packs," a `plugins/community/` filesystem layout, a CLI) with no in-tree relationship to
any of the above, and no status header. See the contradictions section of
[`architecture-guidance-review-2026-09.md`](architecture-guidance-review-2026-09.md). Do not treat
that document as guidance until an architect resolves the conflict.

---

## D. UI / design-system boundary — a routing rule, not an architecture rule

### D1. Does adopting a "shared" primitive change any shipped page's appearance? 🟡 (half 🟢)
**Q1 (🟢 — a fact the AI can check itself):** Does the named shared target have **zero current
importers**? → there is no visual precedent to conflict with; this is establishing the pattern for
the first time, not "unifying" anything. Proceed as a normal build once the component's shape is
written into [`docs/contributing/style-guide.md`](../contributing/style-guide.md) — no separate
design-gate wait is needed.

**Q2 (🟡):** Does adopting it change the **rendered appearance** of an already-shipped page? → this is
a **Designer** question (per `definition-of-ready.md`'s own role table: "Form: interaction model" is
the Designer's, not the Architect's), and belongs in the Style Guide, not this document. Route it
there explicitly rather than letting it sit as an undifferentiated `state:awaiting-design` item.

**Why this matters:** `docs/contributing/style-guide.md` already exists, is CI-enforced in part, and
is the correct target for exactly these questions (component API shape, border-radius scale, a
semantic token layer) — but several currently sit in `state:awaiting-design` waiting on "the
architect" when they need a **designer/product** decision recorded in the Style Guide instead.
Sharpening *this* document cannot resolve them; sharpening the Style Guide can.

**Applies to:** #754 (Section/StatCard — `DetailSection.jsx` has **zero importers** anywhere in the
codebase; per Q1 this should never have needed a design gate) vs. #750/#757/#762/#764 (these do
change shipped appearance — genuinely Style-Guide/Designer questions, not resolved by this doc).

**A worked correction, not a new rule:** #749 ("unify the interactive accent to blue, demote
lime/indigo") reads as a contradiction of the Style Guide, but isn't one — `style-guide.md §1`
already defines **two** intentional roles (green = brand, blue = interactive) and forbids only a
*third* color (indigo). TaekeK's comment on #749 ("the Dashboard's lime accent is intentional brand
... isn't the right direction without a product/brand decision") is the Style Guide reasserting
itself, not a new architectural ruling. #749 is mis-scoped as filed — the buildable slice is "demote
indigo," not "demote lime." See the contradictions section of the review doc.

### D2. New third-party runtime dependency: build vs. adopt 🟡
**Q:** Is the primitive small and well-understood (focus-trap + Escape-to-close is roughly
50–100 lines)? → hand-roll it, add zero new dependencies. Does correctness depend on deep
platform-specific behavior (rich cross-screen-reader a11y semantics, complex date/timezone math) that
the team would otherwise reverse-engineer? → adopting a maintained library is justified.

**Why not 🟢:** no existing repo-wide dependency policy was found either way — this is a genuinely
new question, offered as a reasonable default rather than a codified precedent.

**Applies to:** #752 (shared Modal — hand-roll focus-trap/Escape vs. adopt Radix/Headless UI).

### D3. Per-user UI preference persistence 🟡
**Q:** Does the requirement explicitly need the preference to sync across the user's devices/sessions
or be visible to admins? → needs a new backend table (none exists today). Otherwise → `localStorage`,
no new backend primitive.

**Applies to:** #207 Slice B (Linked Accounts column customization — no per-user preference store
exists yet, and nothing in the request says it needs to sync across devices).

---

## E. Sizing & decomposition (highest-leverage gap — see impact estimate)

**No existing rule addresses this at all** beyond the file-size/complexity ratchets, which govern
code, not issues. Every `state:decompose` issue currently improvises its own splitting logic. The
checklist below is synthesized from the 12 decompose issues surveyed, offered as a starting rubric —
**all 🟡**, expect an architect to adjust it after a few uses.

- **Split by capability, not by phase.** If the request names 2+ independently-shippable
  capabilities (each individually useful without the other), split along that line — not into
  "phase 1 / phase 2" of one capability. *Model: #843's own definitional litmus test
  ("a Business Role is a bundle you give out; a Logical Application is a boundary you're responsible
  for") is exactly the kind of self-resolving decomposition question a decompose issue should answer
  in its own body before slicing — promote it into `docs/architecture/` as the concept doc it already
  functions as.*
- **Schema-touching work ships before its first UI consumer.** If part of the request needs a
  migration and another part is UI-only, the schema slice ships first (framework-before-consumer),
  matching how `effective-access-engine.md`'s own phasing and #672's probe-generated slice plan both
  sequence.
- **A slice with no size problem shouldn't be forced through `decompose`.** #839 and #837 have no
  scope-size issue at all — they're blocked purely on a *dependency* chain (#837 → #838 → #839).
  `decompose` is the wrong route for a purely-sequencing block; it should route to
  `Blocked (external)` or stay in `awaiting-requestor` against the blocking issue instead, so the
  distinction is visible on the board.
- **Right-sized already?** If the request is already scoped to one schema change + one consumer +
  fixture ACs describable in under ~5 Given/When/Then cases, do not decompose further —
  over-splitting adds coordination overhead without reducing risk.

---

## F. Explicitly out of scope for this document

**Security/operational hardening defaults** for an auth-off, self-hosted deployment (#779 PowerShell
worker hardening, #780 Azure IaC hardening, #782 Postgres TLS, #783 vault master-key policy, #784
rate limiting, #785 container hardening) are **policy decisions** (a rotation cadence, which layer
owns rate limiting, a credential-handling posture), not "does this fit the existing architecture"
questions. Routing them through the Architect hat under `state:awaiting-design` is a category error —
no architecture principle resolves "what's our default token-rotation cadence." These need either a
dedicated `docs/security/deployment-defaults.md` policy page with an explicit owner, or a
Product-Board policy call. See the review doc's impact estimate for why this reclassification matters
more than any content fix here.
