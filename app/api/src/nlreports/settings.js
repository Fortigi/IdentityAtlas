// Natural-language reports (PROTOTYPE) — which local model the report generator uses.
//
// Chosen by an admin under Admin → LLM and stored in WorkerConfig, like the
// cloud LLM config. Falls back to NL_REPORTS_DEFAULT_MODEL until one is picked.

import { query, queryOne } from '../db/connection.js';
import { DEFAULT_MODEL } from './ollama.js';

const CONFIG_KEY = 'NL_REPORTS_MODEL';

export async function getReportModel() {
  const row = await queryOne(`SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`, [CONFIG_KEY]);
  return row?.configValue || DEFAULT_MODEL;
}

export async function setReportModel(model) {
  await query(
    `INSERT INTO "WorkerConfig" ("configKey", "configValue", "updatedAt") VALUES ($1, $2, now() AT TIME ZONE 'utc')
     ON CONFLICT ("configKey") DO UPDATE SET "configValue" = EXCLUDED."configValue", "updatedAt" = EXCLUDED."updatedAt"`,
    [CONFIG_KEY, model],
  );
}
