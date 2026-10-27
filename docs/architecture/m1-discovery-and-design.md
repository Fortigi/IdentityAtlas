# Authorization workbench — Milestone 1 design

> **Status:** proof of concept (draft PR, stacked on the context-readability PR). Built from the
> [Milestone 1 brief](m1-brief.md). This page records what was reused, what was added, the
> decisions taken without a review round, and what is left open.

## What it does

An analyst opens an **organizational unit**, clicks **Authorization workbench**, and gets a
full-width tab (`#workbench:<unit id>`) with:

- the unit's **people** (one row per person, every linked account folded in; an account nobody
  linked is its own row) and what they **hold** (the matrix's own data);
- what is known of their work — the **activities** they perform, their **expertise** and the
  **duties** they hold beside it — as chips with their status (✓ confirmed, ? proposed, ! disputed)
  and, on click, the evidence: source, quote, who decided;
- one row per person, with **Excel-like columns** on the left (name, job title, chosen system data, activity, expertise, duty): **filter** any column by its values (a multi-value column keeps a row when any value is ticked; proposed values can be left out; filters combine with AND), **sort** by a header, and take the people shown into the candidate in one click; grouping is optional;
- **select** cells (click, Shift-click for a rectangle, Ctrl/⌘-click to add; a person, a group or a
  column header selects what they hold) and **mark** them: other context, unrelated here, needs
  investigation;
- a **candidate role** — new, or a proposed update to a business role the unit already holds —
  with members and entitlements chosen separately, a deterministic first proposal (columns at least
  50 % / 75 % / all of the members hold, minus what was marked other context or unrelated), and
- the candidate shown as **Draft** in the matrix's business-role band, every cell the matrix's own
  (MatrixCell): covered = the role's colour, potential gain = its provisioning gap, a candidate
  entitlement a non-member holds = held outside; plain = outside the candidate. Never "loss".

Nothing in the workbench changes access or is saved. The candidate lives in the browser tab.

## Reuse / extend / new

| Capability | Reused | Extended | New |
|---|---|---|---|
| Relations person → activity / expertise / duty | Claims store (`ContextClaims`, `ContextInterviews`): status, quote, source, who proposed / decided, history trigger | Three claim kinds `activity`, `expertise`, `duty`; column `objectContextId` (migration 106) | — |
| Canonical objects | `Contexts` (manual, template Tag, people as members) | Context types `Activity`, `Expertise`, `Duty` under one root each (ontology 2.3.0) | `contexts/orgKnowledge/objects.js` (find by name or alias, else create) |
| Extraction | "Add information" pipeline (rule layer + model) | Prompt asks for the three kinds; `claims.js` checks them; relevance always high | — |
| Decide | `PATCH /contexts/claims/:id` (`decide.js`) | Confirming a knowledge claim names its object; undo allowed | — |
| Analyst's own link | — | — | `POST /contexts/:id/knowledge` (source: the unit's "Analyst notes") |
| Query | — | — | `GET /org-knowledge/objects`, `GET /org-knowledge/objects/:id/people` |
| Unit membership | `ContextMembers`, `ContextMemberOverrides` (a decided former member is out), the sub-unit tree | — | — |
| Person ↔ accounts | `IdentityMembers` | — | — |
| Access | `vw_ResourceUserPermissionAssignments` (Direct / Indirect / Eligible, materialized), `vw_UserPermissionAssignmentViaBusinessRole` | — | `contexts/workbench/load.js` + `model.js` (one cell per person and resource) |
| Existing roles | `Resources.governanceResource`, `ResourceRelationships` `Contains` | — | — |
| UI | Detail tabs, auth fetch, tokens, dark mode | Unit header button | `components/workbench/*` |

The global matrix is not touched.

## Schema decisions

1. **Relations are claims.** A link "Bram holds *Works council member*" is a `ContextClaims` row of
   kind `duty`, subject the person (identity or account), value the name, `objectContextId` the
   object. One store for everything a source says, one review flow, one history. A claim never
   creates access and never changes `ContextMembers`.
2. **Objects are contexts.** `Activity`, `Expertise`, `Duty` contexts (manual, template Tag,
   targetType Identity) under roots marked `extendedAttributes.knowledgeRoot`. They are browsable
   and renamable on the Contexts page. A proposed claim may not name an object yet; confirming it
   finds one by name (case and spacing aside, or an alias) or creates it.
3. **"Duty", not "responsibility".** The brief's `holdsResponsibility` is called **duty** in code
   and on screen, so it is never read as the ContextRole **Responsible** (who does the day-to-day
   for a unit or an application). The ontology keeps the brief's predicate names in each kind's
   description (`performsActivity`, `hasExpertise`, `holdsResponsibility`).
4. **Link state** is read from all claims about one (person, kind, name): *confirmed* (someone
   confirmed it, nobody rejected it), *disputed* (confirmed or proposed by one source, rejected for
   another), *proposed* (only proposed), *rejected* (only rejected — not shown in groups).
5. **Multi-value columns.** One row per person; a person with two activities has two chips, and a
   filter keeps the row when any value is ticked. People with nothing known show as **(Not known)**
   in the filter — missing is never negative evidence. Optional grouping shows a person under each value.
6. **Scope.** The unit and, by default, its sub-units (toggle). At most 400 people and 300 columns
   (most held first; a unit with more than 120 columns opens on columns at least two people hold).
7. **Read cost.** Eleven statements whatever the unit's size (`load.test.js` pins the list); about
   25 ms for a 9-person unit with 500 held resources on the demo box.

## How a proposed role is assigned

Every new proposed role first asks its **kind** (two cards; changeable later):

| Kind | Members | Rule means | Joiners | Leavers | Assignment `origin` |
|---|---|---|---|---|---|
| **Rule-based — assigned automatically** | computed from the rule (+ always include − always exclude); without a rule, chosen by hand | who holds it | add automatically / ask for approval | remove automatically / ask for review / keep | `Automatic` |
| **Requestable — people request it and someone approves** | chosen by hand: the *expected initial holders* | who may request it (optional) | — (a request) | on leaving the unit: remove / review / keep | `Requested` |

- **The rule is the workbench's filters.** Scope = the unit, with or without its sub-units; conditions
  = the column filters (AND across columns, ANY ticked value or "contains" text within one; none =
  everyone in scope). "Use these filters as the role's rule" copies them. The rule shows as one
  sentence ("Everyone in Property Claims and its sub-units whose job title contains “handler” or is
  Team lead Property — added automatically, removed when they no longer match"), with "matches now: N"
  and "would also apply to people who join the unit later".
- **Approver** (requestable): the unit's Accountable, the role's owner, or a named person (the context
  role person picker).
- **Rationale**: a free-text "why this role".
- **Implementability**: a condition on activity, expertise or duty rests on Identity Atlas knowledge the
  IGA system does not hold — noted ("can't be enforced automatically there"), not blocked. Job title,
  department and unit conditions are source data.
- **Vocabulary.** This is the role's *assignment rule*, the counterpart of the governance model's
  `AssignmentPolicies` (Entra access-package auto-assignment policy → rule-based; a request policy →
  requestable; Omada assignment policy). A *Propose update* of an existing role prefills the kind from
  its crawled policies (`policyKind`: an auto-add rule → rule-based, a policy without one → requestable),
  else asks. Proposals never write to `AssignmentPolicies` (crawled data).
- Nothing is enforced anywhere; the impact overlay shows the active role's computed members.

## Impact semantics

| Observed | In candidate (member) | Shown as |
|---|---|---|
| yes | yes | **Covered** — the candidate would explain it |
| no | yes | **Potential gain** — the candidate would add it |
| yes | no | **Outside the candidate** — not a removal; other grants may keep it |
| yes | marked | **Other context / Unrelated here / Needs investigation** |
| yes | — (not a member) | held, unchanged |

Removing access is not modelled in M1: the panel says so ("impact unknown") instead of predicting
a loss. When a candidate updates an existing role, the panel lists what it adds to and leaves out
of the role's composition; holders may keep what is left out through other grants.

## Demo data

`tools/demo-workbench/workbench-fixture.sql` loads a fictional insurer ("Northwind Insurance
(synthetic)"): a Claims Handling unit of 26 people in two teams, two systems, an existing business
role held by 8 of 12 motor handlers, a person with two accounts, a manager interview whose claims
are confirmed, proposed and disputed, and two works-council members whose works-council access must
stay out of a claims role. Idempotent; it touches nothing else.

## Open questions for review

1. Should a confirmed link also add the person as a **member** of the object context, so the
   global matrix can filter by activity through the existing context filters? (Not done: two
   mechanisms for one fact.)
2. Is **duty** the right word in Dutch and English UI ("nevenfunctie", "extra taak")?
3. Should job title / seniority be a fourth dimension in the ontology, or stay a source attribute?
4. Who may see the workbench: analysts only (now `data.write.contexts`), or also a unit's
   Accountable?

## Deferred (Milestone 2 / 3)

- **M2:** save, version and approve a candidate (a `RoleProposals` record holding name, members,
  entitlements, the marks with their reasons, the evidence links and the snapshot time).
- **M3:** compare an approved proposal with a later snapshot (implemented as proposed? drift?).
- A computed first proposal of entitlements (e.g. what at least half of the members hold): tried and
  taken out — the analyst selects entitlements. Revisit with real analyst feedback.
- Removal simulation with grant-path proof; keyboard range selection; virtualised grid for very
  large units.
