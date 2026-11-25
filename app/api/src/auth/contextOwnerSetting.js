// Where the relative-permission policy (auth/relativePermissions.js) is kept:
// WorkerConfig key RELATIVE_PERMISSIONS, a JSON grid. Admin → Roles &
// Permissions → Relative permissions reads and saves it.
//
// Before anyone saved the grid, the policy is what the four switches it
// replaced stood for (legacyPolicy), read from their own keys — so an upgrade
// keeps exactly the access people had, and nothing is written until an admin
// saves. Once the grid is saved those keys are no longer read.
//
// The middleware asks for the policy only on the path of a signed-in user who
// would otherwise have no permissions, so it is read once and then held in
// memory; the admin route replaces the held value when it saves, so a change
// takes effect on the next request without a restart (the same model as the
// role mapping in config/authConfig.js).
//
// A failed read is NOT remembered: on a fresh stack the WorkerConfig table may
// not exist yet, and "everything off" is the safe answer until it does.

import * as db from '../db/connection.js';
import { anyContextAllows, legacyPolicy, normalizePolicy } from './relativePermissions.js';

export const RELATIVE_PERMISSIONS_KEY = 'RELATIVE_PERMISSIONS';
// The switches the grid replaced — read only while the grid was never saved.
export const LEGACY_KEYS = Object.freeze({
  access: 'CONTEXT_OWNER_ACCESS',
  mcp: 'CONTEXT_OWNER_MCP',
  businessRoles: 'CONTEXT_OWNER_BUSINESS_ROLES',
  ownerReview: 'BUSINESS_ROLE_OWNER_REVIEW',
});

const useSql = () => process.env.USE_SQL === 'true';
const ALL_OFF = () => legacyPolicy();

let held = null; // the policy, once read

function parseStored(value) {
  try {
    return normalizePolicy(JSON.parse(value));
  } catch (err) {
    console.warn(`contextOwnerSetting: ${RELATIVE_PERMISSIONS_KEY} is not valid JSON, treating everything as off:`, err.message);
    return ALL_OFF();
  }
}

function fromRows(rows) {
  const byKey = new Map(rows.map(r => [r.configKey, r.configValue]));
  if (byKey.has(RELATIVE_PERMISSIONS_KEY)) return parseStored(byKey.get(RELATIVE_PERMISSIONS_KEY));
  const legacy = Object.fromEntries(Object.entries(LEGACY_KEYS).map(([name, key]) => [name, byKey.get(key) === 'true']));
  return legacyPolicy(legacy);
}

/** The policy in force (normalized, complete for today's subjects). */
export async function getRelativePolicy() {
  if (held) return held;
  if (!useSql()) return ALL_OFF();
  try {
    const { rows } = await db.query(
      `SELECT "configKey", "configValue" FROM "WorkerConfig" WHERE "configKey" = ANY($1::text[])`,
      [[RELATIVE_PERMISSIONS_KEY, ...Object.values(LEGACY_KEYS)]],
    );
    held = fromRows(rows);
    return held;
  } catch (err) {
    console.warn('contextOwnerSetting: could not read the relative permissions, treating everything as off:', err.message);
    return ALL_OFF();
  }
}

/** Save a policy (normalized first) and put it in force. Returns what was saved. */
export async function setRelativePolicy(policy) {
  const normalized = normalizePolicy(policy);
  if (useSql()) {
    await db.query(
      `INSERT INTO "WorkerConfig" ("configKey", "configValue")
            VALUES ($1, $2)
       ON CONFLICT ("configKey") DO UPDATE
          SET "configValue" = EXCLUDED."configValue",
              "updatedAt"   = (now() AT TIME ZONE 'utc')`,
      [RELATIVE_PERMISSIONS_KEY, JSON.stringify(normalized)],
    );
  }
  held = normalized;
  return normalized;
}

/** May anybody use the MCP server as a context owner? (A cheap gate before resolving who the caller is.) */
export async function isContextOwnerMcpEnabled() {
  return anyContextAllows(await getRelativePolicy(), 'mcp');
}

// Tests only: forget the held policy so the next read goes to the database.
export function resetContextOwnerSettingForTests() {
  held = null;
}
