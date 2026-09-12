// How a subject's ACTUAL access (IST) on one cell deviates from what the
// business roles covering that cell prescribe (SOLL). Two directions, and one
// business role can carry both at once across the resources it grants:
//
//   missing — FEWER permissions than the role assigns (the provisioning gap)
//   excess  — MORE permissions than the role assigns
//
// A third statement sits next to those two: the subject holds a resource a
// business role hands out, and no business role assigns it to them
// (`heldOutsideRole`). It is the same thing a folded role reports as a red
// count, said on the resource's own row so the folded and unfolded views agree.
//
// Both sides come from data the server already states: the `Contains` edge and
// its `roleName` (delivered as the SOLL mapping behind `apGroupMap`) say what a
// role assigns, the coverage matview (`managedByPackages`) says which cells a
// role covers for which subject. Nothing here guesses what a role "ought" to
// grant. See docs/architecture/matrix.md → "Fewer and more than the role
// assigns".

// Standing access — the subject holds the resource right now, either directly
// or through a nested resource. `Eligible` is weaker: it only permits
// activation, so holding a resource permanently where the role only makes the
// subject eligible is MORE than the role assigns.
const STANDING_TYPES = ['Direct', 'Indirect'];

export const NO_DEVIATION = { missing: [], excess: [] };

// Returned when nothing is folded, so callers can keep passing an explicit
// "no tallies" value rather than two undefineds.
export const NO_ROLE_DEVIATIONS = { extra: null, missing: null };

// What one business role prescribes for a resource: an "Eligible …" role name
// on the Contains edge means just-in-time, anything else means standing access.
export function expectedTypeFor(roleName) {
  return String(roleName || '').toLowerCase().includes('eligible') ? 'Eligible' : 'Direct';
}

/**
 * Compare one cell's actual membership against the roles that cover it.
 *
 * @param {object}   args
 * @param {Set}      args.types       - membership types the subject actually has
 * @param {string[]} args.apIds       - ids (lowercase) of the roles covering this cell
 * @param {Map}      args.apGroupMap  - "RESOURCEID|apid" → roleName (the SOLL mapping)
 * @param {string}   args.resourceKey - the resource id, uppercased
 * @returns {{missing: string[], excess: string[]}}
 */
export function cellDeviation({ types, apIds, apGroupMap, resourceKey }) {
  let wantsStanding = false;
  let wantsEligible = false;
  for (const apId of apIds || []) {
    if (expectedTypeFor(apGroupMap?.get(`${resourceKey}|${apId}`)) === 'Eligible') wantsEligible = true;
    else wantsStanding = true;
  }
  if (!wantsStanding && !wantsEligible) return NO_DEVIATION;

  // FEWER: the role assigns this membership and the subject simply does not
  // have it. Deliberately "has nothing at all" rather than "has exactly the
  // prescribed type" — holding a role eligibly rather than actively is a
  // legitimate way to hold what it assigns, not an under-grant.
  if (!types?.size) return { missing: [wantsStanding ? 'Direct' : 'Eligible'], excess: [] };

  // MORE: a standing membership where the role only makes the subject eligible
  // — the access stands whether or not it is ever activated.
  const standing = STANDING_TYPES.some(t => types.has(t));
  if (wantsEligible && !wantsStanding && standing) return { missing: [], excess: ['Eligible'] };

  return NO_DEVIATION;
}

// Nothing to say about this cell: either no business role grants the resource,
// or one of the subject's roles assigns it to them.
export const NO_HELD_OUTSIDE = { count: 0, holdsGrantingRole: false };

/**
 * Does this subject hold this business role? Read off the coverage matview
 * rather than guessed: migration 061 gives a governance resource a self arm, so
 * a role covers its OWN cell exactly when the subject holds it. That is what
 * lets the marker below evaluate the *parent business role's assignments*
 * instead of inferring role membership from the absence of coverage — the two
 * are different findings and used to be reported as one (requestor feedback on
 * #370).
 *
 * @param {Map}    managedApMap - "resourceid|subjectid" (lower) → covering role ids (lower)
 * @param {string} roleId       - business role id, any case
 * @param {string} subjectId    - subject (column) id, any case
 */
export function holdsBusinessRole(managedApMap, roleId, subjectId) {
  const role = String(roleId || '').toLowerCase();
  if (!role) return false;
  return (managedApMap?.get(`${role}|${String(subjectId || '').toLowerCase()}`) || []).includes(role);
}

/**
 * The subject holds a resource that business roles hand out, and none of those
 * roles assigns it to them — so the membership stands outside the governance
 * meant to cover it.
 *
 * This is the same statement a folded role makes with its red count, said on the
 * resource's own row so folding and unfolding agree. Any covering role clears
 * it, not just one of the granting rows: a role only covers a cell by granting
 * that resource to a subject who holds the role, so a covering role explains the
 * membership whether or not it has a row of its own in the grid. Suppressing
 * only on the granting rows marked cells red that a business role outside the
 * current scope already accounted for.
 *
 * `holdsGrantingRole` reports whether the subject holds one of the granting
 * roles anyway — the role hands the resource out but has no assignment of it for
 * them. The two cases are worded differently, so the marker can never assert
 * that a subject does not hold a role it has not checked.
 *
 * @param {object}   args
 * @param {Set}      args.types        - membership types the subject actually has
 * @param {string[]} args.roleGrantIds - ids of the roles granting this row (upper)
 * @param {string[]} args.apIds        - ids of the roles covering this cell (lower)
 * @param {Function} [args.holdsRole]  - (roleId) => does the subject hold it?
 * @returns {{count: number, holdsGrantingRole: boolean}} count is 0 when a
 *          business role accounts for the access, else the number of roles in
 *          the grid that grant this resource
 */
export function heldOutsideRole({ types, roleGrantIds, apIds, holdsRole }) {
  if (!types?.size || !roleGrantIds?.length || apIds?.length) return NO_HELD_OUTSIDE;
  return {
    count: roleGrantIds.length,
    holdsGrantingRole: !!holdsRole && roleGrantIds.some(id => holdsRole(id)),
  };
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

// One (folded role, subject, folded row) triple: does it read as more, as less,
// or as exactly what the role assigns?
function tallyFoldedCell({ counts, key, types, covering, roleIdLower, apGroupMap, resourceKey }) {
  if (!covering.includes(roleIdLower)) {
    // The subject holds a resource this role folded away without this role
    // handing it out. It only counts when no business role they hold accounts
    // for the membership — otherwise the covering role explains it, which is
    // exactly what the row's own marker says when the role is unfolded.
    if (types?.size && covering.length === 0) bump(counts.extra, key);
    return;
  }
  const dev = cellDeviation({ types, apIds: [roleIdLower], apGroupMap, resourceKey });
  if (dev.missing.length) bump(counts.missing, key);
  if (dev.excess.length) bump(counts.extra, key);
}

/**
 * Per (folded role, subject column): how many of the rows the role folded away
 * deviate from what the role assigns — `extra` for more, `missing` for fewer.
 * Folding is a summary, never a cover-up: both counts stay on the folded row so
 * neither direction of drift can hide underneath it.
 *
 * @returns {{extra: Map, missing: Map}|null} null when nothing is folded
 */
export function buildRoleDeviationCounts({
  foldedChildRows, users, memberships, managedApMap, apGroupMap, userToAgg,
}) {
  if (!foldedChildRows || foldedChildRows.size === 0) return null;
  const counts = { extra: new Map(), missing: new Map() };

  for (const [roleId, hiddenRows] of foldedChildRows) {
    const roleIdLower = roleId.toLowerCase();
    for (const row of hiddenRows) {
      const resourceKey = String(row.realGroupId || row.id).toUpperCase();
      const coverageKey = resourceKey.toLowerCase();
      for (const u of users) {
        tallyFoldedCell({
          counts,
          // A folded subject column carries the tally of everyone behind it.
          key: `${roleId}|${userToAgg?.get(u.id) || u.id}`,
          types: memberships?.get(`${row.id}|${u.id}`),
          covering: managedApMap?.get(`${coverageKey}|${u.id.toLowerCase()}`) || [],
          roleIdLower,
          apGroupMap,
          resourceKey,
        });
      }
    }
  }
  return counts;
}
