// Pure helpers for "is this matrix saved, and is it shared?" (#1202).
//
// Saving and sharing are one experience now: a share is a property of a saved
// matrix. These functions answer the two questions every surface that shows
// that state asks — the matrix bar, the wizard's Save/Share step and Admin —
// so the three can't drift on what "shared" means or how a link is spelled.

import { matrixFilterFingerprint } from '@ui/utils/matrixFilter';

// The saved matrix the current view IS, or null when the view is unsaved.
//
// Compared by fingerprint rather than raw JSON so a saved matrix stays
// recognised after being folded, drilled or re-applied without actually being
// changed — see utils/matrixFilter.js.
export function matchSavedMatrix(savedFilters, filter) {
  if (!Array.isArray(savedFilters) || !filter) return null;
  const fingerprint = matrixFilterFingerprint(filter);
  return savedFilters.find(s => matrixFilterFingerprint(s.filter) === fingerprint) || null;
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
