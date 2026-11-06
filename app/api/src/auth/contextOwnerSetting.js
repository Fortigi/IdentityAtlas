// The "context owners may sign in" switch (Admin → Authentication).
//
// Stored in WorkerConfig as CONTEXT_OWNER_ACCESS ('true' / 'false'), default
// off. The middleware asks for it only on the path of a signed-in user who would
// otherwise have no permissions, so it is read once and then held in memory; the
// admin route updates the held value when it saves, so a change takes effect on
// the next request without a restart (the same model as the role mapping in
// config/authConfig.js).
//
// A failed read is NOT remembered: on a fresh stack the WorkerConfig table may
// not exist yet, and "off" is the safe answer until it does.

import * as db from '../db/connection.js';

export const CONTEXT_OWNER_ACCESS_KEY = 'CONTEXT_OWNER_ACCESS';

const useSql = () => process.env.USE_SQL === 'true';

let held = null; // null = not read yet; otherwise the boolean

export async function isContextOwnerAccessEnabled() {
  if (held !== null) return held;
  if (!useSql()) return false;
  try {
    const row = await db.queryOne(
      `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
      [CONTEXT_OWNER_ACCESS_KEY],
    );
    held = row?.configValue === 'true';
    return held;
  } catch (err) {
    console.warn('contextOwnerSetting: could not read CONTEXT_OWNER_ACCESS, treating it as off:', err.message);
    return false;
  }
}

export async function setContextOwnerAccess(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (useSql()) {
    await db.query(
      `INSERT INTO "WorkerConfig" ("configKey", "configValue")
            VALUES ($1, $2)
       ON CONFLICT ("configKey") DO UPDATE
          SET "configValue" = EXCLUDED."configValue",
              "updatedAt"   = (now() AT TIME ZONE 'utc')`,
      [CONTEXT_OWNER_ACCESS_KEY, enabled ? 'true' : 'false'],
    );
  }
  held = enabled;
  return held;
}

// Tests only: forget the held value so the next read goes to the database.
export function resetContextOwnerSettingForTests() {
  held = null;
}
