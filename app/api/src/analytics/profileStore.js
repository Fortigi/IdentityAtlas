// Analytics Profile persistence (migration 084).
//
// "AnalyticsProfiles" holds the current definition; every save appends the full
// definition to "AnalyticsProfileVersions" in the same transaction, so a number
// produced under profile version N can always be traced to what N said.
// Updates are optimistic: the caller names the version it edited, and a stale
// write is refused rather than silently overwriting a colleague's change.
// Retiring is a new version with status 'retired' — nothing is deleted.

import * as db from '../db/connection.js';
import { AnalyticsError } from './shaping.js';

const COLUMNS = `"id", "name", "description", "status", "version", "definition",
  "createdBy", "createdAt", "updatedBy", "updatedAt"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `id` can be a profile id (avoids a uuid cast error → 500). */
export const isProfileId = id => typeof id === 'string' && UUID.test(id);

// 23505 = unique_violation: the case-insensitive name index.
function nameTaken(err) {
  return err?.code === '23505'
    ? new AnalyticsError(409, 'name_taken', 'A profile with this name already exists.')
    : err;
}

async function appendVersion(client, row, actor) {
  await client.query(
    `INSERT INTO "AnalyticsProfileVersions" ("profileId","version","name","status","definition","changedBy")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [row.id, row.version, row.name, row.status, JSON.stringify(row.definition), actor]);
}

export async function listProfiles() {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM "AnalyticsProfiles" ORDER BY lower("name")`);
  return rows;
}

export async function getProfile(id) {
  if (!isProfileId(id)) return null;
  return db.queryOne(`SELECT ${COLUMNS} FROM "AnalyticsProfiles" WHERE "id" = $1`, [id]);
}

export async function listVersions(id) {
  if (!isProfileId(id)) return [];
  const { rows } = await db.query(
    `SELECT "version","name","status","definition","changedBy","changedAt"
       FROM "AnalyticsProfileVersions" WHERE "profileId" = $1 ORDER BY "version" DESC`, [id]);
  return rows;
}

/** Create a profile (version 1). `profile` is validateProfileInput()'s output. */
export async function createProfile(profile, actor) {
  try {
    return await db.tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO "AnalyticsProfiles" ("name","description","status","version","definition","createdBy","updatedBy")
         VALUES ($1, $2, $3, 1, $4::jsonb, $5, $5) RETURNING ${COLUMNS}`,
        [profile.name, profile.description, profile.status, JSON.stringify(profile.definition), actor]);
      await appendVersion(client, rows[0], actor);
      return rows[0];
    });
  } catch (err) {
    throw nameTaken(err);
  }
}

/**
 * Replace a profile's name/description/status/definition. `expectedVersion`
 * must equal the stored version; the new row has version + 1.
 */
export async function updateProfile(id, profile, expectedVersion, actor) {
  if (!isProfileId(id)) throw new AnalyticsError(404, 'not_found', 'No such profile.');
  try {
    return await db.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE "AnalyticsProfiles"
            SET "name" = $2, "description" = $3, "status" = $4, "definition" = $5::jsonb,
                "version" = "version" + 1, "updatedBy" = $6, "updatedAt" = now()
          WHERE "id" = $1 AND "version" = $7
          RETURNING ${COLUMNS}`,
        [id, profile.name, profile.description, profile.status, JSON.stringify(profile.definition), actor, expectedVersion]);
      if (rows.length === 0) {
        const exists = await client.query(`SELECT "version" FROM "AnalyticsProfiles" WHERE "id" = $1`, [id]);
        if (exists.rows.length === 0) throw new AnalyticsError(404, 'not_found', 'No such profile.');
        throw new AnalyticsError(409, 'version_conflict',
          `The profile was changed by someone else (now version ${exists.rows[0].version}). Reload and try again.`,
          { currentVersion: exists.rows[0].version });
      }
      await appendVersion(client, rows[0], actor);
      return rows[0];
    });
  } catch (err) {
    throw nameTaken(err);
  }
}
