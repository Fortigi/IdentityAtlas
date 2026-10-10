// Organisation truth — reading and writing OrgSources rows.
//
// Everything that needs a stored source (the sources routes, the dry-run, the
// background run) goes through here, so the "never return `content` unless
// asked" rule lives in one place.
import { createHash, randomUUID } from 'node:crypto';
import { query, queryOne, tx } from '../../db/connection.js';
import { parseList } from './parse.js';
import { isUuid } from './httpHelpers.js';

// Every column except the bytes.
export const SOURCE_COLUMNS = `"id", "kind", "displayName", "fileName", "mimeType", "byteSize", "sha256",
       "observedAt", "uploadedBy", "createdAt"`;

export async function getSource(id) {
  if (!isUuid(id)) return null;
  return (await queryOne(`SELECT ${SOURCE_COLUMNS} FROM "OrgSources" WHERE "id" = $1`, [id])) ?? null;
}

export async function getSourceWithContent(id) {
  if (!isUuid(id)) return null;
  return (await queryOne(`SELECT ${SOURCE_COLUMNS}, "content" FROM "OrgSources" WHERE "id" = $1`, [id])) ?? null;
}

export async function listSources() {
  const r = await query(`
    SELECT ${SOURCE_COLUMNS},
           (SELECT count(*)::int FROM "OrgImportRuns" r WHERE r."sourceId" = s."id") AS "runCount",
           (SELECT max(r."createdAt") FROM "OrgImportRuns" r WHERE r."sourceId" = s."id") AS "lastRunAt"
      FROM "OrgSources" s
     ORDER BY s."createdAt" DESC`);
  return r.rows;
}

// A queued or running import of this source, or null.
export async function findActiveRunForSource(id) {
  return (await queryOne(`SELECT "id" FROM "OrgImportRuns" WHERE "sourceId" = $1 AND "status" IN ('queued', 'running') LIMIT 1`, [id])) ?? null;
}

// Delete the source and, through the foreign keys, its runs, entities,
// relations, links and activities. An activity profile name left without any
// activity loses its keys too (the values and the decisions on them): nothing
// refers to them any more. Returns the deleted row (id, displayName) or null.
const ACTIVITY_PROFILES_SQL = `SELECT DISTINCT "profileName" FROM "OrgActivities" WHERE "sourceId" = $1`;
export const ORPHAN_KEYS_SQL = `
  DELETE FROM "OrgActivityKeys" k
   WHERE k."profileName" = ANY($1::text[])
     AND NOT EXISTS (SELECT 1 FROM "OrgActivities" a WHERE a."profileName" = k."profileName")`;

export async function deleteSource(id) {
  if (!isUuid(id)) return null;
  return tx(async (client) => {
    const names = (await client.query(ACTIVITY_PROFILES_SQL, [id])).rows.map(r => r.profileName);
    const row = (await client.query(`DELETE FROM "OrgSources" WHERE "id" = $1 RETURNING "id", "displayName"`, [id])).rows[0] ?? null;
    if (row && names.length > 0) await client.query(ORPHAN_KEYS_SQL, [names]);
    return row;
  });
}

// The stored bytes as columns + rows (parse.js). Throws ListParseError for a
// file that no longer parses.
export function readSourceTable(source) {
  return parseList(Buffer.from(source.content ?? []), { fileName: source.fileName ?? '', mimeType: source.mimeType ?? '' });
}

export async function insertSource({ kind, displayName, fileName, mimeType, buffer, observedAt, uploadedBy }) {
  return queryOne(`
    INSERT INTO "OrgSources" ("id", "kind", "displayName", "fileName", "mimeType", "byteSize", "sha256", "content", "observedAt", "uploadedBy")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING ${SOURCE_COLUMNS}`,
  [randomUUID(), kind, displayName, fileName, mimeType, buffer.length,
    createHash('sha256').update(buffer).digest('hex'), buffer, observedAt, uploadedBy]);
}
