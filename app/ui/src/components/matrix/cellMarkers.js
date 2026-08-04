// Wording of the matrix cell markers, kept out of the cell components so both
// the cell and the aggregate (folded-column) cell explain a marker identically.

// A folded business role hides rows; this is the access on those rows that the
// role itself does NOT grant — the subject holds it through some other route.
export function extraAccessTitle(count) {
  return `⚠ ${count} assignment${count === 1 ? '' : 's'} on the folded resources that this business role does not grant`;
}
