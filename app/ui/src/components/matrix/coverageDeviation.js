// How a subject's ACTUAL access (IST) on one cell deviates from what the
// business roles covering that cell prescribe (SOLL). Two directions, and one
// business role can carry both at once across the resources it grants:
//
//   missing — FEWER permissions than the role assigns (the provisioning gap)
//   excess  — MORE permissions than the role assigns
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

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

// One (folded role, subject, folded row) triple: does it read as more, as less,
// or as exactly what the role assigns?
function tallyFoldedCell({ counts, key, types, covered, roleIdLower, apGroupMap, resourceKey }) {
  if (!covered) {
    // The subject holds a resource this role folded away without this role
    // handing it out — access the role does not account for.
    if (types?.size) bump(counts.extra, key);
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
          covered: !!managedApMap?.get(`${coverageKey}|${u.id.toLowerCase()}`)?.includes(roleIdLower),
          roleIdLower,
          apGroupMap,
          resourceKey,
        });
      }
    }
  }
  return counts;
}
