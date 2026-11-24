// The settings a generated tree was last built with, so the wizard can open on
// them. Read from the run that last wrote the tree: reconcile stamps every unit
// it produces with that run. A legacy tree without an instance key is not
// offered, because a run without a key would build a second tree.

import { parseTreeKey, baseUnitFilter } from '../adjustments/treeKey.js';

export async function loadTreeSettings(db, key) {
  const parsed = parseTreeKey(key);
  if (parsed?.kind !== 'generated' || !parsed.instanceKey) return null;
  const { sql, params } = baseUnitFilter(parsed);
  const row = await db.queryOne(`
    SELECT a.name AS "pluginName", r.parameters
      FROM "Contexts" c
      JOIN "ContextAlgorithms" a ON a.id = c."sourceAlgorithmId"
      JOIN "ContextAlgorithmRuns" r ON r.id = c."sourceRunId"
     WHERE ${sql}
     ORDER BY r."startedAt" DESC
     LIMIT 1
  `, params);
  if (!row) return null;
  const { instanceKey: _ignored, ...settings } = row.parameters || {};
  return { pluginName: row.pluginName, instanceKey: parsed.instanceKey, params: settings };
}
