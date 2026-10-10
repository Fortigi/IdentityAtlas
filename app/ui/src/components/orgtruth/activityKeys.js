// Pure helpers for Organisation → Review → "Activity references": every
// distinct value an activity list refers to (an actor "Ann Example", a subject
// "Contoso"), resolved once and decided once.
//
//   GET /api/org-truth/activity-keys?status=&role=&profileName=&page=
//     → { data: [{ id, profileName, role, rawValue, rows, targetType, targetId, targetLabel,
//                  confidence, status, candidates?: [{ targetType, targetId, label, confidence }] }], total }
//   PUT /api/org-truth/activity-keys/:id { status: 'accepted'|'rejected', targetType?, targetId? }
//
// Kept apart from the .jsx so it is mutated (stryker.orgtruth.config.json).
export const KEYS_URL = '/api/org-truth/activity-keys';
export const KEY_STATUSES = ['proposed', 'unmatched', 'accepted', 'rejected'];
export const KEY_ROLES = [
  { value: '', label: 'People and subjects' },
  { value: 'actor', label: 'People (who)' },
  { value: 'subject', label: 'Subjects (on what)' },
];

export const keyUrl = (id) => `${KEYS_URL}/${encodeURIComponent(id)}`;

export function roleLabel(role) {
  return role === 'actor' ? 'Who' : 'On what';
}

// The current candidate of a key (what accept confirms), or null.
export function currentCandidate(key) {
  if (!key?.targetId) return null;
  return {
    targetType: key.targetType, targetId: key.targetId,
    label: key.targetLabel || key.targetId, confidence: key.confidence ?? null,
  };
}

// The other candidates to pick from, best first, without the current one.
export function otherCandidates(key) {
  return (key?.candidates ?? [])
    .filter(c => c.targetId && c.targetId !== key.targetId)
    .sort((a, b) => ((b.confidence ?? -1) - (a.confidence ?? -1)) || String(a.label).localeCompare(String(b.label)));
}

// The PUT body: accept a candidate (the current one or another) or reject.
export function keyDecisionBody(action, candidate) {
  if (action === 'rejected') return { status: 'rejected' };
  return { status: 'accepted', targetType: candidate.targetType, targetId: candidate.targetId };
}

export function keyToast(action, key, candidate) {
  if (action === 'rejected') return `Rejected “${key.rawValue}”`;
  return `“${key.rawValue}” is ${candidate.label}`;
}

export function keyError(status, detail) {
  if (status === 501) return 'Deciding on activity references is not available yet.';
  if (detail) return `The decision was not saved: ${detail}`;
  return status ? `The decision was not saved (HTTP ${status}).` : 'The decision was not saved.';
}

// Accept is offered when there is a current candidate not yet accepted;
// reject when the key is not rejected already.
export function keyActions(key, canEdit) {
  if (!canEdit) return { accept: false, reject: false, pick: false };
  return {
    accept: Boolean(key.targetId) && key.status !== 'accepted',
    reject: key.status !== 'rejected',
    pick: otherCandidates(key).length > 0,
  };
}
