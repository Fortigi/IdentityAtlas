// Pure data-shaping helpers for the rotated (subjects-as-rows) matrix.
// Kept out of the component so the index-build stays small and unit-testable.

function buildUser(d) {
  return {
    id: d.memberId,
    displayName: d.memberDisplayName || d.memberId,
    department: d.department || '',
    jobTitle: d.jobTitle || '',
    upn: d.memberUPN || '',
  };
}

function buildResource(rid, d) {
  return {
    id: rid,
    displayName: d.resourceDisplayName || d.groupDisplayName || rid,
    resourceType: d.resourceType || d.groupTypeCalculated || '',
    systemName: d.systemName || '',
  };
}

// Accumulate one assignment row into the cell map keyed by "userId|resourceId".
function addCell(cells, d, rid) {
  const key = `${d.memberId}|${rid}`;
  if (!cells.has(key)) cells.set(key, { types: new Set(), managed: false });
  cells.get(key).types.add(d.membershipType);
  if (d.managedByAccessPackage) cells.get(key).managed = true;
}

// Case-insensitive-ish alpha sort by displayName (null-safe).
export function byDisplayName(a, b) {
  return (a.displayName || '').localeCompare(b.displayName || '');
}

// Build per-user and per-resource indexes plus the cell map from the flat
// assignment rows. Users and resources come back sorted by displayName.
export function buildMatrixIndexes(rows) {
  const userMap = new Map();
  const resourceMap = new Map();
  const cells = new Map(); // "userId|resourceId" -> { types: Set, managed: bool }

  for (const d of rows) {
    if (d.memberId && !userMap.has(d.memberId)) {
      userMap.set(d.memberId, buildUser(d));
    }
    const rid = d.resourceId || d.groupId;
    if (rid && !resourceMap.has(rid)) {
      resourceMap.set(rid, buildResource(rid, d));
    }
    if (d.memberId && rid) {
      addCell(cells, d, rid);
    }
  }

  const users = [...userMap.values()].sort(byDisplayName);
  const resources = [...resourceMap.values()].sort(byDisplayName);
  return { users, resources, cellMap: cells };
}

// Group consecutive resources by resourceType for the merged top header.
export function buildTypeSpans(resources) {
  const spans = [];
  let i = 0;
  while (i < resources.length) {
    const t = resources[i].resourceType || '';
    let span = 1;
    while (i + span < resources.length && (resources[i + span].resourceType || '') === t) span++;
    spans.push({ type: t, span });
    i += span;
  }
  return spans;
}
