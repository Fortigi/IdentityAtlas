// The workbench's address: #workbench:<unit id>, or straight to one saved
// proposed role — #workbench:<unit id>:<investigation id>:<proposed role id>,
// which opens that investigation with that role in the panel (the unit page's
// "Proposed roles" links here). Ids are UUIDs, so ':' cannot occur inside one. Pure.

/** The workbench tab's id for a unit, optionally one saved investigation and one of its proposed roles. */
export function workbenchRouteId(contextId, investigationId = null, proposalId = null) {
  return [contextId, investigationId, investigationId ? proposalId : null].filter(Boolean).join(':');
}

/** { contextId, investigationId, proposalId } from a workbench tab's id; the parts not given are null. */
export function parseWorkbenchRouteId(id) {
  const [contextId = '', investigationId = null, proposalId = null] = String(id ?? '').split(':');
  return { contextId, investigationId: investigationId || null, proposalId: (investigationId && proposalId) || null };
}
