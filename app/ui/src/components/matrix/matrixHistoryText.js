// How a saved matrix's history reads. Pure, so the wording is testable without
// mounting the dialog.
//
// A matrix is org-wide: anybody can rename it or re-cut it, and when one stops
// producing rows the question is who moved it. These turn the API's events into
// the two sentences the dialog shows.

// "wim@example.com" → "wim@example.com"; an unknown actor is named as such
// rather than left blank, so an event never reads as if nobody did it.
export function actorLabel(actor) {
  return (typeof actor === 'string' && actor.trim()) || 'someone';
}

// The one-line byline under the matrix name: who first saved it, and who last
// touched it. The second half is dropped when nothing has changed since — the
// creator saying it twice is noise.
export function provenanceLine({ createdBy, updatedBy } = {}) {
  const created = `Created by ${actorLabel(createdBy)}`;
  if (!updatedBy || updatedBy === createdBy) return created;
  return `${created} · last changed by ${actorLabel(updatedBy)}`;
}

// What one event did, e.g. "anna@example.com renamed it and re-cut the matrix".
// Kept deliberately short: the changed fields are listed under it.
export function eventSummary(event) {
  const who = actorLabel(event?.actor);
  if (event?.operation === 'created') return `${who} saved this matrix`;
  if (event?.operation === 'deleted') return 'Deleted';
  return `${who} changed it`;
}

// One changed field as a line: a scalar reads "Name: Sales → Sales EMEA", the
// filter reads by the parts it touched.
export function changeLine(change) {
  if (!change) return '';
  if (Array.isArray(change.parts)) return `${change.label}: ${change.parts.join(', ')}`;
  return `${change.label}: ${change.from} → ${change.to}`;
}

// The saved-matrix list's right-hand label: when it last changed and by whom.
// The actor is dropped rather than guessed when the row predates attribution.
export function lastChangedLine({ updatedAt, updatedBy } = {}, relative) {
  if (!updatedAt) return '';
  return updatedBy ? `Changed ${relative} by ${updatedBy}` : `Changed ${relative}`;
}
