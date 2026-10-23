# Context-owner access

A department's manager or an application's owner usually has no Identity Atlas
role, yet they are exactly the person an access review is held with. Context-owner
access lets them sign in with their normal Microsoft account and land on **their
own context** — nothing else. It is the same idea as
[sharing a matrix](../ui/sharing-a-matrix.md), without a link: the owner simply
opens Identity Atlas.

## Turning it on

**Admin → Authentication → Authorization → Context owners** (needs `admin.auth`).
Off by default. The setting is stored in `WorkerConfig` as `CONTEXT_OWNER_ACCESS`
and takes effect on the next request; no restart.

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

## What they can see

Their **scope** is the contexts they hold a role on, plus each of those
contexts' variants (`SameUnitAs` — the same unit as people, accounts or
resources). Sub-contexts are not included.

| Request (GET only) | Allowed when |
|---|---|
| `/api/auth-me`, `/api/features`, `/api/version`, `/api/preferences`, `/api/attribute-labels` | always (the app shell) |
| `/api/contexts/:id`, `…/members`, `…/roles`, `…/relationships`, `…/claims` (confirmed claims only), `…/timeline` | `:id` is in scope |
| `/api/risk-scores/contexts/:id` | `:id` is in scope |
| `/api/reports/application-access-review/export` | `contexts` lists only in-scope ids, and every context those values resolve to is in scope; the `applications` alias and names are refused |
| `/api/reports/unit-members/export` | the same `contexts` check; `includeSubUnits` is refused in any form (even `false`), because the units below an owner's unit need not be theirs — the owner of a sub-unit downloads from that sub-unit's own page |

Everything else — any other path, and every non-GET — answers
`403 { "error": "Context owners can only open their own context" }`.

In the UI an owner gets a bare page (no main navigation): their context
directly, or a list on the left when they hold several. The page is the
ordinary context page in its business (reading) view, read-only: no Edit, no
role pencils, no suggestion, no member editing, members, sub-units and people
as plain text, no Copy link or Open as page, a breadcrumb that names the direct
parent without reading it, and a variant opening in place only when it is in
scope. The Actions area drops **View in matrix**, which the owner cannot open, and the
"Coming soon" survey and review cards, which are the analyst's to start; it
keeps the report downloads, which run on the context itself: **Download
entitlement report** on an application and **Download unit report** on a unit
of accounts or people. A unit of resources therefore shows no Actions to its
owner.

## Enforcement

Enforced by the API, not the UI:

- `middleware/auth.js` hands a validated caller with no access to
  `middleware/contextOwnerMode.js`, which decides once per request (the
  middleware runs at every router mount) and fails closed with a 500 if the
  lookup errors.
- `auth/contextOwnerScope.js` is the allow-list — a table, so a route added to
  the API later is closed to owners until somebody lists it on purpose.
- `auth/contextOwner.js` holds the lookups (roles, variants, and the report's
  name-or-id resolution), proven against PostgreSQL by
  `contract-tests/contextOwner.contract.test.js`.

## With authentication off

Nothing changes: in open mode everybody already sees everything, and nobody is
treated as a context owner.

## Known limits

- A context owner who is also sent a [matrix share link](../ui/sharing-a-matrix.md)
  lands on their context page instead: the shared matrix reads endpoints outside
  an owner's scope.
- Whether someone is an owner is read on every request, so adding or removing a
  role takes effect immediately; there is no cache to expire.
