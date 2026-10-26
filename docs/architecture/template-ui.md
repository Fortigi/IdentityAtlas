# Template UI — option A (working spec)

> Status: in progress on `feature/template-ui`, stacked on `feature/context-templates` (#1404).
> Draft; not to merge before the demo. Decisions by Wim, 2026-10-20, on the
> clickable mockup "Template UI Mockups" (option A, refined).

Every context now has a template (OrganizationalUnit, LogicalApplication, Tag,
Segment). This gives each template its own screen inside Contexts, and the room
for the workflows that start from a context, with one of them built now.

## 1. Decisions

| Topic | Decision |
|---|---|
| Layout | **Option A**: the Contexts page gets a sub-tab per template — Organisation · Applications · Tags · Segments. Tags and Segments keep today's generic tree. |
| One kind of member | Unchanged rule: a context holds one kind of member. In Organisation, a switch shows one tree at a time: **People** (identities), **Accounts** (principals), **Resources**. Nothing is merged. |
| Unit variants | A unit that exists as several variants (people, accounts, resources — a project, a team, a customer) shows them together through `SameUnitAs`: a variant switch on the detail page ("Contoso · People 12 · Accounts 15 · Resources 31"); each variant opens its own context. |
| Workflow cards | *Superseded 2026-10-26 (readability):* no card grid. The actions moved to the page header — see [§4](#4-the-page-of-a-unit-or-an-application). |
| Actions | *Superseded 2026-10-26:* the cards became the header's **Download report** and the ⋯ menu's **View in matrix** (§4); a unit of accounts or people got its unit report since. The original decision: two cards. **View in matrix** (every kind): an application or resource unit opens the matrix with its resources as columns and their holders as rows, grouped by department and folded when large; a unit of accounts or people opens it with its members as rows. **Download entitlement report** is on **applications only**: it runs the **Entitlement Pivot** (`application-access-review`) on the application itself. An organisational unit (of people, accounts or resources) gets View in matrix only — the report over a unit made no sense to readers there (decided 2026-10-20). The API still runs the Entitlement Pivot on a unit of accounts, from the report form. |
| Readiness dots | Not now. |
| Best guess | A suggested Accountable with its reason, and **Confirm** (sets the role) · **Reject** (remembered, never suggested again for that context) · **Choose someone else** (the existing picker). |
| Naming | Presentation-layer rename to People / Accounts is a **separate PR** stacked on this one. This PR already uses the words in its new screens. |

## 2. API

- `GET /api/contexts/:id/roles/suggestion` → `{ role: 'Accountable', principalId | identityId, displayName, reason, count, total }` or `204` when the context already has an Accountable, carries no roles (Segment, Tag), or has no signal. Signals, first that gives a candidate:
  - **People or accounts unit:** the manager of the most members (`Principals.managerId` / `Identities.managerIdentityId`), when they manage at least 40 % of the members. Reason: "manages 11 of the 14 members".
  - **Resource unit or logical application:** the account that owns the most of its resources (holders of the ControlPermission resources linked by `HasOwnership` / `HasAppOwnership`), at least 40 %. Reason: "owns 4 of the 6 resources".
  - A unit of one says "the only member"; a full sweep says "all 5 members".
  - A candidate rejected for this context is skipped.
- `POST /api/contexts/:id/roles/suggestion/reject` body `{ principalId | identityId }` → 204. Stored in `ContextRoleSuggestionRejections` (migration 095: `id`, `contextId` → Contexts cascade, `principalId` | `identityId` (exactly one), `role`, `rejectedBy`, `rejectedAt`; unique per context + holder + role). Interim: moves into claims (POC step 2) when that lands.
- Confirm is the existing `PUT /api/contexts/:id/roles` (Accountable).
- OpenAPI entries for both routes. Permissions: read `data.read`, reject `data.write.contexts`.

## 3. UI

- `ContextsPage`: sub-tabs per template (counts from the roots list); Organisation tab gets the kind switch and shows only roots of that targetType; Applications lists LogicalApplication roots; Tags and Segments render today's tree unchanged.
- Profiles (`contexts/profiles/`): per template, the vocabulary (`profiles.js`: the Accountable's name — an application's is its Owner —, the noun, the label of its members) and the variants of the unit.
- Best guess: shown inside the Accountable fact when there is no Accountable — name, reason, **Confirm**, **Reject**, **Choose someone else**.
- No readiness dots.

## 4. The page of a unit or an application

Decided 2026-10-26 (readability review): one column of sections, each person once, the
actions in the header. `ContextDetailPage.jsx` → `contexts/page/ProfileBody.jsx`.

1. **Header** (`ContextDetailHeader.jsx`): the breadcrumb, the name, one sentence on what it
   is, and **who answers for it** inline under it — Accountable and Responsible
   (`ContextPeople.jsx`, with the best guess and the interview suggestions; the role's meaning
   on hover). No Owner chip: an owner the source names but nobody matches reads *"The source
   names “…” as the owner; no account found."* while no Accountable is set. Actions:
   **Download report** (the main button, for everyone — an application's entitlement report,
   a unit of accounts or people's unit report; `contexts/header/headerActions.js`), **Add
   information** (an analyst; see [Context interviews](context-interviews.md#sources-and-add-information)),
   and **⋯** (`contexts/header/MoreMenu.jsx`): View in matrix ↗, Adjust tree, Edit search
   terms, Edit, Add sub-unit, Copy link, Open as page, Back to Contexts — each where it
   applies.
2. **Attention line** (analysts): *"2 to decide · 13 to review · 1 to correct in the source"* —
   to decide filters People to *To decide* (or opens What we know for a contradiction about the
   unit), to review opens the review drawer, to correct opens Change requests.
3. **People** (`contexts/people/PeopleSection.jsx`): the People overview — each person once,
   with status, role, sources, access and the claims as icons; filters Current · Former · All
   (and To decide). See [Context interviews → The People overview](context-interviews.md#the-people-overview).
   An application keeps its **Resources** list (the members table) and shows People only when a
   source named someone.
4. **What we know** (folded to one line): the unit's own facts — description, properties, also
   known as, the unit as other kinds of member, More details — and, for an analyst, its own
   claims to review.
5. **Sources** (analysts, folded): everything added, with *Add information*.
6. **Change requests** (analysts, folded, only when there are any).
7. **Sub-units**.
8. **Timeline** and **Risk** (analysts, folded, at the foot).

The **business view** (no `data.write.contexts`, or a context owner's read-only page) gets the
header with Download report, who answers for it, People (Former included), What we know and the
sub-units: no Add information, no attention line, no review buttons, no Sources, no Timeline;
confirmed claims only. A read-only shell has no ⋯ menu (nothing in it is theirs to open).
On a narrow screen a person's row is a two-line card: the name, the roles and the status, then
the role, the sources, the access and the claim icons.

Contexts without a template (Tags, Segments) keep the generic page: the header, the
description, More details, the sub-units and the members table, and the Timeline for an analyst.