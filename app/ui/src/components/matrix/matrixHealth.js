// "Is this matrix still the matrix that was saved?" — the wording behind the
// broken marker. Pure, so the sentences are testable without rendering.
//
// Contexts come and go. A matrix that names one keeps naming it after it is
// deleted, and the API drops that condition rather than failing the request —
// so the matrix runs, but it no longer filters the way it was saved. Widened
// past what the grid can load it simply stops producing a usable result, which
// is how this shows up in practice: "this matrix used to work".

// How many of a matrix's contexts are gone. Anything without the field (an
// older API, a row from somewhere else) counts as none — an unknown must never
// be shown as a fault.
export function missingContextCount(row) {
  return Array.isArray(row?.missingContextIds) ? row.missingContextIds.length : 0;
}

export function isMatrixBroken(row) {
  return missingContextCount(row) > 0;
}

const contexts = (n) => `${n} ${n === 1 ? 'context' : 'contexts'}`;

// The marker's tooltip: what is wrong, and what it does to the matrix.
export function brokenMatrixTitle(row) {
  const n = missingContextCount(row);
  if (n === 0) return '';
  return `Refers to ${contexts(n)} that no longer ${n === 1 ? 'exists' : 'exist'}. `
    + `Those conditions are ignored, so this matrix no longer filters the way it was saved.`;
}

// What an empty (or unrecognisable) matrix says about itself. Returns an empty
// string when nothing is missing — the caller then shows its plain empty state
// rather than a reassurance that explains nothing.
export function brokenMatrixExplanation(missingContextIds) {
  const n = Array.isArray(missingContextIds) ? missingContextIds.length : 0;
  if (n === 0) return '';
  return `This matrix refers to ${contexts(n)} that no longer ${n === 1 ? 'exists' : 'exist'}, `
    + `so ${n === 1 ? 'that condition was' : 'those conditions were'} ignored. `
    + `Adjust the matrix to pick ${n === 1 ? 'a context' : 'contexts'} that still ${n === 1 ? 'exists' : 'exist'}.`;
}
