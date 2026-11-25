// Context-owner scope (docs/architecture/context-owner-access.md).
//
// A context owner's page (ContextOwnerPage) renders the ordinary context page
// read-only (SharedViewContext). This tells the components inside it WHICH
// contexts the owner may open: the lower-cased ids the API lets them read (their
// own contexts, every sub-unit below them, the variants).
// A sub-unit or a parent in that set opens in place; any other stays plain text.
// It also marks the owner's page for the parts only an owner gets, such as a
// member's references.
//
// Default null: everywhere else nothing changes.

import { createContext, useContext } from 'react';

export const ContextOwnerScopeContext = createContext(null);

// The owner's scope (a Set of lower-cased context ids), or null outside an owner's page.
export function useContextOwnerScope() {
  return useContext(ContextOwnerScopeContext);
}

// The business roles the owner answers for themselves (lower-cased ids, from
// /api/auth-me contextOwner.businessRoles), while that relative permission is on.
// On their own page a role in this set opens with its Composition review, where
// they may sign off; the API allows nothing else on it. Empty everywhere else.
export const OwnedBusinessRolesContext = createContext(new Set());

/** Does the signed-in owner answer for this business role? */
export function useAnswersForRole(roleId) {
  return useContext(OwnedBusinessRolesContext).has(String(roleId ?? '').toLowerCase());
}
