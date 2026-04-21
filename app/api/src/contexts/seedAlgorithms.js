// Seeds the ContextAlgorithms table from the static registry at container
// startup. Idempotent — safe to call on every boot.
//
// For each plugin in REGISTERED_PLUGINS, insert-or-update a row with the
// same `name`. This keeps the UI picker in sync with the in-tree plugins
// without manual DB edits. Rows in ContextAlgorithms that no longer have a
// matching plugin are left alone (they may still be referenced by existing
// ContextAlgorithmRuns or Contexts.sourceAlgorithmId).

import { randomUUID } from 'crypto';
import * as db from '../db/connection.js';
import { REGISTERED_PLUGINS } from './plugins/registry.js';

export async function seedContextAlgorithms() {
  for (const p of REGISTERED_PLUGINS) {
    const existing = await db.queryOne(
      `SELECT id FROM "ContextAlgorithms" WHERE name = $1`, [p.name]
    );
    if (existing) {
      await db.query(`
        UPDATE "ContextAlgorithms"
           SET "displayName"      = $2,
               description        = $3,
               "targetType"       = $4,
               "parametersSchema" = $5,
               enabled            = TRUE
         WHERE id = $1
      `, [existing.id, p.displayName, p.description || null, p.targetType, p.parametersSchema || null]);
    } else {
      await db.query(`
        INSERT INTO "ContextAlgorithms"
          (id, name, "displayName", description, "targetType", "parametersSchema", enabled)
        VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      `, [randomUUID(), p.name, p.displayName, p.description || null, p.targetType, p.parametersSchema || null]);
    }
  }
  console.log(`Context-algorithm registry: ${REGISTERED_PLUGINS.length} plugin(s) seeded`);
}
