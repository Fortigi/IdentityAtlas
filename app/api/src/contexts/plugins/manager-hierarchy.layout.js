// Optional layout steps of the manager-hierarchy plugin, applied to its basic
// output ({ contexts, members }): one unit per manager under a synthetic root.
// Each step is opt-in through a parameter, so an existing tree keeps its shape and
// its keys. Pure — run() reads the rows, these only rearrange.
//
//   splitBy        a manager whose people sit in several departments (or another
//                  attribute) gets one unit per value with at least splitMinMembers
//                  people; the largest group keeps the manager's own unit and key
//   nameFrom       'members': name a unit after what its people have in common,
//                  not after the manager (a CFO sits in the board's department,
//                  but runs Finance)
//   top            choose the top of the organisation (people by id, or a job
//                  title pattern) instead of "everyone without a manager"
//   notPlacedUnit  people and units not under the chosen top go to a visible
//                  "Not placed" unit instead of under the top itself

export const NOT_PLACED_EXTERNAL_ID = 'unplaced';
const SPLIT_SEP = '::';

export const splitExternalId = (managerId, value) => `${managerId}${SPLIT_SEP}${value}`;

const valueOf = (row, field) => {
  const v = row?.[field];
  return v == null ? '' : String(v).trim();
};

// The value of `field` that MORE THAN HALF of `rows` share, else ''. A unit whose
// people are spread over several departments (a CEO's heads of department) has no
// shared name — it keeps the manager's own.
export function majorityValue(rows, field) {
  const counts = new Map();
  for (const r of rows) {
    const v = valueOf(r, field);
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  for (const [v, n] of counts) if (n * 2 > rows.length) return v;
  return '';
}

function membersByUnit(members) {
  const map = new Map();
  for (const m of members) {
    if (!map.has(m.contextExternalId)) map.set(m.contextExternalId, []);
    map.get(m.contextExternalId).push(m);
  }
  return map;
}

// A manager's members grouped by their (non-empty) value of `field`, largest group first.
function rankedByValue(mine, byId, field) {
  const byValue = new Map();
  for (const m of mine) {
    const v = valueOf(byId.get(m.memberId), field);
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(m);
  }
  return [...byValue.entries()].filter(([v]) => v).sort((a, b) => b[1].length - a[1].length);
}

// Split a manager unit's members by `field`. Returns the new contexts and
// reassigns members (and the units of managers among them) in place.
export function splitUnits(result, byId, { field, minMembers = 2, managerIds, naming }) {
  if (!field) return result;
  const groups = membersByUnit(result.members);
  const added = [];
  const moved = new Map(); // memberId -> split unit externalId
  for (const managerId of managerIds) {
    const ranked = rankedByValue(groups.get(managerId) || [], byId, field);
    for (const [value, ms] of ranked.slice(1)) {
      if (ms.length < minMembers) continue;
      const ext = splitExternalId(managerId, value);
      added.push({ externalId: ext, displayName: naming(value, byId.get(managerId)), contextType: result.contexts[0]?.contextType, parentExternalId: managerId });
      for (const m of ms) { m.contextExternalId = ext; moved.set(m.memberId, ext); }
    }
  }
  for (const c of result.contexts) {
    if (moved.has(c.externalId)) c.parentExternalId = moved.get(c.externalId);
  }
  result.contexts.push(...added);
  return result;
}

// Rename every unit after what its members share (fields in order), keeping
// the manager's name when the plugin is asked to append it.
export function nameUnitsFromMembers(result, byId, { fields, buildName, rootExt }) {
  const groups = membersByUnit(result.members);
  for (const c of result.contexts) {
    if (c.externalId === rootExt || c.externalId === NOT_PLACED_EXTERNAL_ID) continue;
    const rows = (groups.get(c.externalId) || []).map(m => byId.get(m.memberId)).filter(Boolean);
    if (rows.length === 0) continue;
    const manager = byId.get(String(c.externalId).split(SPLIT_SEP)[0]);
    const shared = Object.fromEntries(fields.map(f => [f, majorityValue(rows, f) || manager?.[f]]));
    const name = buildName({ ...shared, displayName: manager?.displayName });
    if (name) c.displayName = name;
  }
  return result;
}

// The chosen top people: by id, or by a job-title pattern (an RE2 regex).
export function findTops(rows, { topPrincipalIds, topJobTitleRegex }) {
  if (Array.isArray(topPrincipalIds) && topPrincipalIds.length) {
    const wanted = new Set(topPrincipalIds.map(id => String(id).toLowerCase()));
    return new Set(rows.filter(r => wanted.has(String(r.id).toLowerCase())).map(r => r.id));
  }
  if (topJobTitleRegex) return new Set(rows.filter(r => r.jobTitle && topJobTitleRegex.test(r.jobTitle)).map(r => r.id));
  return null;
}

// Hang the chosen tops directly under the root; every other unit directly under
// the root goes to "Not placed" — with its whole subtree, so a team stays
// together. People directly under the root (no manager) go there too, except
// the tops themselves. Without chosen tops (notPlacedUnit only) the units stay
// and only the loose people move.
export function placeUnderTops(result, { tops, rootExt, notPlacedUnit }) {
  if (!tops && !notPlacedUnit) return result;
  const unplaced = { externalId: NOT_PLACED_EXTERNAL_ID, displayName: 'Not placed', contextType: result.contexts[0]?.contextType, parentExternalId: rootExt };
  const topUnits = new Set();
  for (const c of result.contexts) {
    if (tops?.has(c.externalId)) { c.parentExternalId = rootExt; topUnits.add(c.externalId); }
  }
  for (const c of result.contexts) {
    if (tops && c.externalId !== rootExt && !topUnits.has(c.externalId) && c.parentExternalId === rootExt) {
      c.parentExternalId = NOT_PLACED_EXTERNAL_ID;
    }
  }
  for (const m of result.members) {
    if (tops?.has(m.memberId)) { m.contextExternalId = rootExt; continue; }
    if (m.contextExternalId === rootExt) m.contextExternalId = NOT_PLACED_EXTERNAL_ID;
  }
  result.contexts.push(unplaced);
  return result;
}
