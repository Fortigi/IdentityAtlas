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

// ─── A matrix is a document (#1202) ─────────────────────────────────────────

const MANAGED_STATES = ['all', 'managed', 'unmanaged', 'gaps'];

// What loading a saved matrix applies: its filter — tagged with the saved
// matrix it came from, so an identical-content twin can't take over its name
// and shared state (see matchSavedMatrix) — and, separately, the governed toggle
// that was stored inside it. Every surface that loads one (the name menu, the
// "Open a matrix" list) goes through here so the tag can't be forgotten.
export function savedMatrixLoadArgs(row) {
  const { managed, ...rest } = row?.filter || {};
  return [{ ...rest, savedFilterId: row?.id }, MANAGED_STATES.includes(managed) ? managed : 'all'];
}

// Which saved matrix the strip is about, and whether what is on screen has moved
// on from it.
//
// A matrix loaded from a saved one stays THAT matrix after it is adjusted — its
// name stays on screen and it is marked as having unsaved changes. Without a
// (live) tag the view is whichever saved matrix it matches, or none; a matrix
// that was never saved has no changes to speak of — it is simply unsaved.
export function currentSavedMatrix(savedFilters, filter) {
  const rows = Array.isArray(savedFilters) ? savedFilters : [];
  const tag = filter?.savedFilterId;
  const origin = tag ? rows.find(s => s.id === tag) : null;
  const match = matchSavedMatrix(rows, filter);
  if (!origin) return { current: match, diverged: false };
  return { current: origin, diverged: match?.id !== origin.id };
}

// The saved matrix the wizard tags its Apply with: the one the result IS, else
// the one being edited, else the one the wizard was opened on. Keeping the tag
// on a CHANGED matrix is what lets the strip say "Unsaved changes" rather than
// forgetting where the matrix came from.
export function appliedSavedMatrix({ savedMatch, editingSaved, savedFilters, initialFilter }) {
  if (savedMatch || editingSaved) return savedMatch || editingSaved;
  const tag = initialFilter?.savedFilterId;
  return (tag && Array.isArray(savedFilters) && savedFilters.find(s => s.id === tag)) || null;
}

// The default name offered when duplicating a saved matrix.
export function copyName(name) {
  return `Copy of ${name}`;
}

// What renaming a shared matrix tells its author before it happens.
export function renameShareWarning(row) {
  if (!row?.shared) return '';
  return `${sharedWithLabel(row.recipientCount)} — they will see the new name.`;
}
