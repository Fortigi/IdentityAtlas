// The relative-permission switches for context owners (Admin → Roles &
// Permissions → Relative permissions):
//
//   CONTEXT_OWNER_ACCESS  context owners may sign in and see their own contexts
//   CONTEXT_OWNER_BUSINESS_ROLES ... and also see the business roles they answer for
//   BUSINESS_ROLE_OWNER_REVIEW  a business role's Accountable or Responsible may
//                         sign off its composition review (see below)
//   CONTEXT_OWNER_MCP     ... and may also use the MCP server, under exactly the
//                         same scope (docs/architecture/mcp-authorization.md).
//                         Only has effect while CONTEXT_OWNER_ACCESS is on.
//
// Stored in WorkerConfig ('true' / 'false'), default off. The middleware asks for
// them only on the path of a signed-in user who would otherwise have no
// permissions, so each is read once and then held in memory; the admin route
// updates the held value when it saves, so a change takes effect on the next
// request without a restart (the same model as the role mapping in
// config/authConfig.js).
//
// A failed read is NOT remembered: on a fresh stack the WorkerConfig table may
// not exist yet, and "off" is the safe answer until it does.

import * as db from '../db/connection.js';

export const CONTEXT_OWNER_ACCESS_KEY = 'CONTEXT_OWNER_ACCESS';
export const CONTEXT_OWNER_MCP_KEY = 'CONTEXT_OWNER_MCP';

const useSql = () => process.env.USE_SQL === 'true';

const held = new Map(); // key → boolean, once read

async function readSwitch(key) {
  if (held.has(key)) return held.get(key);
  if (!useSql()) return false;
  try {
    const row = await db.queryOne(`SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`, [key]);
    const value = row?.configValue === 'true';
    held.set(key, value);
    return value;
  } catch (err) {
    console.warn(`contextOwnerSetting: could not read ${key}, treating it as off:`, err.message);
    return false;
  }
}

async function writeSwitch(key, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (useSql()) {
    await db.query(
      `INSERT INTO "WorkerConfig" ("configKey", "configValue")
            VALUES ($1, $2)
       ON CONFLICT ("configKey") DO UPDATE
          SET "configValue" = EXCLUDED."configValue",
              "updatedAt"   = (now() AT TIME ZONE 'utc')`,
      [key, enabled ? 'true' : 'false'],
    );
  }
  held.set(key, enabled);
  return enabled;
}

export const isContextOwnerAccessEnabled = () => readSwitch(CONTEXT_OWNER_ACCESS_KEY);
export const setContextOwnerAccess = (enabled) => writeSwitch(CONTEXT_OWNER_ACCESS_KEY, enabled);

/** Context owners may use the MCP server: both switches must be on. */
export async function isContextOwnerMcpEnabled() {
  return (await isContextOwnerAccessEnabled()) && readSwitch(CONTEXT_OWNER_MCP_KEY);
}
/** The stored MCP switch on its own, as the admin page shows it. */
export const getContextOwnerMcpSwitch = () => readSwitch(CONTEXT_OWNER_MCP_KEY);
export const setContextOwnerMcp = (enabled) => writeSwitch(CONTEXT_OWNER_MCP_KEY, enabled);

// Business-role owners may sign off a composition review: whoever is Accountable
// or Responsible for a business role may save a review of it without holding
// data.write.certifications (routes/details/businessRoleCompositionReview.js).
// Independent of the context-owner switch: it widens what a signed-in person may
// write on a role they answer for.
export const BUSINESS_ROLE_OWNER_REVIEW_KEY = 'BUSINESS_ROLE_OWNER_REVIEW';
export const isBusinessRoleOwnerReviewEnabled = () => readSwitch(BUSINESS_ROLE_OWNER_REVIEW_KEY);
export const setBusinessRoleOwnerReview = (enabled) => writeSwitch(BUSINESS_ROLE_OWNER_REVIEW_KEY, enabled);

// Context owners also see the business roles they answer for: a context owner
// who is Accountable or Responsible for a business role gets a Business roles
// tab with those roles, may open each (read-only) and its composition review.
// Only has effect while CONTEXT_OWNER_ACCESS is on; nobody signs in because of
// it who could not already.
export const CONTEXT_OWNER_BUSINESS_ROLES_KEY = 'CONTEXT_OWNER_BUSINESS_ROLES';
/** Context owners see their business roles: both switches must be on. */
export async function isContextOwnerBusinessRolesEnabled() {
  return (await isContextOwnerAccessEnabled()) && readSwitch(CONTEXT_OWNER_BUSINESS_ROLES_KEY);
}
/** The stored switch on its own, as the admin page shows it. */
export const getContextOwnerBusinessRolesSwitch = () => readSwitch(CONTEXT_OWNER_BUSINESS_ROLES_KEY);
export const setContextOwnerBusinessRoles = (enabled) => writeSwitch(CONTEXT_OWNER_BUSINESS_ROLES_KEY, enabled);

// Tests only: forget the held values so the next read goes to the database.
export function resetContextOwnerSettingForTests() {
  held.clear();
}
