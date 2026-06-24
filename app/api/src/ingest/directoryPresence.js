// Resolve which Azure AD objectIds are present in the crawled Entra ID directory.
//
// "Present" means the objectId exists, for the given tenant, as a Principal OR a
// Resource (security groups are modelled as Resources, so they must be checked too)
// sourced from an EntraID system. The Azure RM crawler uses this to filter or flag
// role-assignment holders that aren't in Entra ID — deleted SPs with dangling
// assignments, or principals outside a scoped (e.g. admins-only) Entra crawl.
//
// db is injected so the logic is unit-testable without a live database.

export function normalizeDirectoryQuery(body) {
  const tenantId = (typeof body?.tenantId === 'string' && body.tenantId) ? body.tenantId : null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
  return { tenantId, ids };
}

export async function lookupDirectoryPresence(db, tenantId, ids) {
  // directoryAvailable=false means we have no Entra data for this tenant yet, so the
  // caller must NOT treat everything as orphaned (an Azure-RM-first run, say).
  const avail = await db.queryOne(`
    SELECT (
      EXISTS (SELECT 1 FROM "Principals" p JOIN "Systems" s ON s.id = p."systemId" WHERE s."systemType" = 'EntraID' AND s."tenantId" = $1)
      OR EXISTS (SELECT 1 FROM "Resources" r JOIN "Systems" s ON s.id = r."systemId" WHERE s."systemType" = 'EntraID' AND s."tenantId" = $1)
    ) AS available`, [tenantId]);

  let present = [];
  if (ids.length > 0) {
    const { rows } = await db.query(`
      SELECT p.id::text AS id FROM "Principals" p JOIN "Systems" s ON s.id = p."systemId"
        WHERE s."systemType" = 'EntraID' AND s."tenantId" = $2 AND p.id::text = ANY($1::text[])
      UNION
      SELECT r.id::text AS id FROM "Resources" r JOIN "Systems" s ON s.id = r."systemId"
        WHERE s."systemType" = 'EntraID' AND s."tenantId" = $2 AND r.id::text = ANY($1::text[])
    `, [ids, tenantId]);
    present = rows.map((x) => x.id);
  }

  return { present, directoryAvailable: !!avail?.available };
}
