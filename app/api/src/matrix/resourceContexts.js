// Shared "which Contexts is this resource a member of" lookup (#870) — the
// ContextMembers → Contexts join used by both GET /resources/:id/contexts
// (single resource, routes/resources.js) and the /matrix/data flat grid's
// `resourceContexts` sidecar (batched over the visible resources). One SQL
// builder so the two callers can't drift.

// `memberIdSql` is the caller's bound predicate on cm."memberId" — an
// `= $N` equality or an `IN (subquery)` fragment. Only Resource-targeted
// memberships qualify: a resource row must never surface an Identity /
// Principal / System context that happens to share a member UUID.
export function buildResourceContextsSql(memberIdSql) {
  return `
    SELECT cm."memberId"::text AS "resourceId",
           c.id, c."displayName", c."contextType", c."targetType", c.variant
      FROM "ContextMembers" cm
      JOIN "Contexts" c ON c.id = cm."contextId"
     WHERE cm."memberType" = 'Resource'
       AND ${memberIdSql}
     ORDER BY cm."memberId"::text, c."contextType", c."displayName"`;
}

// Group the flat rows into the /matrix/data sidecar shape:
//   [{ resourceId, contexts: [{ id, displayName, contextType, variant }] }]
// Row order (contextType, then displayName — sorted by the SQL above) is
// preserved, so the "first 2 chips" the matrix shows are stable.
export function groupResourceContexts(rows) {
  const byResource = new Map();
  for (const r of rows || []) {
    if (!r.resourceId) continue;
    if (!byResource.has(r.resourceId)) byResource.set(r.resourceId, []);
    byResource.get(r.resourceId).push({
      id: r.id,
      displayName: r.displayName,
      contextType: r.contextType,
      variant: r.variant,
    });
  }
  return [...byResource.entries()].map(([resourceId, contexts]) => ({ resourceId, contexts }));
}
