# Relationship filter (#840, Phase 1)

Filter entities by the **presence, absence, or count** of a graph edge — the
"find-the-needle" governance questions attribute filters can't ask ("groups with
no owners", "AI agents with no owner", "guests with no sponsor", "groups with
fewer than 2 owners").

## Surface
An **additive** capability on the existing list-page filters, not a new page and
not a change to the equality filter. The list endpoints accept an optional
`relFilters` query param alongside `filters`; when absent, behaviour is
unchanged. Offered on:

- **Resources list** (`GET /api/resources`) — Resource-anchored edges.
- **Users list** (`GET /api/users`) — Principal-anchored edges.

The Identities list maps to neither relationship target and shows no control.
The motivating "groups" cases are expressed by composing the existing
`resourceType=Group` attribute filter with a relationship condition — the
relationship filter never self-scopes to a resourceType.

`relFilters` is a JSON array of `{ edge, op, n? }`:

| op | meaning |
|----|---------|
| `exists` / `absent` | the entity has / has no edge of this kind |
| `eq` / `lt` / `gt` (+ integer `n >= 0`) | the count of the edge compared to `n` |

Unknown edge, wrong entity, bad operator, or bad `n` → **HTTP 400** (fail loud —
a silently-dropped condition would quietly widen a governance query).

## Edge catalog — the single source of truth
`app/api/src/relationships/edgeCatalog.js`. Each edge's SQL traversal is
irreducibly bespoke (ownership is a 3-hop walk through a synthetic `*Ownership`
resource; membership is a `ResourceAssignments` row; owner/sponsor is a
`PrincipalRelationships` row), so the catalog is **code**, not a data table.

| edge | on | mechanism |
|------|----|-----------|
| `resource.members` | Resources | `ResourceAssignments` (all live types) on the resource |
| `resource.owners` | Resources | `HasOwnership`/`HasAppOwnership` → ownership resource → `Direct` assignment |
| `principal.memberOf` | Users | inverse of `resource.members` |
| `principal.owns` | Users | inverse of `resource.owners` (the owner-holder side) |
| `principal.owner` | Users | `PrincipalRelationships` `Owner`, subject = principal |
| `principal.sponsor` | Users | `PrincipalRelationships` `Sponsor`, subject = principal |
| `principal.ownsPrincipals` | Users | inverse of `principal.owner` |
| `principal.sponsorsPrincipals` | Users | inverse of `principal.sponsor` |

"Members" counts **all live assignment types** (Direct + Indirect + Eligible,
`deletedAt IS NULL`) so "no members" agrees with the member count shown on the
detail page — an indirect-only group is not falsely flagged empty.

`relationshipSql.js` composes each edge into an `EXISTS` / `NOT EXISTS` /
scalar-count predicate, bound through the list route's shared positional binder
so it AND-s onto the equality WHERE with consistent `$N` numbering (including the
COUNT query). No new matview or migration — the predicates are index-supported by
the existing primary keys.

## Availability (self-maintaining, no drift)
`GET /api/relationship-edges?entity=Resource|Principal` returns the edges for an
entity, each with a live `available` flag computed from the catalog's own
existence probe (single source of truth — no DB view to drift), behind a 5-minute
TTL cache. The UI disables an unavailable edge with a "no data yet" hint — so an
edge from an opt-in crawler phase (Principal Relationships: owner/sponsor) isn't
offered as a filter that would flag every entity until that phase has run.

## Coverage guard (closes the "static catalog silently drifts" loose end)
`findUncoveredRelationshipTypes()` compares the distinct relationship types
present in the data against the set the catalog consumes or explicitly ignores.
A new mechanism nobody taught the catalog about (a new `relationshipType` in
`ResourceRelationships`/`PrincipalRelationships`) is flagged so a human adds an
edge — or ignores it. Exercised by `relationshipFilter.contract.test.js` against
the real schema. (Wiring it as a live post-crawl diagnostic against tenant data
is a future enhancement; in CI it validates the detector against seeded data.)

## Out of scope (Phase 2 / later)
"Save as Context" wizard, the matrix surface, global search, the Identities list,
and per-system availability.
