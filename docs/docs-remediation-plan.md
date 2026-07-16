# Documentation Remediation Plan v2 (living document)

> **Purpose:** Establish whether the IdentityAtlas documentation is (a) **complete** relative to shipped features and (b) **usable** for the stated goals — and close the gaps in a structured way. Builds on [`docs-gap-audit.md`](docs-gap-audit.md).
> **Baseline:** edge (`main` @ `d4afdb9f`, v5.441). **Branch:** `feature/docs-gap-audit` (local).
> **v2 change (after dual-voice review):** usability is measured with **journey walkthroughs (primary instrument)**; the coverage grid is a **supporting inventory**. See the [Review appendix](#review-appendix-dual-voice) at the bottom.
> **Execution (2026-07-15):** all **34 backlog items (BL-1..BL-34) applied** — 20 docs updated + 6 new guides (dashboard, contexts, effective-access, custom-connector, data-tab, authentication), added to the mkdocs nav. See the changelog fragment `changes/docs-gap-audit.md`.

## Why v2

v1 measured only *presence* per feature (✅/🟡/⭕). An independent review with four voices (three Claude subagents + Codex, all against the real files) unanimously concluded: that answers goal (a) but **not goal (b)**. A cluster can go fully green and still ship docs a real user gets stuck on (present ≠ correct ≠ findable ≠ executable). v2 fixes this with two instruments and a few process gates.

---

## The two instruments

### Instrument A — Coverage grid (supporting: *completeness*)
A status cell per feature × doc-type axis. Answers: *does correct documentation exist for this feature?* This is inventory/traceability, not proof of usability.

### Instrument B — Journey walkthroughs (**primary**: *usability*)
A small set of named persona tasks walked end-to-end with **the docs only**, by someone who did **not** write the doc in question. This is the acceptance test for "usable for the stated goals". A cluster/journey is only done once the walkthrough passes.

---

## Doc-type axes (4, after review)

**Analyst/User is primary (P1).** For this product (role-mining / access-governance) the core end user is the **Analyst/Reviewer** who investigates and attests — not a generic "how do I use this screen" reader.

| Axis | For whom | Home base | Prio |
|----|----------|-----------|------|
| **Analyst/User** | Role-mining/attestation end user: "who can access X and why", "certify this access", "find over-privileged identities" | `docs/ui/`, `docs/quickstart.md`, `docs/concepts/` (task-oriented) | **P1** |
| **Operator** | Install, configure, run, recover | `docs/admin/`, `docs/reference/config.md`, deployment/docker, security, operations | P2 |
| **Contributor** | Build on the repo: architecture, conventions, extension points, tests | `docs/architecture/`, `building-a-crawler.md`, `CLAUDE.md` files | P2 |
| **API consumer** | Integrates via the API without touching the repo: contracts, auth, examples, errors, versioning | `docs/api/`, `openapi.yaml`, `docs/reference/sql-views.md` | **P1 for push/ingest**, otherwise P2 |

`docs/concepts/` may fill the **Contributor** cell, but the **Analyst/User** cell requires a task-/screen-oriented guide; a stale concept doc only counts against Contributor.

## Status rubric (after review)

Two independent dimensions per cell — **coverage** and **trust** — so "wrong" no longer disappears into "partial":

| Symbol | Meaning |
|---|---|
| ✅ | Present **and** meets the usability rubric (see below) |
| 🟡 | Present but incomplete for the task (missing steps/examples/prereqs) |
| ⭕ | Missing |
| ❌ | **Present but factually wrong / misleading** — sorts before ⭕ |
| **P0** | ❌ that is misleading and security/privacy-sensitive (e.g. `risky-consent` egress, wrong risk thresholds) → **release-blocking** |
| — | n/a for this axis |

**Usability rubric — a cell is only ✅ if the doc:** is accurate against the baseline commit · is findable from the logical starting point · states prerequisites · contains executable steps · has copy-paste-complete examples (incl. auth/base-url/expected output) · shows the expected result · covers common error paths · has been independently tested.

## Verification gate (mandatory before every decision)

The grids are **pre-filled from an AI audit and count as UNVERIFIED**. Before deciding on an action for a cell (write/fix/update):
1. Open the cited code file and the cited doc; confirm the symbol/fact.
2. Mark the cell `verified` (with checker + date) instead of `inherited`.
3. Stamp the cell with the baseline commit it was verified against.

*(The review already did this for 2 cells — tiers=90/70 and `/perf/slow`+`/perf/toggle` — and both held. Verification is therefore cheap, not superfluous.)*

---

## Instrument B — Journeys (primary)

Candidate journeys (to be finalized in the first session). Each maps to the clusters it touches and has a pass/fail from a doc-only walkthrough:

| # | Journey (persona) | Touches clusters | Core question |
|---|-------------------|----------------|-----------|
| J1 | **Zero-to-first-insight** (Analyst): `docker compose up` → first crawler → data on Dashboard → first finding in Matrix | 1,7,8,4,2 | Does a new evaluator get from zero to first insight with docs only? |
| J2 | **Assess a risk score** (Analyst): read an identity risk badge → understand the tier → make an analyst override | 5,4 | Can the analyst understand the score and act on it? |
| J3 | **"Who can access X and why"** (Analyst): effective-access / matrix investigation | 2,10,4 | Can the analyst prove and explain access? |
| J4 | **Certify access** (Analyst): governance/attestation flow | 6,4 | Can an access review be completed? |
| J5 | **Set up an Entra crawler** (Operator): choose phase toggles deliberately | 7,8 | Does the operator know which toggles are needed and what each costs? |
| J6 | **Push data via custom connector** (API consumer): with `docs/api` only | 9 | Can an integrator push data + rotate a key without the repo? |
| J7 | **Build a crawler** (Contributor): end-to-end from the docs | 7,9,10 | Can a contributor build a crawler with the docs only? |
| J8 | **Create + reuse a Context** (Analyst): tree, plugin run, "Filter matrix" | 3,2 | Does the newest, most complex surface work end-to-end? |
| J9 | **Administer the deployment** (Operator): Admin panel, Auth/Roles, export, retention, danger-zone | 8 | Can an operator manage the app doc-only? |
| J10 | **Understand + query the data model** (Contributor): schema, valid enums, SQL views | 10 | Can a contributor understand the data model and query it doc-only? |

**Pilot one complex flow first** (recommended by the review) — J8 or J1 — as a task-oriented guide + usability test, before scaling up the format.

**Walkthrough results table (per journey):**

| Journey | Persona | Completed? (y/n) | First blocker | Where you had to leave the docs | Backlog item |
|---------|---------|-----------------|----------------|----------------------------------|--------------|
| **J1 (pilot, 2026-07-15)** | Analyst/Operator | **NO** (doc-only) | Entra setup: `entra-id.md` mentions "fill in Tenant/Client ID + Secret" but not **which Graph permissions** are needed; that list lives in `reference/troubleshooting.md` (wrong home) and `quickstart.md` doesn't link to `entra-id.md`. (Creating an App Registration = known Entra knowledge, not a doc gap.) | (1) permission list → move out of troubleshooting; (2) the dashboard landing page has no doc; (3) scoping the Matrix is only possible via the undocumented Filter Wizard | BL-1..BL-7 |

| **J8 (2026-07-15)** | Analyst | **NO** (doc-only) | There is **no** user guide for the Contexts screen; `overview.md` doesn't mention Contexts. The only docs (`context-redesign.md` + `context-redesign-ui.md`) are architecture specs headed **"not yet implemented"** while the feature is live → misleading. | Immediately — the analyst has no step guide at all and must fall back entirely on the UI itself | BL-8, BL-9, BL-10 |
| **J2 (2026-07-15)** | Analyst | ⚠️ PARTIAL | The steps are documented, but `risk-scoring/overview.md`+`design.md` give **wrong tier bounds** (Critical ≥80/High ≥60 instead of code ≥90/≥70; Medium upper bound also wrong). `ui/overview.md` is correct but contradicts them → the analyst mis-classifies every badge. | For the *correct* tier meaning you have to read `tiers.js` | BL-11, BL-12, BL-13 |
| **J3 (2026-07-15)** | Analyst | ⚠️ PARTIAL | "Who can access X" *direct* works; *effective/inherited access* exists only as a design spec, the endpoints are in no API reference, no task guide. `matrix.md` still teaches the retired `O` badge; `api/matrix.md`+`entities.md` mention the v4 relic `mat_UserPermissionAssignments`. | To resolve the badge model + effective-access you had to read migrations + `engine.js` | BL-14, BL-15, BL-16 |
| **J4 (2026-07-15)** | Analyst/Reviewer | **NO** (doc-only) | No product surface to *execute* a certification (read-only mirror), and the docs don't say so. On top of that `governance-model.md`+`api/governance.md` use the **retired `assignmentType='Governed'`** (a boolean flag since migration 047) and wrong table names (`GraphCategories`→`GovernanceCategories`). **Refutes the audit** (which called governance "well covered"). | To find "how do I record a decision" you had to grep `routes/` | BL-17, BL-18, BL-19 |
| **J5 (2026-07-15)** | Operator | ⚠️ PARTIAL | The setup flow (wizard) *is* documented, but a deliberate **toggle choice** fails: 6 shipped toggles are missing from the flags table (BL-3), no "which toggle for which purpose" help, permissions elsewhere (BL-1), diagram wrong (BL-2). | For toggle effects + permissions you have to leave the docs | BL-1, BL-2, BL-3, BL-20 |
| **J6 (2026-07-15)** | API consumer | ⚠️ PARTIAL | *Rotating* works; *pushing the first record* fails end-to-end: no `docs/sync/custom-connector.md`, no runnable `curl` under `docs/api/` (the only one is in `app/api/CLAUDE.md`), and `ingest-api.md` is stale (response shape + the `assignmentType` enum list retired values → 400). | For a key + real payload/response you had to read the handler + `openapi.yaml` | BL-21, BL-22, BL-23 |
| **J7 (2026-07-15)** | Contributor | ✅ **PASS** | None — a contributor can scaffold a crawler doc-only from `building-a-crawler.md` (+ architecture + CLAUDE.md). Only 2 small cross-doc contradictions (stale `getConfigSecret` signature; wizard import style). | Nowhere (only a cross-check on 2 contradictions) | BL-24, BL-25, BL-26 |
| **J9 (2026-07-15)** | Operator | **NO** (doc-only) | Only Auth/Roles (step b) works doc-only. `overview.md` lists **3** admin sub-tabs instead of **10**; the **Data** tab (export/retention/danger-zone) exists nowhere in the docs, and `audit-history.md` refers to a non-existent "History Retention" sub-tab. | For 6 of the 10 tabs + retention + danger-zone you had to read `adminTabs.js`/`maintenance.js`/`curatedData.js` | BL-31, BL-32, BL-33, BL-34 |
| **J10 (2026-07-15)** | Contributor | ⚠️ PARTIAL | Understanding the schema + valid enums works (`data-model.md` is correct — the audit suspicion was unfounded). But *querying* fails: `sql-views.md` examples select non-existent columns, call matviews "planned" (materialized since migration 013), and `assignment-model-redesign.md` still says "no code yet". | For the real view columns you had to read the migrations | BL-27, BL-28, BL-29, BL-30 |

**J8 verdict:** straight FAIL. A primary, always-visible tab (Contexts) has zero user documentation, and the only existing docs claim the feature doesn't exist. This is the sharpest confirmation of audit finding A2 + B1, now through the journey lens: the grid alone might read this as "🟡 spec exists"; the journey shows the spec actively misleads the user.

**J1 verdict:** the demo path (Load Demo Data) works and is well documented. But the *real* first-insight path fails doc-only on three points: (a) connecting your own Entra tenant requires leaving the docs for the permission list; (b) the Dashboard landing page you land on has no user doc; (c) scoping the Matrix to reach a *finding* is only possible via the Filter Wizard, which isn't documented (overview.md still describes the removed "User Limit Slider"). Extra finding: `index.md` and `quickstart.md` contradict each other about whether `.env` is needed.

---

## Prioritization & order (after review)

1. **P0 first** — misleading/security-sensitive docs (Tier A + `risky-consent` egress). Wrong > missing.
2. **Then the first-run journey (J1)** — every user hits this on day 1; a stranded day-1 user never reaches Contexts.
3. **Then reorder by journey impact** = task frequency × harm-on-error × centrality — **not** by gap size.

Priority rubric per backlog row: `audience (P1>P2) × wrongness (❌/P0 > ⭕ > 🟡) × usage frequency`.

## Backlog format (after review)

One row per gap with **actionable** fields:

`feature-ID | doc-type | action | prio | owner | estimate | target-doc | definition-of-done | status`

- **Actions:** `write` · `update` · `fix` · **`reduce/hide/deprecate`** (change the product so the doc isn't needed) · `accept`.
- **`accept` requires:** reason + affected personas/tasks + approver + residual risk + review-by date. No silent drop.
- **Definition-of-done** is tied to a task: *"journey Jx passes doc-only"*, not *"page exists"*.

## Recurrence / freshness (after review)

- Stamp every cell with the **baseline commit**; staleness becomes visible (edge is already on v5.443 vs baseline v5.441).
- **Re-audit trigger:** a PR that touches a listed code path must update that cluster grid; consider extending the existing `openapi.drift.test` to the read API and a "docs-touched?" item in the PR/release template. Otherwise the grid re-rots just like the docs now (your own A2).

## Overall exit criterion

The whole thing is done when:
1. **All P0/❌** wrong docs are fixed.
2. **Every persona journey (J1–J10) passes** a doc-only walkthrough.
3. No **⭕ on P1 cells** (Analyst/User + API consumer for push/ingest).

## Working method per cluster

1. Choose/pin the journey(s) that touch this cluster.
2. **Verify** the grid cells you're going to handle (verification gate).
3. Fill the backlog with actionable rows (owner + DoD).
4. Run the walkthrough; log blockers.
5. Mark the cluster done once its journey passes doc-only and P1 cells no longer have any ⭕.

## Progress

| # | Cluster / track | Status |
|---|-----------------|--------|
| 0 | Non-feature docs (getting-started, troubleshooting/errors, "why" concepts, limitations) | 🔄 partly via J1 (cells ✔) |
| 1 | Getting started & Dashboard | ✅ fixes applied — via J1 (BL-4,5,7) |
| 2 | Matrix | ✅ fixes applied — via J1+J3 (BL-6,14,15,16) |
| 3 | Contexts (screen + plugins + API) | ✅ fixes applied — via J8 (BL-8,9,10) |
| 4 | Entities & detail pages | ⬜ to do (touched by J2/J3/J4; findings in 2/5/6) |
| 5 | Risk scoring & AI/LLM | ✅ fixes applied — via J2 (BL-11,12,13) |
| 6 | Governance / business roles | ✅ fixes applied — via J4 — **refutes the audit** (BL-17,18,19) |
| 7 | Sync sources / crawlers | ✅ fixes applied — via J1+J5+J7 (BL-1,2,3,20,24,25,26) |
| 8 | Admin & settings (incl. Admin nav shell / 10 sub-tabs) | ✅ fixes applied — via J9 (BL-31,32,33,34) |
| 9 | Integration & ingest API (**owner of Custom Connector**) | ✅ fixes applied — via J6 (BL-21,22,23) |
| 10 | Platform & data model (owner of context **schema**) | ✅ fixes applied — via J10 (BL-27,28,29,30) |
| J | Journeys J1–J10 (primary instrument) | ✅ **all 10 executed** — J7 PASS · J2/J3/J5/J6/J10 PARTIAL · J1/J4/J8/J9 FAIL (doc-only) |

> **MECE fixes applied:** Custom Connector is owned by **Cluster 9** (stub reference in 7). The v6 context **screen/API** belongs in Cluster 3, the **schema/tables** in Cluster 10. "All 10 Admin sub-tabs" gets one canonical row in Cluster 8. The false "DevOps" marketing claim is captured in Cluster 0 (not silently dropped despite marketing being out of scope).

---

## Cluster 0 — Non-feature docs (new, after review)

Code-as-ground-truth misses what isn't a feature but is asked about most.

> **✔ = verified against code/docs on 2026-07-15 (baseline `d4afdb9f`).** Unmarked cells are still inherited from the audit.

| Category | Analyst/User | Operator | Contributor | API consumer |
|-----------|:-----------------:|:--------:|:-----------:|:-------------:|
| Getting-started / onboarding (J1) | 🟡 ✔ (demo ok; own-tenant fails) | 🟡 ✔ | — | — |
| Troubleshooting / error messages ("it isn't syncing — why") | 🟡 ✔ (exists, thin/wrong home) | 🟡 ✔ | 🟡 ✔ | ⭕ ✔ |
| Concepts / "why" (mental models) | 🟡 | — | 🟡 | — |
| Limitations / known-issues (incl. false "DevOps" source claim) | ⭕ | ⭕ | ⭕ | ⭕ |

**Backlog:** _(to be filled during review)_

---

## Cluster 1 — Getting started & Dashboard

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Quickstart / first crawler | 🟡 | 🟡 | — | — |
| Dashboard landing page | ⭕ | — | 🟡 | — |
| Trends tab | ⭕ | — | ✅ | — |

**Backlog:**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-4 | update: link `entra-id.md` (+ demo vs own-tenant choice) from "What's Next" | P1 | _tbd_ | `docs/quickstart.md` | J1 step 2: new user finds the Entra setup without guessing |
| BL-5 | write: user doc for the Dashboard landing page (cards, counts, "is my data in yet?") | P1 | _tbd_ | `docs/ui/` (new) | J1 step 3: user understands what they see doc-only |
| BL-7 | fix: `.env` contradiction between `index.md` (download `.env.example`) and `quickstart.md` ("just Docker") | P2 | _tbd_ | `docs/index.md` + `docs/quickstart.md` | One consistent install story |

---

## Cluster 2 — Matrix

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Base view (badges, staircase, DnD, IST-SOLL, export) | 🟡 | — | ❌ ✔ (`matrix.md` teaches the retired `O` badge; `api/*` mentions the v4 relic `mat_UserPermissionAssignments`) | — |
| Filter Wizard (3-step + saved matrices) | ⭕ | — | ⭕ | ⭕ |
| Roll-up-by-attribute | ⭕ | — | ⭕ | — |
| Orientation / rotated view | ⭕ | — | ⭕ | — |
| Scope statistics | 🟡 | — | ✅ | — |
| Matrix interaction endpoints (preview, hierarchy-paths, saved-filters) | — | — | — | ⭕ |

**Backlog:**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-6 | write Filter Wizard/saved-matrices/roll-up + fix: remove the outdated "User Limit Slider" from overview.md | P1 | _tbd_ | `docs/ui/overview.md` (+ matrix) | J1 step 4: analyst can scope the matrix and reach a *finding* doc-only |
| BL-14 | write task guide "Who can access resource X, and why" (direct + inherited holders + access path) | P1 | _tbd_ | `docs/guides/effective-access-howto.md` (new) | J3: analyst answers "who + why" doc-only |
| BL-15 | update: document effective-access endpoints (`GET /resource/:id/effective-access`, `/principal/:id/…`, `POST /effective-access/resolve`) | P1 | _tbd_ | `docs/api/matrix.md` | Endpoints findable outside the design spec |
| BL-16 | fix the stale badge table (drop `O`/`Governed`, add DirectoryRole(Eligible)) + replace `mat_UserPermissionAssignments` with `vw_ResourceUserPermissionAssignments` | P2 | _tbd_ | `docs/architecture/matrix.md` + `docs/api/matrix.md` + `docs/api/entities.md` | No doc contradicts the 3-badge model; no v4 relic |

---

## Cluster 3 — Contexts (screen + plugins + API)

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Context model (synced/generated/manual × 4 targets) — *screen/behavior; schema→C10* | ⭕ ✔ | — | ❌ ✔ (spec says "not yet implemented" — misleading) | — |
| Contexts screen (tree, drag-reparent, wizard, Filter-matrix) | ⭕ ✔ | — | ❌ ✔ (spec says "not yet implemented") | — |
| Plugin catalogue (10; 5 undocumented/mis-named) | ⭕ | ⭕ | 🟡 | — |
| `risky-consent` external threat-feed egress | — | **P0** | ❌ | — |
| Tags as context (`contextType='Tag'`) | 🟡 (stale GraphTags ref) | — | 🟡 | — |
| Admin → Plugins sub-tab | ⭕ | ⭕ | 🟡 | — |
| Context write + plugin API (`/contexts` writes, `/context-plugins/*`) | — | — | — | ⭕ |

**Backlog:**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-8 | **fix (❌):** remove the "not yet implemented" status from both context specs; mark as implemented (A2) | P1 | _tbd_ | `docs/architecture/context-redesign.md` + `context-redesign-ui.md` | Status matches the shipped code |
| BL-9 | write: Analyst user guide for the Contexts screen (tree, synced/generated/manual, New-Context wizard, Run now, "Filter matrix") | P1 | _tbd_ | `docs/ui/` (new) | J8 passes doc-only |
| BL-10 | update: `overview.md` nav list — add Contexts, remove the removed "Org Chart" (findability) | P1 | _tbd_ | `docs/ui/overview.md` | New user finds the Contexts tab via the docs |

---

## Cluster 4 — Entities & detail pages

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| List+detail: Principals / Identities / Resources / Systems | 🟡 (stale names/OrgUnits) | — | ✅ | ✅ |
| Entity detail tabs (attrs / graph / timeline / risk) | 🟡 (arch-only) | — | ✅ | — |
| Account-linking | ✅ | — | ✅ | — |
| Secondary detail endpoints (contexts/assignments/business-roles/oauth2-grants) | — | — | — | ⭕ |

**Backlog:** _(to be filled during review)_

---

## Cluster 5 — Risk scoring & AI/LLM

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| 4-layer engine + risk tiers | **P0** (cutoffs WRONG) | — | ❌ (cutoffs WRONG) | — |
| Classifiers (generation flow) | 🟡 | — | 🟡 (stubbed PS path) | — |
| Analyst overrides | ✅ | — | ✅ | — |
| AI-agent scoring | 🟡 | — | 🟡 (stale refs) | — |
| LLM classifier generation (Node vs. PS stub) | — | 🟡 | 🟡 | — |
| Risk-profile/classifier API (~20 endpoints) | — | — | 🟡 | ⭕ |
| Admin → Risk-Scoring wizard & LLM settings | ⭕ | 🟡 | 🟡 | — |

**Backlog (via J2):**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-11 | **fix (P0):** tier bounds → Critical 90–100, High 70–89, Medium 40–69 (matches `tiers.js`) | P0 | _tbd_ | `docs/risk-scoring/overview.md` | Analyst derives the same tier from overview.md as the badge shows |
| BL-12 | **fix (P0):** same tier correction | P0 | _tbd_ | `docs/risk-scoring/design.md` | No doc names a cutoff that contradicts `tiers.js` |
| BL-13 | update: override = integer −50..+50, reason 3–500 chars | P2 | _tbd_ | `docs/risk-scoring/overview.md` | Analyst gets no unexplained 400 |

---

## Cluster 6 — Governance / business roles

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Business roles / governed assignments / resource grants | 🟡 ✔ | — | ❌ ✔ (docs use the retired `assignmentType='Governed'`; a boolean flag since migration 047) | — |
| Certifications (executing) | ❌ ✔ (docs imply a flow; the product is a read-only mirror) | — | 🟡 ✔ | — |
| Assignment policies / requests | — | — | ✅ | — |
| IGA platform mapping (Entra/Omada/SailPoint) | — | — | ✅ | — |
| Governance-summary / review-compliance API | — | 🟡 ✔ | 🟡 ✔ (table names `GraphCategories`→`GovernanceCategories` wrong; endpoints not in api/governance.md) | ⭕ ✔ |

**Backlog (via J4 — refutes the audit's "governance well covered"):**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-17 | write: "Identity Atlas **reports on** but does **not execute** certifications — decisions are made in the source IGA (Entra Access Reviews) and mirrored read-only"; + where the reviewer actually looks | P0 | _tbd_ | `docs/concepts/governance-model.md` + `docs/ui/overview.md` | J4: reviewer knows doc-only where decisions are made; no dead-end |
| BL-18 | **fix (P0):** remove the retired `assignmentType='Governed'` everywhere; replace with the `governed=true` flag | P0 | _tbd_ | `docs/api/governance.md` + `docs/concepts/governance-model.md` | Grep for `'Governed'` as a type = 0; matches migration 047 + ingest guard |
| BL-19 | fix table names (`GovernanceCategories`) + document `GET /governance/summary` & `/review-compliance` | P1 | _tbd_ | `docs/api/governance.md` | Names + endpoints match the code |

---

## Cluster 7 — Sync sources / crawlers

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Entra ID (6 phase toggles + AI-agent classification) | 🟡 ✔ | 🟡 ✔ (permissions are in troubleshooting, not setup) | ❌ ✔ (diagram shows the retired `Owner` type; 6 toggles missing from the flags table) | — |
| Azure RM (`onlyEntraPrincipals`) | 🟡 | 🟡 | ✅ | — |
| midPoint | ✅ | ✅ | 🟡 (streaming/dept dev-only) | — |
| Omada | ✅ | ✅ | ✅ | — |
| CSV import (new templates) | 🟡 | 🟡 | 🟡 | — |
| Custom Connector (push-mode) → *owner: Cluster 9* | ↪ C9 | ↪ C9 | ↪ C9 | ↪ C9 |
| Wizard/plugin architecture + live discovery | — | — | ✅ | — |

**Backlog:**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-1 | update: name the **required Graph permissions** in the setup section (currently only in `troubleshooting.md`). Creating an App Registration is assumed known → not documented. | P1 | _tbd_ | `docs/sync/entra-id.md` | J5 passes doc-only; J1 step 2 no longer leaves the docs for the permission list |
| BL-2 | **fix (❌):** "What Gets Synced" diagram — remove the retired `Owner` assignment type; show ownership as `Direct` on `GroupOwnership` | P1 | _tbd_ | `docs/sync/entra-id.md` | Diagram matches `assignmentTypes.guard` (Direct/Indirect/Eligible) |
| BL-3 | update: 6 shipped toggles in the flags table (`SyncOAuth2Grants/AppRoles/AppPermissions/AppOwners/PrincipalRelationships/DirectoryRoles`) + AI-agent classification | P2 | _tbd_ | `docs/sync/entra-id.md` | Flags table = crawler param block |
| BL-20 (J5) | write: "which toggle for which purpose" decision aid (when to enable SPs/PIM/app-roles/owners + costs) | P2 | _tbd_ | `docs/sync/entra-id.md` | Operator deliberately chooses the right toggles doc-only |
| BL-24 (J7) | **fix:** stale `getConfigSecret` signature `(crawlerId, key)` → `(configId)` (matches `crawlerSecrets.js`) | P2 | _tbd_ | `tools/crawlers/CLAUDE.md` (~line 178) | Contributor calls `getConfigSecret` correctly |
| BL-25 (J7) | fix: wizard import style → `@ui/` alias instead of `../../../app/ui/src/…` traversal (two docs contradict each other) | P2 | _tbd_ | `docs/sync/building-a-crawler.md` | Both crawler docs teach the same import convention |
| BL-26 (J7) | update: minimal example to dot-source `shared/Invoke-CrawlerIngest.ps1` (`Update-CrawlerProgress`) instead of hand-rolled | P3 | _tbd_ | `docs/sync/building-a-crawler.md` | Example matches the "dot-source shared helpers" rule |

---

## Cluster 8 — Admin & settings

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| **Admin nav shell / 10 sub-tabs (canonical inventory row)** | ❌ ✔ **P0** (overview lists 3, really 10; Data tab missing) | ❌ ✔ | 🟡 | — |
| Authentication / Roles & Permissions editor | ⭕ (no UI walkthrough) | ✅ ✔ (`permissions.md` covers role→permission + bootstrap/lockout) | 🟡 | — |
| Updates (auto-update, channel, history) | ✅ | ✅ | ✅ | — |
| Data tab (PowerQuery ✅; curated import/export ⭕, retention ⭕, danger zone ⭕) | 🟡 ✔ | ⭕ ✔ | 🟡 | — |
| Performance | ✅ | 🟡 | ❌ (perf-endpoint drift `/perf/slowest`→`/perf/slow`) | ❌ |
| Crawler config audit/reset | — | ⭕ | — | ⭕ |
| About / SBOM / license | 🟡 | ✅ ✔ (permission catalogue is correct) | ✅ | — |

**Backlog (via J9):**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-31 | **fix (P0):** Admin sub-tab inventory — replace "3 tabs" with all 10 from `adminTabs.js`, each with its purpose + gating permission | P0 | _tbd_ | `docs/ui/overview.md` | J9 step a: operator finds every tab doc-only |
| BL-32 | **write (P0):** Data-tab guide — curated export/import (gates), history-retention (180d default, 0=off), Danger Zone/clean-database (what it wipes/keeps, rate-limit, `admin.systems`) | P0 | _tbd_ | `docs/admin/data-tab.md` (new) | J9 steps c+d doc-only |
| BL-33 | fix: retention path — `Admin > History Retention` doesn't exist → "section under Admin → Data" | P1 | _tbd_ | `docs/architecture/audit-history.md` (~line 132) | No doc refers to a non-existent sub-tab |
| BL-34 | update: Authentication/SSO + Roles setup as a step-by-step how-to (currently reference prose only) | P2 | _tbd_ | `docs/admin/authentication.md` (new) or `permissions.md` | J9 step b has a linked how-to |

---

## Cluster 9 — Integration & ingest API (owner of Custom Connector)

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Ingest API (`/ingest/*`, openapi.yaml) | — | ✅ | ✅ (openapi) | 🟡 ✔ (`ingest-api.md` stale: response shape + retired `assignmentType` enum → 400) |
| **Custom Connector (push-mode) — setup + map** | ⭕ | ⭕ ✔ | ✅ | ⭕ ✔ (no runnable example under `docs/api/`) |
| API-key management / rotation / audit | — | 🟡 ✔ (rotating works; *obtaining* a key is not self-service) | ✅ | 🟡 ✔ |
| Drift-guard scope (which routes are guarded) | — | — | 🟡 (only in a test) | — |

**Backlog (via J6):**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-21 | write a push-mode integrator guide: "you get the key from an admin / Admin→Crawlers (not self-minted)" + one runnable `curl` (base-url, `Bearer fgc_…`, real payload, `201` response) + rotate snippet | P1 | _tbd_ | `docs/sync/custom-connector.md` (new) | J6 walkable start-to-finish doc-only |
| BL-22 | **fix:** stale response + enum tables (response without `syncId`/`errors`; `assignmentType` = only Direct/Indirect/Eligible; current relationshipTypes) | P1 | _tbd_ | `docs/architecture/ingest-api.md` | Doc matches `handlers.js` + `openapi.yaml` |
| BL-23 | update: one authoritative external base URL (`PUBLIC_BASE_URL`) for proxied/TLS | P2 | _tbd_ | `docs/api/index.md` | Integrator knows the correct base URL |

---

## Cluster 10 — Platform & data model (owner of context schema)

| Feature | Analyst/User | Operator | Contributor | API consumer |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Data model (v3.1 + v6 contexts, **schema/tables**) | — | — | ✅ ✔ (`data-model.md` correct; the assignmentType collapse is right — the audit suspicion was unfounded) | — |
| **SQL views (query surface)** | — | — | ❌ ✔ (examples select non-existent columns; matviews called "planned") | 🟡 ✔ |
| Effective-access engine (P1 direct + P2 inherited) | — | — | ✅ | — |
| Soft-delete | — | 🟡 | ✅ | — |
| Audit-history / timeline | 🟡 | — | ✅ | — |
| Assignment-model collapse (migrations 044–049) | — | — | ❌ ✔ (status "no code yet" — is shipped) | — |
| Deployment / Docker / Azure | — | ✅ | ✅ | — |
| Scaling | — | 🟡 | ✅ | — |

**Backlog (via J10):**

| ID | Action | Prio | Owner | Target doc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-27 | **fix:** rewrite all example queries against real columns (`membershipType`/`path`/`userId`/`businessRoleId`/`managedByAccessPackage`); list the real output columns per view | P1 | _tbd_ | `docs/reference/sql-views.md` | Every example runs unchanged on a migrated DB |
| BL-28 | **fix:** matview status — `vw_ResourceUserPermissionAssignments` + `vw_UserPermissionAssignmentViaBusinessRole` are *materialized* (need `REFRESH`); drop "planned for a future release" | P1 | _tbd_ | `docs/reference/sql-views.md` | No "standard view"/"planned" language; refresh documented |
| BL-29 | update: status header "Proposed / no code yet" → "Implemented" + migration range 044–049 | P2 | _tbd_ | `docs/architecture/assignment-model-redesign.md` | Status matches the shipped code |
| BL-30 | fix: value list in the `vw_ResourceUserPermissionAssignments` row (drop `Owner`/`CrossResourceIndirect`; the column is `membershipType`) | P2 | _tbd_ | `docs/reference/sql-views.md` | Values = the view's `CASE` output |

---

## Review appendix (dual-voice) {#review-appendix-dual-voice}

This plan evolved from v1 after an `/autoplan` review with four independent voices (3 Claude subagents: strategy/process/DX + Codex against the real files). Unanimous core finding: v1 measured presence, not usability.

**Consensus (CONFIRMED by all voices):**
1. Measure usability, not just presence → **Instrument B (journeys)**.
2. Verify the AI-prefilled grids before deciding → **verification gate**.
3. Cover cross-cluster journeys → **J1–J10**.
4. Split Contributor vs API consumer; sharpen the primary persona to Analyst → **4 axes**.
5. Distinguish *wrong* from *missing* → **❌/P0 status**.
6. Make the backlog actionable (owner/DoD) → **backlog format**.
7. Add non-feature docs (troubleshooting/concepts/limitations) → **Cluster 0**.
8. Prevent re-rot → **recurrence/freshness gate**.
9. Resolve MECE overlaps → **owner assignment + Cluster 0**.

**Decisions (by the user, 2026-07-15):**
- UC1 — journeys primary, grid supporting: **accepted**.
- UC2 — 4 axes + Analyst persona: **accepted**.

**Auto-decided methodological fixes** (verification gate, ❌/P0 status, rubric, backlog DoD, reduce/hide/deprecate action, recurrence, exit criterion, Cluster 0, MECE owners): applied.

**Caveat on the inputs:** the grids above are still **inherited/unverified**; they only pass the verification gate during the cluster review.
