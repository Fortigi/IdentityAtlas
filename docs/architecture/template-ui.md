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
| Workflow cards | The page has a workflows area built from a small registry (template → cards). **One card is built: "Download report".** Room for the role interview and owner survey later; not shown until built. |
| Actions | Two cards. **View in matrix** (every kind): an application or resource unit opens the matrix with its resources as columns and their holders as rows, grouped by department and folded when large; a unit of accounts or people opens it with its members as rows. **Download entitlement report** is on **applications only**: it runs the **Entitlement Pivot** (`application-access-review`) on the application itself. An organisational unit (of people, accounts or resources) gets View in matrix only — the report over a unit made no sense to readers there (decided 2026-10-20). The API still runs the Entitlement Pivot on a unit of accounts, from the report form. |
| Readiness dots | Not now. |
| Best guess | A suggested Accountable with its reason, and **Confirm** (sets the role) · **Reject** (remembered, never suggested again for that context) · **Choose someone else** (the existing picker). |
| Naming | Presentation-layer rename to People / Accounts is a **separate PR** stacked on this one. This PR already uses the words in its new screens. |

## 2. API

- `GET /api/contexts/:id/roles/suggestion` → `{ role: 'Accountable', principalId | identityId, displayName, reason, count, total }` or `204` when the context already has an Accountable, carries no roles (Segment, Tag), or has no signal. Signals, first that gives a candidate:
  - **People or accounts unit:** the manager of the most members (`Principals.managerId` / `Identities.managerIdentityId`), when they manage at least 40 % of the members. Reason: "manages 11 of the 14 members".
  - **Resource unit or logical application:** the account that owns the most of its resources (holders of the ControlPermission resources linked by `HasOwnership` / `HasAppOwnership`), at least 40 %. Reason: "owns 4 of the 6 resources".
  - A unit of one says "the only member"; a full sweep says "all 5 members".
  - A candidate rejected for this context is skipped.
- `POST /api/contexts/:id/roles/suggestion/reject` body `{ principalId | identityId }` → 204. Stored in `ContextRoleSuggestionRejections` (migration 093: `id`, `contextId` → Contexts cascade, `principalId` | `identityId` (exactly one), `role`, `rejectedBy`, `rejectedAt`; unique per context + holder + role). Interim: moves into claims (POC step 2) when that lands.
- Confirm is the existing `PUT /api/contexts/:id/roles` (Accountable).
- OpenAPI entries for both routes. Permissions: read `data.read`, reject `data.write.contexts`.

## 3. UI

- `ContextsPage`: sub-tabs per template (counts from the roots list); Organisation tab gets the kind switch and shows only roots of that targetType; Applications lists LogicalApplication roots; Tags and Segments render today's tree unchanged.
- Profiles (`contexts/profiles/`): per template, the facts shown first and the vocabulary. Organisational unit: Accountable (with best guess), Responsible, Members, Sub-units, **Variants of this unit**. Application: Owner (Accountable, with best guess), Responsible, Resources, Variants (rare). Tag and Segment: today's detail.
- Workflows area: `contexts/workflows/registry.js` maps a template to cards; the only card besides View in matrix is `DownloadReportCard` (see §1), registered for LogicalApplication only. It opens the report the way the Reports page does (reuse its run/download code), with `contexts = [the application]`.
- Best guess: shown inside the Accountable fact when there is no Accountable — name, reason, **Confirm**, **Reject**, **Choose someone else**.
- No readiness dots.
