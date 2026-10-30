# Context-owner access

A department's manager or an application's owner usually has no Identity Atlas
role, yet they are exactly the person an access review is held with. Context-owner
access lets them sign in with their normal Microsoft account and land on **their
own context** — nothing else. It is the same idea as
[sharing a matrix](../ui/sharing-a-matrix.md), without a link: the owner simply
opens Identity Atlas.

## Relative permissions

Context-owner access is one of two **relative permissions**: access somebody
gets because of how they relate to the data, rather than because they hold an
Identity Atlas role. Both are read-only and limited to the data the person
relates to:

| Kind | Relation to the data | Decided by |
|---|---|---|
| Context owner | Accountable or Responsible for a context | The admin switch below, then the `ContextRoles` rows |
| Matrix-share recipient | A saved matrix was shared with them | Whoever shares the matrix, per share ([Sharing a matrix](../ui/sharing-a-matrix.md)) |

The admin page groups them under **Relative permissions**. Matrix sharing has
no setting there and its behaviour is unchanged. Today the two are enforced
separately: a context owner by the allow-list on this page, a share recipient
by the share itself. A single data-level scope that matrix shares and the MCP
server could also run under — "this caller may see these principals and
resources" rather than "these endpoints" — is a later, separate track
([#1105](https://github.com/Fortigi/IdentityAtlas/issues/1105)).

## Turning it on

**Admin → Authentication → Authorization → Relative permissions → Context
owners** (needs `admin.auth`). Off by default. The setting is stored in
`WorkerConfig` as `CONTEXT_OWNER_ACCESS` and takes effect on the next request;
no restart.

API: `GET` / `PUT /api/admin/context-owner-access` with `{ "enabled": true }`.

## Who qualifies

A signed-in user qualifies when **all** of these hold:

- authentication is enabled and the switch is on;
- they would otherwise have no access: their Entra app roles map to **no
  permission**, or they lack a role listed in `AUTH_REQUIRED_ROLES`;
- they are matched to our data (`auth/resolveMe.js`: token `oid` = account id,
  else a unique email match), and a `ContextRoles` row (`Accountable` or
  `Responsible`) names their account, their person (Identity), or another account
  linked to that person.

Somebody who holds any real permission is **not** affected: they keep the
ordinary app, unscoped. Somebody who qualifies on everything except holding a
context role gets exactly today's behaviour (the roleless read, or the
`AUTH_REQUIRED_ROLES` 403).

## Their scope

The contexts an owner may open are:

1. **the contexts they hold a role on** — Accountable and Responsible count the
   same;
2. **the sub-units below those** (descendants through `parentContextId`, to any
   depth) — **except** a sub-unit that has an Accountable or Responsible of its
   own. That sub-unit is somebody else's, and so is everything below it: the
   walk stops there. If the same person also holds a role on that sub-unit, it
   is in scope as one of their own contexts (point 1), with its own sub-units;
3. **the variants of the contexts they hold** (`SameUnitAs` — the same unit as
   people, accounts or resources). A sub-unit's variants are not added.

| Example tree | Ann is Accountable for Finance | In Ann's scope |
|---|---|---|
| Finance | (Ann) | yes — held |
| ├ Accounts payable | no roles | yes — sub-unit |
| │ └ AP team North | no roles | yes — sub-unit |
| └ Treasury | Bob is Responsible | **no** — Bob's |
| &nbsp;&nbsp;└ Treasury ops | no roles | **no** — below Bob's |

The scope is computed on every request (`auth/contextOwner.js`
`findOwnedSubUnits`, a recursive walk with a cycle guard), so adding a role on a
sub-unit takes it out of the parent owner's scope immediately.

## What they can see

| Request (GET only) | Allowed when |
|---|---|
| `/api/auth-me`, `/api/features`, `/api/version`, `/api/preferences`, `/api/attribute-labels` | always (the app shell) |
| `/api/contexts/:id`, `…/members`, `…/roles`, `…/relationships`, `…/claims` (confirmed claims only), `…/timeline` | `:id` is in scope |
| `/api/contexts/:id/members/:memberId/references` | `:id` is in scope **and** `:memberId` is a member of `:id` itself (checked against `ContextMembers`; an id from another context, or from one of this context's sub-units, is refused) |
| `/api/risk-scores/contexts/:id` | `:id` is in scope |
| `/api/reports/application-access-review/export` | `contexts` lists only in-scope ids, and every context those values resolve to is in scope; the `applications` alias and names are refused |
| `/api/reports/unit-members/export` | the same `contexts` check; `includeSubUnits` is refused in any form (even `false`) — the owner downloads per sub-unit, from that sub-unit's own page |

Everything else — any other path, and every non-GET — answers
`403 { "error": "Context owners can only open their own context" }`.

### A member's references — names only

For each member of a context in scope, the owner can see what that member is
directly tied to:

| Member | Groups shown |
|---|---|
| An account or a person | **Groups & resources** they hold (with the assignment type: Direct, Indirect or Eligible), **Business roles** they hold, **Other contexts** they are in. A person's are read through the person and every linked account, once per resource and assignment type |
| A resource | **Held by** — accounts by name and type, or a person where the assignment was made to the person; **Business roles** that contain it; **Other contexts** it is in |
| A system | **Other contexts** it is in |

The answer is a *reference projection*
(`contexts/memberReferences.js`): every item is a display name plus the few
words needed to read it — resource type, system name, assignment type, holder
type, context type. **It carries no ids.** There is nothing in it to follow, and
the detail endpoints of the referenced objects stay off the allow-list: an owner
sees that a member holds "Finance-Admins", not "Finance-Admins" itself.

Each group lists at most **50** names, alphabetically, with the true total
(the page says "+ 1,234 more"). Everything is shown; nothing is held back by
sensitivity today. Leaving out references by tag (for example a "Sensitive" tag
context) is a possible later step.

The endpoint is open to every ordinary reader as well; only the owner's page
shows it, as an expandable member row.

## The owner's page

In the UI an owner gets a bare page (no main navigation): their context
directly, or a list on the left when they hold several. The page is the
ordinary context page in its business (reading) view, read-only: no Edit, no
role pencils, no suggestion, no member editing, people and member pages not
linked, no Copy link or Open as page.

- **Sub-units** in scope open in place; a sub-unit with an owner of its own is
  plain text. The **breadcrumb** names the direct parent without reading it, and
  opens it in place when it is in scope (a sub-unit's way back up).
- A **variant** opens in place only when it is in scope.
- Each **member** expands to its references, grouped and as plain text. Not
  while *Include sub-units* is on: those rows are members of the sub-units, and
  the API answers only for a context's own members.
- The Actions area drops **View in matrix**, which the owner cannot open, and the
  "Coming soon" survey and review cards, which are the analyst's to start; it
  keeps the report downloads, which run on the context itself: **Download
  entitlement report** on an application and **Download unit report** on a unit
  of accounts or people. A unit of resources therefore shows no Actions to its
  owner.

`contexts/ContextOwnerScopeContext.jsx` carries the scope into the page;
`components/contexts/contextOpener.js` decides which sub-units and parents are
links.

## Enforcement

Enforced by the API, not the UI:

- `middleware/auth.js` hands a validated caller with no access to
  `middleware/contextOwnerMode.js`, which decides once per request (the
  middleware runs at every router mount) and fails closed with a 500 if a
  lookup errors.
- `auth/contextOwnerScope.js` is the allow-list — a table, so a route added to
  the API later is closed to owners until somebody lists it on purpose. Where
  the answer needs the database (a report's named contexts, a member's
  membership) the verdict says what to check and the middleware checks it.
- `auth/contextOwner.js` holds the lookups (roles, sub-units, variants, and the
  report's name-or-id resolution), proven against PostgreSQL by
  `contract-tests/contextOwner.contract.test.js`; the reference projection is
  proven by `contract-tests/memberReferences.contract.test.js`.

## With authentication off

Nothing changes: in open mode everybody already sees everything, and nobody is
treated as a context owner.

## Known limits

- A context owner who is also sent a [matrix share link](../ui/sharing-a-matrix.md)
  lands on their context page instead: the shared matrix reads endpoints outside
  an owner's scope.
- Whether someone is an owner, and of which sub-units, is read on every request,
  so adding or removing a role takes effect immediately; there is no cache to
  expire.
- References are direct only (one hop), names only, and capped at 50 per group.
- The unit report never includes sub-units for an owner; they download it per
  sub-unit.
