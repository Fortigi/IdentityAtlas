// Pure helpers for "is this matrix saved, and is it shared?" (#1202).
//
// Saving and sharing are one experience now: a share is a property of a saved
// matrix. These functions answer the two questions every surface that shows
// that state asks — the matrix bar, the wizard's Save/Share step and Admin —
// so the three can't drift on what "shared" means or how a link is spelled.

import { matrixFilterFingerprint } from '@ui/utils/matrixFilter';
import { displayModeOf } from '@ui/components/shared/sharedSnapshot';

// The body POSTed to /api/matrix/shares — one shape for both places that create
// a share: the share form (matrix bar, Admin) and the wizard's Save & share step.
//
// A matrix that is already saved is shared BY ID, and nothing else is sent: its
// name, filter and lens are the saved row's, and sending them again is the "asked
// for a second name" confusion #1202 was filed about. An unsaved one is saved and
// shared in the same request under the single name given.
export function shareRequestBody({ savedFilterId = null, name, filter, managed, recipients }) {
  if (savedFilterId) return { savedFilterId, recipients };
  return {
    name: String(name ?? '').trim(),
    filter,
    managed: managed || 'all',
    displayMode: displayModeOf(filter),
    recipients,
  };
}

// The saved matrix the current view IS, or null when the view is unsaved.
//
// Compared by fingerprint rather than raw JSON so a saved matrix stays
// recognised after being folded, drilled or re-applied without actually being
// changed — see utils/matrixFilter.js.
//
// Content alone can't tell two saved matrices with identical filters apart
// ("Sales team" shared off the org-wide "All" is exactly that), so an applied
// matrix carries `savedFilterId` — the saved matrix it was loaded from — and a
// candidate with that id wins. Without the tag (a pasted `#matrix?filter=`
// link), or when the tag no longer matches, the org default is the likelier
// intent than whichever twin sorts first; failing that, the first match.
export function matchSavedMatrix(savedFilters, filter, preferId = filter?.savedFilterId) {
  if (!Array.isArray(savedFilters) || !filter) return null;
  const fingerprint = matrixFilterFingerprint(filter);
  const candidates = savedFilters.filter(s => matrixFilterFingerprint(s.filter) === fingerprint);
  return candidates.find(s => s.id === preferId) || candidates.find(s => s.isDefault) || candidates[0] || null;
}

// The id the wizard should prefer when matching: the saved matrix it is
// editing, else the one the matrix it was opened on was loaded from.
export function wizardPreferredSavedId(editingSaved, initialFilter) {
  return editingSaved?.id ?? initialFilter?.savedFilterId;
}

// The applied filter, tagged with the saved matrix it is (when it is one) so
// the save bar can tell identical saved matrices apart.
export function tagWithSavedMatrix(filter, saved) {
  return saved ? { ...filter, savedFilterId: saved.id } : filter;
}

// The saved matrix the wizard tags its Apply with: the one the result IS, else
// the one being edited, else the one the wizard was opened on. Keeping the tag
// on a CHANGED matrix is what lets the strip say "Unsaved changes" rather than
// forgetting where the matrix came from.
// (Same name and semantics as the helper the strip slice added — one of the two
// is dropped when the branches meet.)
export function appliedSavedMatrix({ savedMatch, editingSaved, savedFilters, initialFilter }) {
  if (savedMatch || editingSaved) return savedMatch || editingSaved;
  const tag = initialFilter?.savedFilterId;
  return (tag && Array.isArray(savedFilters) && savedFilters.find(s => s.id === tag)) || null;
}

// The live share of a saved matrix, out of the org-wide share list. A revoked
// share is history, not a share: it must never make a matrix read as shared.
export function activeShareOf(shares, savedFilterId) {
  if (!Array.isArray(shares) || !savedFilterId) return null;
  return shares.find(s => s.savedFilterId === savedFilterId && !s.revokedAt) || null;
}

// "Shared with 3 people" / "Shared with 1 person" — one spelling, everywhere.
export function sharedWithLabel(count) {
  const n = Number(count) || 0;
  return `Shared with ${n} ${n === 1 ? 'person' : 'people'}`;
}

// What the author is told when they save a change to a matrix people can see.
// Empty string when nobody can — the caller renders nothing rather than a
// reassurance that says nothing.
export function liveShareWarning(share) {
  if (!share) return '';
  const n = share.recipients?.length ?? share.recipientCount ?? 0;
  return `${sharedWithLabel(n)} — they will see this change.`;
}
