// Pure helpers for a unit's variants — the same unit held as separate contexts
// per kind of member (its people, its accounts, its resources), linked by
// SameUnitAs. Each variant stays its own context; nothing here merges members.

import { MEMBER_KINDS, memberKindLabel } from '@ui/utils/contextStyles';

// A context's member count: the total including sub-contexts when known,
// else its direct members, else null (unknown).
export function memberCount(attrs) {
  const n = attrs?.totalMemberCount ?? attrs?.directMemberCount;
  return typeof n === 'number' ? n : null;
}

// The SameUnitAs links out of a GET /relationships response (anything else —
// another relationship type, a non-array body — is not a variant).
export function sameUnitLinks(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r?.relationshipType === 'SameUnitAs' && r.relatedContextId);
}

// The links whose member count the relationship row does not carry, and that
// have not been looked up yet.
export function linksNeedingCount(links, counts) {
  return links.filter(l => typeof l.relatedTotalMemberCount !== 'number' && !counts.has(l.relatedContextId));
}

const kindRank = (t) => {
  const i = MEMBER_KINDS.indexOf(t);
  return i < 0 ? MEMBER_KINDS.length : i;
};

// This context plus its variants, People · Accounts · Resources order, each
// { id, displayName, targetType, count, self }.
export function buildVariants(attrs, links, counts) {
  const self = { id: attrs.id, displayName: attrs.displayName, targetType: attrs.targetType, count: memberCount(attrs), self: true };
  const others = links.map(l => ({
    id: l.relatedContextId,
    displayName: l.relatedDisplayName,
    targetType: l.relatedTargetType,
    count: typeof l.relatedTotalMemberCount === 'number' ? l.relatedTotalMemberCount : (counts.get(l.relatedContextId) ?? null),
    self: false,
  }));
  return [self, ...others].sort((a, b) =>
    kindRank(a.targetType) - kindRank(b.targetType) || String(a.displayName ?? '').localeCompare(String(b.displayName ?? '')));
}

// "People 12" — the kind word and the count ("—" while unknown).
export function variantLabel(v) {
  return `${memberKindLabel(v.targetType)} ${v.count ?? '—'}`;
}
