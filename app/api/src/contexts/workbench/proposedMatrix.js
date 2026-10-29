// The matrix's "+ Proposed roles" toggle — the read behind its picker.
// Design: docs/architecture/m1-discovery-and-design.md, "Proposed roles in the matrix".
//
//   listAllInvestigations(db)   every saved investigation that holds a proposed role, any unit
//
// The browser reads each picked investigation and its unit's people (the
// workbench's own endpoints), works out who each proposed role reaches with the
// workbench's own rule code, and adds the proposals on top of the matrix view it
// already has. Read-only.

export const LIST_ALL_SQL = `
  SELECT w.id, w.name, w."contextId", c."displayName" AS "unitName", w."updatedBy", w."updatedAt",
         COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.position, p."createdAt", p.id)
                     FROM "RoleProposals" p WHERE p."investigationId" = w.id), '[]'::json) AS proposals
    FROM "WorkbenchInvestigations" w
    JOIN "Contexts" c ON c.id = w."contextId"
   WHERE EXISTS (SELECT 1 FROM "RoleProposals" p WHERE p."investigationId" = w.id)
   ORDER BY w."updatedAt" DESC, w.id`;

/** Every saved investigation with at least one proposed role, newest first, with its unit's name. */
export async function listAllInvestigations(db) {
  return (await db.query(LIST_ALL_SQL)).rows;
}
