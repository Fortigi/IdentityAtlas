// Helpers for GET /api/user-columns (filter-dropdown column names + distinct
// values), extracted from routes/permissions/grid.js so the handler stays under
// the complexity threshold. Behaviour is unchanged — the
// mock double-loop and the SQL + tag-augmentation path are moved verbatim.

import { permissionAssignments } from '../../mock/data.js';
import { ensureTagTables } from '../tags.js';
import { getPrincipalOrUserColumns, getPrincipalOrUserColumnValues } from '../../db/columnCache.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { withAttributeLabels } from '../../lib/attributeLabels.js';

// Assignment keys that are group/member identity columns, not filterable user
// attributes — excluded from the derived dropdown list.
const NON_FILTER_COLS = [
  'groupId', 'memberId', 'memberDisplayName', 'memberUPN', 'memberType',
  'groupDisplayName', 'groupTypeCalculated', 'groupDescription',
  'membershipType', 'managedByAccessPackage',
];

// Accumulate `{ columnName -> Set(distinctValues) }` from the mock dataset,
// skipping identity columns and empty cells. With `schemaOnly` the sets stay
// empty (only column presence matters).
function collectMockColumnSets(schemaOnly) {
  const mockCols = {};
  for (const row of permissionAssignments) {
    for (const [key, val] of Object.entries(row)) {
      if (NON_FILTER_COLS.includes(key)) continue;
      if (val == null || val === '') continue;
      if (!mockCols[key]) mockCols[key] = new Set();
      if (!schemaOnly) mockCols[key].add(String(val));
    }
  }
  return mockCols;
}

// Mock path: derive filterable columns (+ distinct values) from the mock
// dataset. `schemaOnly` returns column names with empty value lists.
export function buildMockUserColumns(schemaOnly) {
  const mockCols = collectMockColumnSets(schemaOnly);
  return Object.entries(mockCols)
    .filter(([, vals]) => schemaOnly || (vals.size >= 1 && vals.size <= 500))
    .map(([column, vals]) => ({ column, values: schemaOnly ? [] : [...vals].sort() }));
}

// SQL path: column names (schemaOnly, fast ~100ms) or cached distinct values
// (5-min TTL — avoids a 44s UNION ALL on every load), then augment with the
// virtual `__userTag` column. Missing tag schema is swallowed silently.
export async function fetchUserColumnValues(p, schemaOnly, res) {
  let grouped;
  if (schemaOnly) {
    // Fast: just schema names, no distinct value scan
    const cols = await getPrincipalOrUserColumns(p);
    grouped = Object.fromEntries(cols.map(c => [c.name, []]));
  } else {
    // Slow: cached distinct values
    grouped = { ...await getPrincipalOrUserColumnValues(p) };
  }

  // Add virtual __userTag column
  try {
    await ensureTagTables(p);
    const tagResult = await timedQuery(p, 'user-columns-tags', res, `
      SELECT t.name
      FROM "GraphTags" t
      WHERE t."entityType" = 'user'
        AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
      ORDER BY t.name
    `, []);
    const userTags = tagResult.rows.map(r => r.name);
    grouped['__userTag'] = userTags; // always include values — tag query is fast
  } catch (e) { if (!isMissingSchema(e)) throw e; /* tag tables may not exist yet — skip silently */ }

  return withAttributeLabels(
    Object.entries(grouped).map(([column, values]) => ({ column, values })), 'principal');
}
