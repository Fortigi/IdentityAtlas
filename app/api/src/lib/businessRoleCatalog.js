// The catalog a business role sits in: the Catalog-template context that holds
// it as a member (migration 117 — a catalog is a context, no longer a table of
// its own). One shared join, so every screen that names a role's catalog reads
// it the same way.
//
// A role can sit in more than one catalog context (two sources, or an analyst's
// own catalog beside the synced one). The join picks one, deterministically: a
// synced catalog before any other, then by name, then by id.

export const CATALOG_CATEGORY = 'Catalog';

// `LEFT JOIN LATERAL … <alias>` exposing <alias>.id and <alias>."displayName"
// for the role whose id is `roleIdExpr` (an SQL expression, never caller text).
// No row → both NULL, as the old LEFT JOIN on "GovernanceCatalogs" gave.
export function catalogJoinSql(roleIdExpr, alias = 'c') {
  return `LEFT JOIN LATERAL (
          SELECT cx.id, cx."displayName"
            FROM "ContextMembers" cm
            JOIN "Contexts" cx ON cx.id = cm."contextId" AND cx."contextCategory" = '${CATALOG_CATEGORY}'
           WHERE cm."memberType" = 'Resource' AND cm."memberId" = ${roleIdExpr}
           ORDER BY (cx.variant = 'synced') DESC, cx."displayName", cx.id
           LIMIT 1
        ) ${alias} ON true`;
}
