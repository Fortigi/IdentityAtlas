// How a response is shaped for a context owner before it is sent.
//
//   - a detail path's references are marked accessible true/false
//     (./annotate.js, driven by ./endpoints.js);
//   - the business-role catalogue (GET /api/access-package-groups, which the
//     matrix reads to map each business role to the groups it contains) is cut
//     down to the business roles this owner may open — those their team holds
//     (the 'held' tier) or that are themselves in scope — never the whole
//     catalogue. A role's rows (one per contained group) stay together.
//
// responseShaperFor(path, access) → async (body) => body, or null when the
// path's response goes out as it is.

import { annotateReferences } from './annotate.js';
import { refsFor } from './endpoints.js';

export const BUSINESS_ROLE_CATALOGUE_PATH = '/api/access-package-groups';

/** The catalogue rows of the business roles `access` may open, in their order. */
export async function scopedBusinessRoles(rows, access) {
  if (!Array.isArray(rows)) return [];
  const ids = rows.map(r => r?.businessRoleId ?? r?.accessPackageId).filter(Boolean);
  const allowed = await access.accessibleIds('resource', ids);
  return rows.filter(r => allowed.has(String(r?.businessRoleId ?? r?.accessPackageId ?? '').toLowerCase()));
}

export function responseShaperFor(path, access) {
  if (path === BUSINESS_ROLE_CATALOGUE_PATH) return (body) => scopedBusinessRoles(body, access);
  const refs = refsFor(path);
  return refs ? (body) => annotateReferences(body, refs, access) : null;
}
