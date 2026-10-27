> **Source document.** The Milestone 1 brief as handed over on 2026-10-26, kept verbatim as the input to [the M1 design](m1-discovery-and-design.md). Where the two differ, the design says what was built and why.

# Identity Atlas — Milestone 1 Implementation Brief
## Queryable Organizational Context + Organizational Authorization Matrix

**Status:** Proposed build specification for Claude Code; validate repository findings before implementation.  
**Date:** 2026-10-26  
**Product direction:** *Understand access. Build better authorization models.*  
**Primary validation:** Can an authorization analyst work directly from an organizational unit and use organizational knowledge overlaid on current authorization data to investigate clusters and compose candidate roles faster and more consistently than in Excel?

> **Instruction to Claude Code:** Read this document, inspect the actual repository (`main`, relevant web branches, stacked open PRs, database migrations, tests, existing backlog and project documentation), and reconcile it with existing implementations. Reuse the current ontology, identity and authorization models, org-unit page and matrix data/query utilities wherever possible. Do not create parallel concepts just because this brief uses different words. Identify the complete stacked PR ancestry and distinguish functionality in `main`, an open PR, and absent functionality. Do not assume the PR numbers or branch contents mentioned elsewhere are authoritative without checking.

---

## 1. Why this milestone exists

Identity Atlas already provides technical access analysis through a sophisticated matrix. Recent work extends organizational knowledge acquisition through interview/document extraction, claims, organizational contexts and relationships. The missing link is an analyst-facing environment where those two information sources can be used together to engineer authorization models.

**Do not redesign the existing global matrix.** Add a **focused matrix view to the Organizational Unit page**. The selected organizational unit supplies the default population and context; no manual initial filtering should be required. Reuse lower-level matrix queries, effective-access computation, aggregation and rendering primitives when sensible, without copying the complexity of the existing general-purpose UI.

The first milestone should let an analyst perform his current Excel workflow — sort and group people by how a manager describes them, inspect access clusters, mark relevant/unrelated cells, and compose/edit a candidate role while seeing indicative implementation impact — within Identity Atlas.

This is a **deterministic workflow**, not an AI feature. Existing AI-assisted ingestion may feed the structured data, but **no LLM calls are required to render the view, group people, select cells, generate simple candidate composition or calculate impact**.

### The milestone outcome

An analyst opens an organizational unit, sees its members and technical access, views them through organizational dimensions, selects cells/entitlements and intended members, constructs a candidate role, and understands which existing grants it explains, which grants would be added and which would remain unexplained. The workbench does not write back to directories or IGA tools.

---

## 2. Initial ontology: three relationship predicates

Start with only these three *semantically distinct* relationships, mapped into the existing ontology vocabulary rather than introducing duplicates:

| Canonical concept | Meaning | Example | Analyst use |
|---|---|---|---|
| `performsActivity` | A person performs a business activity | Employee A performs *Handle Claims* | Group/sort individuals; scope candidate roles to actual work |
| `hasExpertise` | A person has knowledge or skill in a domain | Employee A has expertise in *Motor Claims* | Compare specializations and entitlement variations |
| `holdsResponsibility` | A person has an assigned duty/accountability outside or across routine activities | Employee A holds *Works Council Member* responsibility | Distinguish secondary/temporary access from primary job access |

**Terms are conceptual labels; do not impose these as RDF URI names until the repository's current ontology conventions have been reviewed.** Prefer mapping/adapting existing ontology predicates, classes and relation storage.

### Minimum queryable model

Each relationship record/edge must reference:

- **Subject:** stable canonical person/identity reference (not display name).
- **Predicate:** one of the three concepts above (or the semantically equivalent existing predicate).
- **Object:** stable canonical activity / expertise / responsibility entity (not free-text-only values). Reuse existing entities where available; support controlled creation/normalization when absent.
- **Source and provenance:** original interview/document/manager statement or imported record, with source ID and ideally a precise excerpt/section pointer.
- **Evidence state:** at minimum `asserted`, `confirmed`, `disputed`, or equivalent repository-native claim statuses; never convert an AI extraction into a verified fact automatically.
- **Temporal/context qualifiers when known:** valid-from/valid-to, organizational unit/context; unknown is permitted. A person may legitimately have multiple simultaneous activities/expertises/responsibilities.
- **Attribution:** who/what asserted or confirmed the relationship, plus creation/update timestamps.

The graph, claim store or relational backend is an implementation choice **to be determined by inspecting the repository**. Queryability matters more than storage technology. Do not introduce a second graph system if existing tables/entities can represent this cleanly.

### Required queries

For an org unit (including an explicitly defined and consistent descendant-membership rule), support:

1. Retrieve its members and their linked activities, expertise and responsibilities in bulk.
2. Retrieve the evidence/status for a selected relationship.
3. Group/sort members by any of these dimensions; people with multiple relationships should appear in appropriately labelled groups or be handled by a documented multi-value convention; never silently choose one.
4. Surface missing/unconfirmed/disputed organizational links instead of treating missing information as negative evidence.
5. Associate each person with their technical identities without assuming one person equals one account.

### Guardrails

- **Do not assert that organizational relationships directly grant access.** They inform investigations and possible role membership, but are not automatic authorization rules.
- Roles, HR job titles, activities, expertise and responsibilities are different concepts. Avoid collapsing them into one generic `role` field.
- The works council (OR), project duties and temporary responsibilities are first-class examples of why one person's access cannot all be explained by one primary job role.
- Provisional suggestions are different from confirmed knowledge. Show source and confidence/status as appropriate; do not fabricate quantitative confidence percentages.
- Authoritative source-system membership and manager-reported grouping may disagree; preserve and expose the distinction.

### Small validation dataset

Use real customer information **only with explicit authorized processing** and in an approved environment. Otherwise produce synthetic fixtures with at least:

- One org unit and 20–40 members.
- Multiple activities, expertise levels/domains and seniority/job-title attributes **only if present** (seniority can be a future additional attribute; it is not a fourth predicate in this MVP).
- People with multiple responsibilities, including a works-council/OR example.
- Conflicting or unconfirmed interview claims.
- Several existing application entitlements, inherited/direct grants, and existing roles.
- Non-user accounts or multiple accounts for one person where supported by current data.

---

## 3. UX: org-unit embedded authorization matrix

### Entry point

On the **existing Organizational Unit detail page**, add a distinct tab or section such as **Authorization Workbench** (final label can follow the app's UI conventions). Default scope is the selected org unit and its member population. Display scope and membership rules clearly (direct members vs descendants); do not require the analyst to reproduce that scope using the global matrix's filter machinery.

### Layout (functional, not a prescribed visual design)

1. **Context header:** org unit, member count, source freshness, any missing/contested organizational knowledge.
2. **Perspective / grouping controls:** `Activity`, `Expertise`, `Responsibility` first. Optionally `Existing role` or `Job title / Seniority` if those attributes already exist reliably. Keep sorting, grouping and filtering separate and composable when practical.
3. **Main matrix:** user/identity rows and entitlement/existing-role columns (or reuse the existing matrix orientation with a clear rationale). Cluster patterns should be visually recognizable. Include column headers that expose technical name, application/system, and whether the item is a role vs direct entitlement. Avoid double-counting effective access due to nested membership.
4. **Selection + classification:** analyst can select individual cells, whole rows/columns and contiguous rectangular ranges (mouse/keyboard where technically reasonable). Distinguish selected access evidence from proposed role **membership** and proposed role **entitlement composition**.
5. **Candidate model panel:** new candidate role or proposed extension to a known existing role; editable display name/description, target population and included entitlements. When modifying a known role, start from its observed composition but do not modify it in the source.
6. **Impact panel / overlay:** compare the observed state with the proposed state, separating confirmed or explainable observations from hypothetical assumptions. Keep the matrix visible while proposing changes, rather than sending the analyst to a disconnected wizard.

### Core user actions

- Open org unit and load matrix with organizational labels immediately.
- Group/sort by organizational dimensions without losing matrix selection or draft state.
- Inspect the evidence/source for a manager-provided activity, expertise or responsibility.
- Identify access clusters and select a subset of cells.
- Mark a selection as candidate role composition, unrelated-to-this-investigation, or needs-investigation. Classification is **context-relative**; unrelated access is not automatically invalid access.
- Select intended role recipients independently of the entitlements selected.
- Choose **Create candidate role** or **Propose update to existing role**, and adjust selections.
- See affected and unaffected identities, explained access and open questions.
- Reset/revert edits during the session. Explicitly distinguish unsaved draft from real role/assignment data.

### Deterministic proposal baseline

No autonomous role inference is needed. A sensible first proposal can be generated from analyst-selected rows/cells and the intersection or frequency of observed entitlements in that population, with sortable frequency and existing-role overlap. The analyst explicitly includes or excludes entitlements and chooses membership. Any ranking is transparent and reproducible.

### Semantics of matrix markings

Use labels/icons in addition to color; do not rely on color alone:

- **Observed access:** currently granted in source-system snapshot.
- **Explained by candidate:** observed access is covered by the candidate role *if assigned to this person*.
- **Potential gain:** access not currently observed but would be added if the candidate were implemented.
- **Potential loss:** access predicted to disappear **only if the proposed change explicitly removes/replaces a known source of access**, accounting for other effective grant paths. Otherwise say **not covered by candidate**, **possible removal requiring validation**, or **unknown**; don't claim definite loss.
- **Unexplained in this investigation:** observed permission not accounted for by the selected context/candidate, which is not itself a revoke recommendation.
- **Other context:** access linked to a separate activity/responsibility (e.g., OR), supported by evidence.

If the source data does not establish all grant paths or a removal operation is not yet modelled, indicate **impact unknown** rather than reporting definitive effective-access removal.

---

## 4. Role impact calculation

Keep **three independent notions** clear:

1. **Role definition/composition** — what entitlements belong to a role.
2. **Role membership/assignment** — which identities receive the role (possibly conditional on person/account mappings).
3. **Effective access** — the resulting permissions after direct grants, nested groups, other roles, policy enforcement and known application semantics.

For each intended member and entitlement, provide a deterministic comparison:

| Observed access | Access via candidate | Interpretation |
|---|---|---|
| Yes | Yes | Currently present; would be covered/explained by candidate |
| No | Yes | Potential addition |
| Yes | No | Remains outside this candidate; **not necessarily removed** |
| No | No | No change |

Simulate **actual losses** only when the user explicitly models the removal/replacement of an existing grant path and the engine has enough information to prove no alternative path exists. If not supported in MVP, show a documented limitation instead of presenting a deceptive red-cell loss prediction.

Capture snapshots and assumptions so users know the observed data may be stale; the UI is **read-only to live systems** in this milestone.

---

## 5. Scope boundaries

### In scope for Milestone 1

- Minimal queryable storage/adaptation for `performsActivity`, `hasExpertise`, `holdsResponsibility` with source attribution and evidence/status.
- Org unit page matrix using existing authorization retrieval/computation code wherever possible.
- Grouping, sorting and organizational annotations over matrix data.
- Analyst cell/range selection and candidate composition/membership editing.
- Deterministic, transparent impact overlay and handling of unrelated/unexplained access.
- Non-destructive local/session draft and reset. No persistence beyond the current session is required; it is acceptable if safe draft persistence already exists and can be reused without scope expansion.
- Tests, realistic synthetic fixtures and a runnable demo for the analyst.

### Explicitly deferred

- AI extraction from interviews or autonomous knowledge acquisition (existing capabilities may remain in place).
- AI-generated roles or LLM decision logic.
- Role proposal persistence, approval/version history and governed model lifecycle (Milestone 2).
- Real changes to source systems or provisioning workflow.
- Verification of eventual implementation against a later snapshot (Milestone 3).
- Full enterprise ontology; arbitrary workflow orchestration; redesign of the existing global matrix.

**Design for later extension without building it now:** record an intended structure for saved proposal, evidence links, decisions and target mappings; do not implement those features prematurely.

---

## 6. Acceptance criteria and tests

### Ontology and integration

- [ ] A manager-confirmed statement that *Person A performs Activity X* is queryable, attributed and visible on the org-unit page.
- [ ] The same is true for *has Expertise Y* and *holds Responsibility Z*.
- [ ] A person with multiple responsibilities displays correctly; an OR responsibility does not contaminate a primary-activity role suggestion.
- [ ] Conflicting or unverified claims are visible as such; no inferred claim silently becomes confirmed.
- [ ] Org-unit data loading does not trigger N+1 queries on a representative unit; document expected performance and test against the repository's realistic data sizes.

### Matrix / interaction

- [ ] Opening an org unit loads its matrix without user-defined filter setup.
- [ ] A user can group/sort by all three structured dimensions, including multiple/unknown values, without dropping the draft selection.
- [ ] Existing roles and effective entitlements are identifiable and not conflated.
- [ ] An analyst can select and classify cells/ranges; make a new candidate role or propose an update to an existing one.
- [ ] Changing intended membership and entitlement composition updates the impact immediately.
- [ ] The UI distinguishes an unexplained permission from an unsafe permission, and an uncovered observed permission from an actual loss.
- [ ] Existing global matrix functionality continues working unchanged.
- [ ] No action modifies a live identity, directory or IGA object.

### Demo test

Give an analyst (using a representative fixture) an organizational unit containing different business activities, expertise and additional responsibilities. Ask them to reproduce a portion of an Excel role-analysis exercise, change the grouping perspective, mark a candidate role, exclude OR-specific access, identify possible gains and uncovered access, and explain why no definite removals are implied. Capture their usability feedback and elapsed time; **do not call the milestone complete merely because tests pass**.

---

## 7. Claude Code execution instructions

### Phase A — Repo investigation (before coding)

1. Inspect `main`, web-app branches, **the complete stacked PR chain**, backlog/issue tracker, migrations, ontology, claim/evidence model, org-unit page and global matrix internals.
2. Output a *reuse / extend / new* map for every required capability, with concrete file paths, modules, PRs and branch commit identifiers.
3. Document the actual schema for organizational relationships, person↔account identity mapping, org membership and entitlement/role semantics. Identify missing endpoints/migrations.
4. Propose a concise wireframe or clickable local mock and user interaction sequence; reuse the established UI design system.
5. Flag conflicts between this brief and the existing code, and propose the smallest change that preserves consistency.

**Checkpoint:** Produce `docs/.../M1_DISCOVERY_AND_DESIGN.md` with decisions/unknowns and a clearly staged implementation plan. Ask for review on **material schema/semantic ambiguities**, not every coding choice.

### Phase B — Build thin slices in this order

1. Queryable relations + source/evidence retrieval, or adapters to existing relationship storage.
2. Org-unit scoped technical access matrix with labels.
3. Switchable organizational grouping and sorting.
4. Cell/range selections and classification; candidate membership/composition editor.
5. Deterministic impact overlay and edge cases.
6. Synthetic demo data, regression/performance tests, documentation, analyst walkthrough.

For each slice: tests first where practical, demonstrate it, update docs and keep PRs reviewable. Use AI-assisted coding aggressively; developer-week estimates are **not** acceptance criteria.

### Phase C — Refinement outputs

Produce or update the repo's existing backlog representation (do not duplicate tickets) with:

- Epic: **Organizational Authorization Workbench** (with the queryable-context foundation as an enabling feature/story, unless the existing backlog structure dictates another grouping).
- Features and stories for the slices above, each with acceptance criteria and dependencies.
- Mappings to existing/open PRs and issues (including which parts are already implemented or underway).
- Clear follow-on stories for **Milestone 2: Save/version/approve proposals**, and **Milestone 3: Compare approved proposal against observed implementation**; keep these out of M1 implementation.
- A short list of architecture decisions needing human approval.

Do not replace the complete backlog blindly or open duplicate GitHub issues without explicit authorization. Do not change customer environments or ingest customer evidence without approved access and processing scope.

---

## 8. Questions to resolve by inspecting real data/code

These are deliberately not speculative prerequisites requiring a meeting unless repository inspection cannot settle them:

- How is org-unit membership actually determined (direct, transitive, historical) and where is that logic owned?
- How are identities joined to people and their multiple technical accounts?
- Is organizational relationship knowledge already normalized/queryable on the current stacked demo branch, and do claim statuses/provenance survive the extraction pipeline?
- Does the matrix show assigned entitlements, effective entitlements or both, and what grant-path detail is retained?
- How are existing roles represented in the matrix, and can composition/assignment be reconstructed accurately?
- Is matrix virtualization required for the anticipated unit sizes?
- How should multi-valued grouping display people without distorting totals (single row plus labels, duplicated visual appearances with deduplicated counts, etc.)?
- Which distinct operations can be simulated safely without implying revocation or provisioning?

## 9. Success definition

**The milestone succeeds if an analyst can remain in the organizational-unit context and complete a genuine, comprehensible role-engineering investigation — explore access patterns by activity/expertise/responsibility, propose a role, edit its intended members and entitlements, and interpret projected coverage/gains/unknowns — without exporting to Excel or mistaking a hypothesis for a real permission change.**

The vision after this milestone is to persist and govern models (M2), then validate implementation and ongoing drift (M3). The first milestone should inform, not predetermine, those designs.
