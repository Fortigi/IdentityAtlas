// How a member's references read (GET /api/contexts/:id/members/:memberId/references).
// Names only: every item is a display name plus the few words that place it.

import { accountTypeWord } from '@ui/components/ContextRelationshipsTab.helpers';

export const REFERENCE_LABELS = {
  resources: 'Groups & resources',
  businessRoles: 'Business roles',
  contexts: 'Other contexts',
  holders: 'Held by',
};

const PARTS = {
  resources: (it) => [it.resourceType, it.systemName, it.assignmentType],
  businessRoles: (it) => [it.systemName, it.assignmentType],
  contexts: (it) => [it.contextType],
  holders: (it) => [it.holderType && accountTypeWord(it.holderType), it.assignmentType],
};

// "Group · Entra ID · Direct" — the words after the name, empty ones left out.
export function referenceDetail(key, item) {
  const parts = PARTS[key]?.(item) || [];
  return parts.filter(Boolean).join(' · ');
}

export const formatCount = (n) => Number(n).toLocaleString('en-US');

// "+ 1,234 more" when the group holds more than it lists, else null.
export function moreText(group) {
  const more = group.total - group.items.length;
  return more > 0 ? `+ ${formatCount(more)} more` : null;
}

// The member id a People row stands for in its context, or null when the row is
// not one of the context's own members (the member list does not list them —
// a former member, or someone only an interview names). An Identity context
// lists people, any other accounts.
export function listedMemberId(person, targetType) {
  if (!(person.sources || []).includes('list')) return null;
  return (targetType === 'Identity' ? person.identityId : person.principalId) || null;
}
