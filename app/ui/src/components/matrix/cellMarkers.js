// Wording of the matrix cell markers, kept out of the cell components so both
// the cell and the aggregate (folded-column) cell explain a marker identically.

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// A folded business role hides rows; this is the access on those rows that the
// role itself does NOT grant — the subject holds it through some other route,
// or holds permanently what the role only makes them eligible for.
export function extraAccessTitle(count) {
  return `⚠ ${plural(count, 'assignment')} on the folded resources that this business role does not grant`;
}

// The mirror image: rows the folded role DOES grant this subject, where the
// subject does not have the membership the role assigns.
export function missingAccessTitle(count) {
  return `⚠ ${plural(count, 'assignment')} on the folded resources that this business role assigns but this subject does not have`;
}

// One cell where the subject holds permanently what the role only makes them
// eligible for.
export function overGrantTitle(expected) {
  return `⚠ More than the business role assigns: it grants ${expected || 'Eligible'} (just-in-time) access, but the subject holds a standing membership`;
}
