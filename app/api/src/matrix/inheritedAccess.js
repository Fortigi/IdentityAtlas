// Effective (inherited) access for the matrix.
//
// Azure-style access is declared on capability-resources (role@scope) and
// inherited down the Contains hierarchy — "Owner on the subscription" ⇒ Indirect
// on every resource beneath it. The matrix's declared matview never sees this:
// it reads stored grants only, and the scope nodes the resource filter selects
// (key vaults, a region, …) carry none — the grants live on capability-resources
// at or above them. So when the user opts in ("include inherited access") AND the
// matrix is scoped to a bounded set of resources, we ask the effective-access
// engine for the effective capabilities AT those scope nodes and fold the result
// into the matrix. Generic: any source with Contains + capability-resources.
//
// Bounded-scope only — the engine never fires for an unscoped (whole-tenant)
// matrix, so "include inherited" can't accidentally fan inheritance over
// everything.

import * as db from '../db/connection.js';
import { effectiveAccessForNodes } from '../effectiveAccess/engine.js';

// The scope-node ids inside the current resource scope. `built.resourceSql` is a
// parenthesised "(SELECT id FROM "Resources" WHERE …)" carrying @-bindings.
// Capability-resources (role@scope) carry a capabilityId and are NOT part of the
// containment hierarchy the engine walks, so exclude them.
async function scopedNodeIds(p, built) {
  const req = p.request();
  for (const [k, v] of Object.entries(built.bindings)) req.input(k, v);
  const r = await req.query(
    `SELECT id FROM "Resources" WHERE id IN ${built.resourceSql} AND "capabilityId" IS NULL`,
  );
  return r.recordset.map((x) => x.id);
}

// The principal ids inside the current subject scope, so inherited rows honour
// the subject filter too. Returns null when there is no subject scope.
async function scopedPrincipalIds(p, built, rowType) {
  if (!built.subjectSql) return null;
  const req = p.request();
  for (const [k, v] of Object.entries(built.bindings)) req.input(k, v);
  const sql = rowType === 'identity'
    ? `SELECT "principalId" AS id FROM "IdentityMembers" WHERE "identityId" IN ${built.subjectSql}`
    : `SELECT id FROM "Principals" WHERE id IN ${built.subjectSql}`;
  const r = await req.query(sql);
  return new Set(r.recordset.map((x) => x.id));
}

// Produce flat per-(capability, subject) rows in the exact shape the /matrix/data
// flat path emits, for the inherited access at the scoped resources.
export async function buildInheritedFlatRows(p, built, rowType, subjectCols) {
  if (!built.resourceSql) return [];                 // bounded scope only
  const nodeIds = await scopedNodeIds(p, built);
  if (!nodeIds.length) return [];

  const { rows: eff } = await effectiveAccessForNodes(nodeIds);
  if (!eff.length) return [];

  const subjScope = await scopedPrincipalIds(p, built, rowType);
  const rows = subjScope ? eff.filter((e) => subjScope.has(e.principalId)) : eff;
  if (!rows.length) return [];

  const pids = [...new Set(rows.map((r) => r.principalId))];
  const dynCols = subjectCols
    .filter((c) => !['displayName', 'email'].includes(c.name))
    .map((c) => c.name);
  const colSel = dynCols.length ? ', ' + dynCols.map((n) => `"${n}"`).join(', ') : '';

  const [{ rows: princ }, { rows: nodeMeta }] = await Promise.all([
    db.query(
      `SELECT id, "displayName", "email", "principalType", "extendedAttributes"${colSel}
         FROM "Principals" WHERE id = ANY($1)`, [pids]),
    db.query(
      `SELECT r.id, r."systemId", s."displayName" AS "systemName"
         FROM "Resources" r LEFT JOIN "Systems" s ON s.id = r."systemId"
        WHERE r.id = ANY($1)`, [nodeIds]),
  ]);
  const byId = new Map(princ.map((u) => [u.id, u]));
  const nodeById = new Map(nodeMeta.map((n) => [n.id, n]));

  // rowType=identity rolls each holder principal up to its identities.
  let identByPrincipal = null;
  if (rowType === 'identity') {
    const { rows: im } = await db.query(
      `SELECT im."principalId" AS pid, i.id, i."displayName", i."email"
         FROM "IdentityMembers" im JOIN "Identities" i ON i.id = im."identityId"
        WHERE im."principalId" = ANY($1)`, [pids]);
    identByPrincipal = new Map();
    for (const x of im) {
      if (!identByPrincipal.has(x.pid)) identByPrincipal.set(x.pid, []);
      identByPrincipal.get(x.pid).push(x);
    }
  }

  const out = [];
  const emit = (e, u, memberId, memberName, memberUpn, memberType) => {
    const node = nodeById.get(e.nodeId) || {};
    const row = {
      resourceId: e.resourceId, groupId: e.resourceId,
      resourceDisplayName: e.displayName, groupDisplayName: e.displayName,
      resourceType: e.resourceType, groupTypeCalculated: e.resourceType,
      resourceDescription: null, groupDescription: null,
      systemId: node.systemId ?? null, systemName: node.systemName ?? null,
      memberId, memberDisplayName: memberName, memberUPN: memberUpn, memberType,
      membershipType: e.membershipType,
      extendedAttributes: u.extendedAttributes ?? null,
      managedByAccessPackage: false,
    };
    for (const n of dynCols) row[n] = u[n] ?? null;
    out.push(row);
  };

  for (const e of rows) {
    const u = byId.get(e.principalId);
    if (!u || u.principalType === '#microsoft.graph.group') continue;
    if (rowType === 'identity') {
      for (const id of (identByPrincipal.get(e.principalId) || [])) {
        emit(e, u, id.id, id.displayName, id.email, 'Identity');
      }
    } else {
      emit(e, u, u.id, u.displayName, u.email, u.principalType);
    }
  }
  return out;
}
