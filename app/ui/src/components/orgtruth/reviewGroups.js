// Pure logic behind Organisation → Review: the queue as DISTINCT decisions.
//
// GET /api/org-truth/review/groups?status=&entityType=&page= →
//   { kind: 'groups', status, entityType, page, pageSize, total,
//     rows: [{ entityType, via, value, targetType, entities, bestConfidence,
//              candidates: [{ targetId, label, confidence, entities }] }] }   weakest group first
// PUT /api/org-truth/review/groups/decision
//   { entityType, via, value, targetType, targetId?, action: 'confirmed' | 'rejected' } → { accepted, rejected }
//
// A timesheet naming one customer on 42 rows is ONE group here, decided once.
import { targetDetailKind } from './orgFormat';

export const GROUPS_URL = '/api/org-truth/review/groups';
export const DECISION_URL = '/api/org-truth/review/groups/decision';
export const REVIEW_STATUSES = ['proposed', 'accepted', 'rejected'];
export const DEFAULT_PAGE_SIZE = 50;

// What a group links to, in the analyst's words.
const TARGET_KIND = {
  Principal: 'Account',
  Identity: 'Person',
  Resource: 'Group',
  Context: 'Context',
  OrgEntity: 'another list',
};

export function targetKindLabel(targetType) {
  return TARGET_KIND[targetType] || targetType || '';
}

// The attribute a value came from; the entity's own name reads as "name".
export function viaLabel(via) {
  return via === 'displayName' || !via ? 'name' : via;
}

export function groupTitle(group) {
  return `${group.entityType} · ${viaLabel(group.via)} = “${group.value}”`;
}

export function rowsText(n) {
  const count = Number(n) || 0;
  return `${count} ${count === 1 ? 'row' : 'rows'}`;
}

export function groupSubline(group) {
  return `${rowsText(group.entities)} · links to ${targetKindLabel(group.targetType)}`;
}

export function groupKey(group) {
  return [group.entityType, group.via, group.value, group.targetType].join('\u0000');
}

export function candidateName(candidate) {
  return candidate.label ?? candidate.targetId ?? '(unknown)';
}

// Best candidate first (the API sends them so; kept here so the card never
// depends on it), ties by name.
export function orderCandidates(candidates) {
  return [...(candidates || [])].sort((a, b) =>
    ((b.confidence ?? -1) - (a.confidence ?? -1)) || String(candidateName(a)).localeCompare(String(candidateName(b))));
}

// The detail tab a candidate opens: an entity of another list opens its own
// org-entity tab; system targets open their usual detail page.
export function candidateDetailKind(targetType) {
  return targetType === 'OrgEntity' ? 'org-entity' : targetDetailKind(targetType);
}

// Entity types for the filter: the model's, those in the current page, and the
// selected one (so the select never loses its value), distinct and sorted.
export function entityTypeOptions(modelTypes, groups, current) {
  const set = new Set();
  for (const t of modelTypes || []) if (t?.type) set.add(t.type);
  for (const g of groups || []) if (g?.entityType) set.add(g.entityType);
  if (current) set.add(current);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Decisions are only possible on open proposals, and only for an importer.
export function canDecide(status, canEdit) {
  return Boolean(canEdit) && status === 'proposed';
}

// The PUT body for one decision. `targetId` omitted = the whole group.
export function decisionBody(group, action, targetId) {
  const body = {
    entityType: group.entityType,
    via: group.via,
    value: group.value,
    targetType: group.targetType,
    action,
  };
  if (targetId) body.targetId = targetId;
  return body;
}

export function decisionToast(action, result, label) {
  if (action === 'confirmed') return `${rowsText(result?.accepted)} linked to ${label}`;
  const rejected = `${rowsText(result?.rejected)} rejected`;
  return label ? `${rejected} for ${label}` : rejected;
}

export function decisionError(status, detail) {
  if (status === 501) return 'Reviewing links is not available yet.';
  return detail ? `The decision was not saved: ${detail}` : `The decision was not saved (HTTP ${status}).`;
}

export function totalPages(total, pageSize) {
  return Math.ceil((Number(total) || 0) / (Number(pageSize) || DEFAULT_PAGE_SIZE));
}
