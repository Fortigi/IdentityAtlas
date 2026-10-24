// Resolve which directory objectIds are present in the data the crawler has loaded.
//
// "Present" means the objectId exists, for the caller's directory, as a Principal OR
// a Resource (security groups are modelled as Resources, so they must be checked too)
// — i.e. something the directory's own crawler has already brought in. It is crawler
// presence, not a live directory lookup. The Azure RM crawler uses this to filter or
// flag role-assignment holders the Entra crawler hasn't loaded — deleted SPs with
// dangling assignments, or principals outside a scoped (e.g. admins-only) Entra crawl.
//
// WHICH SYSTEM IS "THE DIRECTORY" (#1247). This used to be derived here and only
// here, as `systemType = 'EntraID'` + a matching tenantId — a second, independent
// copy of a rule the rest of the ingest also needs. The two disagreed: the Azure RM
// crawler's principal stubs re-stamped the shared Principal row to the Azure RM
// system, after which this lookup no longer found the user "in the directory",
// reported him as an orphan, and his Azure grants were dropped on the next run. The
// answer now comes from `Systems.directorySystemId` — the caller passes its own
// systemId and we follow the link it declares. The tenant scan stays as the fallback
// for a system with no link yet (mid-upgrade, or a tenant with two EntraID systems),
// so nothing regresses while the link is being backfilled.
//
// db is injected so the logic is unit-testable without a live database.

export function normalizePresenceQuery(body) {
  const tenantId = (typeof body?.tenantId === 'string' && body.tenantId) ? body.tenantId : null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
  const systemId = Number.isInteger(body?.systemId) ? body.systemId : null;
  return { tenantId, ids, systemId };
}

// The system(s) that count as "the directory" for this caller, narrowed to what the
// caller's key may see. Returns [] when nothing resolves, which the caller reports as
// crawlerDataAvailable=false rather than calling every principal an orphan.
//
// `allowedSystemIds` (an integer array) limits the lookup to those systems — set for
// a crawler key restricted to specific systems, so it cannot probe a tenant it has no
// access to (SEC-2026-09 M-05). null = unrestricted.
export async function resolveDirectorySystemIds(db, tenantId, callerSystemId, allowedSystemIds = null) {
  let directoryIds = [];
  if (callerSystemId !== null && callerSystemId !== undefined) {
    const linked = await db.queryOne(
      `SELECT "directorySystemId" FROM "Systems" WHERE "id" = $1`, [callerSystemId]
    );
    if (linked?.directorySystemId) directoryIds = [linked.directorySystemId];
  }
  if (directoryIds.length === 0) {
    const { rows } = await db.query(
      `SELECT "id" FROM "Systems" WHERE "systemType" = 'EntraID' AND "tenantId" = $1`, [tenantId]
    );
    directoryIds = rows.map((r) => r.id);
  }
  if (!Array.isArray(allowedSystemIds)) return directoryIds;
  const allowed = new Set(allowedSystemIds.map(Number));
  return directoryIds.filter((id) => allowed.has(Number(id)));
}

export async function lookupCrawlerPresence(db, tenantId, ids, allowedSystemIds = null, callerSystemId = null) {
  const directoryIds = await resolveDirectorySystemIds(db, tenantId, callerSystemId, allowedSystemIds);

  // crawlerDataAvailable=false means the crawler has loaded no directory data yet, so
  // the caller must NOT treat everything as orphaned (an Azure-RM-first run, say). A
  // directory this key may not see is the same situation from the caller's side.
  if (directoryIds.length === 0) return { present: [], crawlerDataAvailable: false };

  const avail = await db.queryOne(`
    SELECT (
      EXISTS (SELECT 1 FROM "Principals" p WHERE p."systemId" = ANY($1::int[]))
      OR EXISTS (SELECT 1 FROM "Resources" r WHERE r."systemId" = ANY($1::int[]))
    ) AS available`, [directoryIds]);

  let present = [];
  if (ids.length > 0) {
    const { rows } = await db.query(`
      SELECT p.id::text AS id FROM "Principals" p
        WHERE p."systemId" = ANY($2::int[]) AND p.id::text = ANY($1::text[])
      UNION
      SELECT r.id::text AS id FROM "Resources" r
        WHERE r."systemId" = ANY($2::int[]) AND r.id::text = ANY($1::text[])
    `, [ids, directoryIds]);
    present = rows.map((x) => x.id);
  }

  return { present, crawlerDataAvailable: !!avail?.available };
}
