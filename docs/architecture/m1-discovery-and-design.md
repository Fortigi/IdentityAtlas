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
- **Saved** with the investigation (migration 108): `RoleProposals.assignmentKind`, `membershipRule`
  (jsonb), `joinerPolicy`, `leaverPolicy`, `approver` (jsonb), `rationale`; "always exclude" people as
  `RoleProposalMembers` with `kind = 'exclude'`.

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

## M2a — save and reopen

The first slice of Milestone 2: an analyst saves the workbench as an **investigation** on the unit
and opens it again later. No review, approval or versions yet (M2b), but the tables are shaped
for them.

**What is saved** (migration 107):

| Table | Holds |
|---|---|
| `WorkbenchInvestigations` | One saved session on a unit: name, description, the view (people columns, filters, sort, sub-units in or out, column threshold), when the access data on screen was read, who saved it and when. Unique name per unit (case and spaces ignored). Org-wide, like saved matrices. |
| `WorkbenchAccessSnapshots` | The held cells on screen at the last save (`person\|resource\|type`), kept apart so the history trigger does not copy them on every save. |
| `WorkbenchMarks` | Person × resource × mark (`other` / `unrelated` / `investigate`), an optional note, who marked it and when. |
| `RoleProposals` | Each proposed role: name, description, the business role it updates (if any), its place in the list, `status` (`draft` only for now) and `version` (1 for now). |
| `RoleProposalMembers` / `RoleProposalEntitlements` / `RoleProposalEvidence` | The people it is for, what it would contain, and the claims it rests on. |

**Decisions**

- **A proposed role is never a `Resources` row.** As a business role it would show up in the
  matrix, reports and counts as if it existed. Updating an existing role only points at it
  (`baseBusinessRoleId`, set to null if that role disappears).
- **People and resources carry no foreign key.** A full sync can delete an identity (that is how the
  demo unit once went empty); a saved investigation must then keep its rows and say "no longer
  found", not silently lose them. A person is the workbench's own row key: an identity, or an
  account linked to no identity.
- **A save holds the whole draft.** A mark or proposed role the draft no longer holds is removed;
  one proposed role can also be deleted on its own (`DELETE …/proposals/:id`). An unchanged mark
  keeps who made it; an unchanged proposed role keeps its `updatedAt`; a proposed role keeps its id.
- **No silent overwrite.** A save sends the `updatedAt` it opened; when someone saved since, it is
  refused (409) with who did. The analyst can save under another name.
- **Reopening never blocks on changed data.** The workbench compares the saved snapshot with the
  access data on screen and says how many cells differ ("held then and not now", "held now and not
  then", "held another way"); marks and proposed roles stay as saved.

**API** (needs `data.write.contexts`, like the workbench): `GET|POST
/api/contexts/:id/workbench/investigations`, `GET|PUT|DELETE /api/workbench/investigations/:id`,
`DELETE /api/workbench/investigations/:id/proposals/:proposalId`.

**UI:** a strip under the workbench header shows the state ("Nothing to save yet", "Not saved",
"Saved as …", "Unsaved changes to …") with **Save**, **Save as…** and **Open…** (the unit's saved
investigations with who saved them, when, and when their access data was read; opening one over
unsaved work and deleting one ask first). The proposed-roles badge says *not saved*, *saved* or
*unsaved changes*.

## Proposed roles in the matrix

Next to the lens switch (All / Governed / Non-governed / Gaps) the Matrix has a toggle, **+ Proposed
roles**. It is not a lens: it adds the saved proposed roles **on top of** whichever lens is chosen,
and that lens shows exactly what it shows without the toggle (decided 2026-10-29).

- **Who sees it:** someone with `data.write.contexts`, outside a shared view, while organisation
  knowledge is on.
- **Off:** the Matrix is exactly as before.
- **Session only:** the toggle is session state in `app/MatrixArea`. It is not part of the matrix
  definition, so a saved or shared matrix never carries it.

With it on (`matrix/ProposedMatrix`):

- Each saved proposed role is a band **"Draft: <name>"** under the category *Proposed*, in its own
  colour. The cells it covers take that colour (the matrix's own `describeCell` / `MatrixCell`).
  A member who lacks one of its entitlements shows as the matrix's provisioning gap.
- **The lens filters stay real.** Governed and Non-governed still decide from the real
  business-role coverage (`managedByPackages`). The proposals' cells reach only the colouring
  (`extraCoverage`, merged into the colour map by `buildManagedApMap`).
- In Non-governed, where the business-role bands are hidden, the Draft bands still show
  (`bandsForLens`). In Gaps, a proposed role's provisioning gaps show like a business role's.
- **The Draft columns come last,** after every real business role (categorised or not), and the real
  ones keep their order (`compareAccessPackages`). Where the drafts start there is a gap with a faint
  dashed line, and "Proposed" in the band above them (`isProposedStart`, `PROPOSED_GAP_CLASS`), in
  the band, names row and body cells alike so the columns line up.
- The real business roles keep their bands and colours, so an overlap with what is already governed
  shows.
- The rows are the view's own; the toggle reads no rows. Members of a proposed role who are not in
  the view are not added.
- **Who it reaches is computed now.** A rule-based role's saved rule runs on the unit's current
  people (the workbench's own `effectiveMembers`), plus always-include minus always-exclude. A
  requestable role uses its saved members.
- **From investigation** picks one saved investigation (unit, saved by, date) or all of them.

**API** (needs `data.write.contexts`): `GET /api/workbench/investigations` lists every saved
investigation holding a proposed role, any unit. Read-only. The toggle adds to the view's own rows,
so it needs no rows of its own. A "members outside this view" option would need an endpoint for
those accounts' rows; it is not built.

## People as columns (the matrix's orientation)

With people as rows, someone holding 100+ groups means an endless horizontal scrollbar. That is
why the global matrix puts resources on the rows and people on the columns. The workbench now
opens that way too. **People as rows** stays one click away, and the choice is saved with the
investigation's view as `orientation`.

Only the layout changes (`workbench.transposed.js`, `WorkbenchColumnsGrid`). The cells are still
person × resource, so the following work the same in both orientations: selection (click,
Shift-click rectangle, Ctrl/⌘-click), marks, the candidate, rules, impact and save.

- **Rows:** each business role of the band — the unit's roles, then the proposed ones as
  "Draft: …" — in its matrix colour, with its entitlements nested under it, then "Other
  access".
  - A role row folds.
  - A role lists every entitlement of it the unit knows. Even a rarely held one shows, so the
    threshold and *Find access* narrow only "Other access".
  - A resource two roles contain shows under each.
- **Columns:** the people shown (filtered, sorted).
  - The chosen people columns become header rows above them, the display name last, next to the
    cells as in the matrix.
  - Each header row's label has the same sort and Excel-like filter.
  - A narrow cell shows the first value written upwards: knowledge with ✓/?/!, then "+N".
    Hovering lists all values; a click opens their evidence, with Confirm / Reject.
  - A header row nobody has a value in stays one line high.
- **Grouping** (*Group by*) is a people-as-rows feature, so it is hidden with people as columns.
- The rows are virtualised with TanStack Virtual, as the matrix's are.

The grid reuses the matrix's `MatrixCell` and colours. It does not reuse `MatrixGroupRow` or
`SortableMatrixBody`. Those carry the global matrix's own state (nested-group expansion, drag
order, fold tallies), and threading the workbench's selection and marks through them would put the
global matrix at risk.

### One scrollbar: the page's

The page scrolls; the workbench grid has no vertical scrollbar of its own (decided with Wim
2026-10-29, after a first version sized the grid to the window and left room for one row under the
header rows).

- **Header:** the grid's header rows stick to the top of the window as the page scrolls
  (`PageStickyTable`).
- **Wide grids:** a grid wider than its column scrolls sideways inside itself. A box that scrolls is
  what a sticky header sticks to, so the header lives in a strip of its own above the body.
  - The strip uses the same fixed column widths, clipped sideways (`overflow-x: clip`, so the
    filter menus and popovers that open from it are not cut off).
  - It moves with the body's horizontal scroll; its row labels move back, so they stay put.
  - With people as columns, the five permission columns stay in place too.
- **Virtualisation:** rows are virtualised against the page (`usePageVirtualRows`, TanStack's
  window virtualiser).
- **The candidate panel** sticks to the top of the window beside the grid, and scrolls within itself
  only when it is taller than the window.
- **Header rows about people** are as tall as their longest value needs, within tight limits
  (`headerRowHeight`: values up to 44px — the ✓/? mark and the first few characters — names up to
  88px); the whole value shows on hover. A row nobody has a value in is one line.
- **Measured** (Fortigi *Members*, people as columns): 26 permission rows in view without scrolling
  at 2254×1351, 16 at 1920×1080, 4 at 1366×768. Once scrolled the header sits at the top of the
  window and 20+ rows show.

### Filtering the permissions

The permissions shown are filtered the way the people are (`workbench.permissions.js`): an
Excel-like filter and sort on each of the matrix's row cells — Resource name, Contexts, Type,
System, Held by — AND across columns.

- **Contexts** are the tags and logical applications a resource belongs to (`ContextMembers`).
  - The workbench API returns them per column (`columns[].contexts`, the matrix's own join,
    `matrix/resourceContexts.js`), plus those contexts with every parent (`contexts`, recursive
    on `parentContextId`).
  - A context takes its sub-contexts: choosing a logical application also takes the resources in
    its modules.
  - The filter goes both ways: **Only these**, or **Hide resources in these** (e.g. everything
    tagged "Default access").
- **Held by:** "Access held by at least N" stays, plus **at most** (outliers), with **Hide
  permissions only one person holds** as the at-least-2 preset.
- **Business roles:**
  - An entitlement the filters hide is not under its role either. A role whose entitlements are
    all hidden says "(all hidden by filters)".
  - A *proposed* role keeps all of its own, the hidden ones last and marked "hidden by filter".
    Nothing is silently dropped from a proposal.
- **Impact** counts only what is shown, and says "N permissions hidden by filters — not counted".
- The filters, the permission sort and the held-by range are part of the saved view
  (`permissionFilters`, `permissionSort`, `maxHolders`).
- With people as rows the permissions are columns, and the same filters sit behind a
  **Permissions** menu in the toolbar.

## Proposed roles on the unit page

An analyst's unit page shows the same saved proposals. It reads them from the existing
investigation endpoints, so no new API.

- The **Authorization workbench** button carries "N proposed".
- A **Proposed roles** fold ("3 in 2 investigations") lists each saved proposed role with:
  - its colour (the workbench's band index: the unit's existing roles first);
  - its name and kind;
  - its rule as one sentence, or "chosen by hand";
  - the people it reaches now and its entitlements;
  - the investigation, who saved it and when.

  The rows are read only when the fold is opened. Only this unit's investigations are listed, not
  a sub-unit's.
- A row opens the workbench on `#workbench:<unit>:<investigation>:<proposed role>`
  (`workbench.link.js`). The workbench opens that investigation once and puts that role in the
  panel.

**What we know agrees with the workbench.** The workbench finds activity, expertise and duty claims
by *person*. The unit page used to read only the claims filed *on the unit*. An interview held on
the parent unit names what the people of a sub-unit do, so the sub-unit's page said "Nothing
recorded yet". `GET /api/contexts/:id/claims` now also returns the knowledge claims about the
unit's members, wherever filed:
- the members' identities and accounts, each widened by the identity ↔ account links;
- members removed by an override are left out;
- each such claim names where it was filed (`filedUnderName`).

What we know counts and lists them, and a proposed one is reviewable there. The People and
Timeline loaders are unchanged.

## Deferred (Milestone 2 / 3)

- **M2b:** review, approve and version a proposed role (`status` beyond `draft`, `version` beyond
  1, a compare between versions), export it, and optionally raise a change request to the IGA
  system once approved.
- **M3:** compare an approved proposal with a later snapshot (implemented as proposed? drift?).
- A computed first proposal of entitlements (e.g. what at least half of the members hold): tried and
  taken out — the analyst selects entitlements. Revisit with real analyst feedback.
- Removal simulation with grant-path proof; keyboard range selection; virtualised grid for very
  large units.
