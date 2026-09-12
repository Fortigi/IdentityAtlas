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
// role itself does NOT account for — held permanently where the role only makes
// the subject eligible, or held with no business role assigning it to them.
export function extraAccessTitle(count) {
  return `⚠ ${plural(count, 'assignment')} on the folded resources that this business role does not account for`
    + ' — more than it assigns, or held with no business role assigning it to this subject';
}

// The mirror image: rows the folded role DOES grant this subject, where the
// subject does not have the membership the role assigns.
export function missingAccessTitle(count) {
  return `⚠ ${plural(count, 'assignment')} on the folded resources that this business role assigns but this subject does not have`;
}

// The role(s) that hand this resource out, as the tooltip names them.
function grantingRoles(count, names) {
  if (count === 1) return names ? `business role ${names}` : 'a business role';
  return names ? `${count} business roles (${names})` : `${count} business roles`;
}

// The unfolded twin of extraAccessTitle: this resource IS handed out by
// business role(s) in the grid, but none of them assigns it to this subject —
// so the membership stands outside the governance that is supposed to cover it.
// Folding the role turns the same finding into its red count, which is why both
// sit in the strip's red slot.
//
// The wording states only what was actually evaluated: the assignments of the
// business role that grants this resource. It used to close on "the subject does
// not hold that role", which is a different claim — and one that is plainly
// wrong for a subject who does hold the role while the role carries no
// assignment matching this resource (requestor feedback on #370). The two cases
// are told apart by `holdsGrantingRole` and worded separately, so the tooltip
// never asserts a role membership it did not check.
export function heldOutsideTitle(count, names, holdsGrantingRole) {
  const noAssignment = count === 1
    ? 'which carries no assignment of it for this subject'
    : 'none of which carries an assignment of it for this subject';
  const granted = `It is granted by ${grantingRoles(count, names)}, ${noAssignment}.`;
  if (holdsGrantingRole) {
    return '⚠ Held outside business-role governance: this subject holds a business role that grants this resource,'
      + ` but the role does not assign it to them. ${granted}`;
  }
  return `⚠ Held outside business-role governance: no business role assigns this resource to this subject. ${granted}`;
}

// One cell where the subject holds permanently what the role only makes them
// eligible for.
export function overGrantTitle(expected) {
  return `⚠ More than the business role assigns: it grants ${expected || 'Eligible'} (just-in-time) access, but the subject holds a standing membership`;
}
