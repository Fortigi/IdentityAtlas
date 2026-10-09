// Organisation truth — reading OrgImportProfiles rows (one version each).
//
// Shared by the profiles routes, POST /runs and the background run. A stored
// profile's recipe and linkRules are already normalised (contracts.js) — they
// are only ever written through POST/PUT /profiles, which validate first.
import { queryOne } from '../../db/connection.js';
import { isUuid } from './httpHelpers.js';

export const PROFILE_COLUMNS = `"id", "name", "version", "sourceKind", "recipe", "linkRules", "createdBy", "createdAt"`;

export async function getProfile(id) {
  if (!isUuid(id)) return null;
  return (await queryOne(`SELECT ${PROFILE_COLUMNS} FROM "OrgImportProfiles" WHERE "id" = $1`, [id])) ?? null;
}
