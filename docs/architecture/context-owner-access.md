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

The **Roles & Permissions** admin tab groups them in a **Relative permissions**
section below the role table. Matrix sharing has
no setting there and its behaviour is unchanged. Today the two are enforced
separately: a context owner by the allow-list on this page, a share recipient
by the share itself. A single data-level scope that matrix shares and the MCP
server could also run under — "this caller may see these principals and
resources" rather than "these endpoints" — is a later, separate track
([#1105](https://github.com/Fortigi/IdentityAtlas/issues/1105)).

## Turning it on

**Admin → Roles & Permissions → Relative permissions → Context
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
2. **all the sub-units below those** (descendants through `parentContextId`, to
   any depth) — **also** a sub-unit that has an Accountable or Responsible of
   its own: accountability is hierarchical, whoever answers for a unit answers
   for everything below it. That sub-unit's owner, in turn, gets only their own
   subtree — nothing walks upward;
3. **the variants of the contexts they hold** (`SameUnitAs` — the same unit as
   people, accounts or resources). A sub-unit's variants are not added.

| Example tree | Ann is Accountable for Finance | In Ann's scope |
|---|---|---|
| Finance | (Ann) | yes — held |
| ├ Accounts payable | no roles | yes — sub-unit |
| │ └ AP team North | no roles | yes — sub-unit |
| └ Treasury | Bob is Responsible | yes — sub-unit (Bob's too) |
| &nbsp;&nbsp;└ Treasury ops | no roles | yes — sub-unit |

Bob, Responsible for Treasury, gets Treasury and Treasury ops — not Finance, not
Accounts payable.

The scope is computed on every request (`auth/contextOwner.js`
`findOwnedSubUnits`, one recursive statement over the indexed `parentContextId`
with a cycle guard — a top-level owner with thousands of units costs one round
trip), so a change in the tree takes effect immediately.

## What they can see

| Request (GET only) | Allowed when |
|---|---|
| `/api/auth-me`, `/api/features`, `/api/version`, `/api/preferences`, `/api/attribute-labels` | always (the app shell) |
| `/api/contexts/:id`, `…/members`, `…/roles`, `…/relationships`, `…/claims` (confirmed claims only), `…/timeline` | `:id` is in scope |
| `/api/contexts/:id/members/:memberId/references` | `:id` is in scope **and** `:memberId` is a member of `:id` itself (checked against `ContextMembers`; an id from another context, or from one of this context's sub-units, is refused) |
| `/api/risk-scores/contexts/:id` | `:id` is in scope |
| `/api/reports/application-access-review/export` | `contexts` lists only in-scope ids, and every context those values resolve to is in scope; the `applications` alias and names are refused |
| `/api/reports/unit-members/export` | the same `contexts` check; with `includeSubUnits` (any value) also every descendant of what the contexts resolve to must be in scope — true below a held context, not below a variant |

| One object's detail reads — `/api/user/:id` (and its memberships, contexts, activity, timeline, diff, …), `/api/identities/:id` (…), `/api/resources/:id`, `/api/group/:id`, `/api/access-package/:id` (…), `/api/org-chart/user/:id/manager|reports`, `/api/identities/by-user/:id`, `/api/risk-scores/{users,identities,groups,resources,business-roles}/:id` | the object opens in full for this owner (see [Exploring the team](#exploring-the-team)); the list is `auth/ownerAccess/endpoints.js` |
| `/api/access-package-groups` — the business-role catalogue the matrix maps roles to their groups with | always, but the response is cut to the business roles the owner may open (`auth/ownerAccess/responses.js`): those their team holds, or that are themselves in scope — never the whole catalogue |
| `POST /api/matrix/data` — the one POST, a read | the filter is bound to the owner's team (see [The team matrix](#the-team-matrix)) |

Everything else — any other path, and every non-GET (but the team matrix) — answers
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
sees that a member holds "Finance-Admins" there. To open "Finance-Admins" itself they go through the member's own page ([Exploring the team](#exploring-the-team)), where every reference carries the API's access flag.

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
role pencils, no suggestion, no member editing, no Copy link or Open as page.
People, members and role holders link to their page when the API marks them
accessible (`components/EntityLink.jsx`); an opened page or the team matrix
shows on top of the unit, with **Back** (`components/contextOwner/`).

- **Sub-units** open in place — all of them, whoever else owns them. The **breadcrumb** names the direct parent without reading it, and
  opens it in place when it is in scope (a sub-unit's way back up).
- A **variant** opens in place only when it is in scope.
- Each **member** expands to its references, grouped and as plain text: on a
  unit of people or accounts the name of each person in the **People** overview
  whom the member list holds (not a former member, nor someone only an interview
  names); elsewhere each row of the members list, but not while *Include
  sub-units* is on. The API answers only for a context's own members. Beside
  the name, **Open** opens the member's full page.
- The Actions area drops **View in matrix**, which the owner cannot open, and the
  "Coming soon" survey and review cards, which are the analyst's to start; it
  keeps the report downloads, which run on the context itself: **Download
  entitlement report** on an application and **Download unit report** on a unit
  of accounts or people, next to **Team matrix**; a context of resources offers
  **Application matrix**.

`contexts/ContextOwnerScopeContext.jsx` carries the scope into the page;
`components/contexts/contextOpener.js` decides which sub-units and parents are
links.

## Exploring the team

From their unit an owner can open the people in it and what those people hold;
from an application, the people who hold its resources — the full detail page
with every tab (Attributes, Relationships, Timeline, Diff, and Risk read-only) —
and no further. Whether an object opens is decided by the API from the data, in
four tiers (`auth/ownerAccess/tiers.js`):

| Tier | What | Opens |
|---|---|---|
| **team** | a member of an in-scope context. Accounts and people cross over both ways: an account whose person is a member, a person one of whose accounts is a member. A resource that is itself a member (a unit of resources, an application) | in full |
| **held** | a resource a team member holds: a live `Direct`, `Indirect` or `Eligible` assignment made to a team account or a team person | in full |
| **holder** | the mirror for a context of resources (an application): an account or person holding — live `Direct`, `Indirect` or `Eligible` — a resource that is a member of an in-scope context. Same crossover as the team: an account whose person holds one, a person one of whose accounts does | in full |
| — | everything else | name only |

One step out, no further: what a holder holds **outside** the application is not
`held` (that is the team's only), so it is name-only. An owner of several
contexts — say a unit and an application — gets the **union** of the tiers over
all of them; an object that is both team and holder is reported as team.

A detail read about an object that is in none of these tiers answers the same 403 as
any other refused path. **Facts are never stripped**: a group's page lists all
its members, people outside the unit included. Instead, in owner mode only,
every referenced object in the response carries `accessible: true | false`
(`auth/ownerAccess/annotate.js`, driven by the per-path table in
`auth/ownerAccess/endpoints.js`; a second reference on one row writes its own
flag, such as `principalAccessible`). The UI shows an accessible object as a
link and any other as lighter plain text with the hint "No access to details"
(`components/EntityLink.jsx`); it never decides on its own. An ordinary
caller's responses are unchanged and no classification runs for them.

Writes stay refused: the risk override, a linked-account override and every
other non-GET answer 403.

**Scale.** The tiers are checked per object, in one batch per kind for a
response: `team` through the `ContextMembers` primary key and the
`IdentityMembers` indexes, `held` as an `EXISTS` through `ix_RA_resourceId`,
`holder` as an `EXISTS` through `ix_RA_principalId` / the `identityId` index,
each assignment checked against the `ContextMembers` primary key — never a load
of the team's or the application's assignments. Answers are cached for the request and,
across requests, for 60 seconds per (owner scope, kind, id); the scope itself is
still resolved on every request.

### The team and application matrices

Each context page in the owner's scope offers its own matrix, opened inside the
owner's page: **Team matrix** on a unit of accounts or people (its members as
rows, what they hold as columns) and **Application matrix** on a context of
resources (its resources as columns, everyone holding one as a row — the
holders). `POST /api/matrix/data` runs for an owner only when
(`auth/ownerAccess/matrixFilter.js`):

- every context condition anywhere in the filter names an in-scope context; with
  `includeChildren`, every descendant of it must be in scope too (always true
  below a held context; a variant does not bring its sub-units along);
- an axis is anchored to one of them: the subject include on a unit of
  accounts or people, or the resource include on a context of resources (the
  include conditions of an axis are ANDed, so the anchor bounds it; the flat
  grid lists only subjects with a cell in the columns, so a column bound also
  bounds the rows to holders). A context of the wrong kind on an axis is
  dropped by that axis's query and is never an anchor;
- the aggregate modes (roll-ups, hierarchy sort, attribute fold, inherited
  access) are removed: the flat grid is run.

Both open with business roles as columns (`includeBusinessRoles`), as an
analyst can choose, so the roles the people hold show beside their groups; the
business-role catalogue the views map roles to groups with is answered, cut to
the roles the owner may open. Anything else is a 403. The matrix's other reads
(tags, column labels, the default filter, the inheritance path, identity
expansion) are not on the list; the views carry on without them.

### Reusing this scope (MCP)

The MCP server (#1508) answers on behalf of the signed-in user and must apply
exactly this scope. Everything it needs is exported from
`app/api/src/auth/ownerAccess/index.js`:

```js
import { createOwnerAccess, ownerMatrixVerdict, annotateReferences, entityEndpointFor, refsFor } from '../auth/ownerAccess/index.js';

const owner = await resolveContextOwner(user);              // auth/contextOwner.js — null for a non-owner
const access = createOwnerAccess(owner.contextIds);         // one per request
await access.canOpen('user', id);                          // may this object be opened in full?
await access.tierOf('resource', id);                       // 'team' | 'held' | null (people: 'team' | 'holder' | null)
await access.accessibleIds('principal', ids);              // batch: the Set of ids that open
ownerMatrixVerdict(body, owner.contextIds, contextTypes);   // { ok, filter } for a matrix query
await annotateReferences(body, refs, access);               // mark references in a result
```

Kinds accept the data model's words (`principal`, `identity`, `resource`,
`context`, `member`) and the UI's (`user`, `group`, `access-package`,
`business-role`). A tool that returns an object should check `canOpen` first
and refuse otherwise (the tiers are already the union over every context the
owner holds — one access object covers a unit and an application alike); a tool
that runs a matrix query should pass it through `ownerMatrixVerdict` and run
only the filter it returns; a tool that lists references should return them all and
mark each from `accessibleIds`, as the REST responses do.

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
- A member's references (the expandable row) are direct only (one hop), names only, and capped at 50 per group; the full lists are on the member's own page.
- The team and application matrices open on one context with all its sub-contexts (an application often keeps its resources in child contexts); a variant's matrix is refused when the variant has sub-contexts outside the scope.
- A variant's own sub-units are not in scope, so a report or matrix of a variant
  with its sub-units is refused.
