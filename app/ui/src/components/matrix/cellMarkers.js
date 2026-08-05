// Wording and geometry of the matrix cell markers, kept out of the cell
// components so both the cell and the aggregate (folded-column) cell explain
// and place a marker identically.
//
// Every marker lives in ONE strip along the top of the cell, above the D/I/E
// badge, in three fixed slots — so where a marker sits always means the same
// thing:
//
//   left   — amber: FEWER permissions than the business role assigns
//   centre — white: how many business roles cover this cell (only when > 1)
//   right  — red:   MORE than the business role assigns, or access it does not
//                   account for at all
//
// The markers used to hang off the cell's corners with negative offsets, so
// each one was drawn partly over the cell above and the cell to its right — the
// white "covered by N roles" bubble landed straight on the neighbours' badges
// (requestor feedback on #370). Reserving the strip is what makes an overlap
// impossible: the strip owns the top 8px of the 24px cell, the badge row owns
// the other 16, and nothing is ever painted outside the cell's own box.

export const MARKER_STRIP_HEIGHT = 8;
export const CELL_SIZE = 24;

// The geometry every intersection cell shares — the marker strip on top, the
// badge row below it.
export const CELL_BOX_STYLE = {
  position: 'relative',
  width: `${CELL_SIZE}px`,
  minWidth: `${CELL_SIZE}px`,
  height: `${CELL_SIZE}px`,
  padding: `${MARKER_STRIP_HEIGHT}px 0 0`,
};

// Does this cell have anything to put in the strip? Cells that don't skip it
// entirely — on a full grid that is the overwhelming majority of them.
export function hasCellMarkers({
  apCount, provisioningGap, overGrant, extraAccessCount, missingAccessCount, heldOutsideCount,
}) {
  return apCount > 1 || !!provisioningGap || !!overGrant
    || extraAccessCount > 0 || missingAccessCount > 0 || heldOutsideCount > 0;
}

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

// The unfolded twin of extraAccessTitle: this resource IS handed out by
// business role(s) in the grid, but none of them hands it to this subject — so
// the membership stands outside the role that is supposed to govern it. Folding
// the role turns the same finding into its red count, which is why both sit in
// the strip's red slot.
export function heldOutsideTitle(count, names) {
  const which = count === 1
    ? 'the business role that grants this resource'
    : `the ${count} business roles that grant this resource`;
  const holds = count === 1 ? 'that role' : 'any of them';
  return `⚠ Held outside ${which}${names ? ` (${names})` : ''} — the subject does not hold ${holds}`;
}

// One cell where the subject holds permanently what the role only makes them
// eligible for.
export function overGrantTitle(expected) {
  return `⚠ More than the business role assigns: it grants ${expected || 'Eligible'} (just-in-time) access, but the subject holds a standing membership`;
}
