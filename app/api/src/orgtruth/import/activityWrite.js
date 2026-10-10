// Organisation truth — write the facts of one activity run.
//
//   writeActivities({ client, run, source, profile, facts })
//     → { inserted, deleted, keyIds: { actor: Map<rawValue, id>, subject: Map<rawValue, id> } }
//
// Runs on the caller's transaction client. Keys first: one OrgActivityKeys row per
// (profile NAME, role, raw value), inserted when new and otherwise left as it is,
// so a decision (the engine's or the analyst's) survives every re-import. Then the
// facts: a FULL run first deletes every activity of the profile name (the file is
// the whole history), a DELTA run only appends.
import { randomUUID } from 'node:crypto';
import { CHUNK } from './writeRun.js';
import { distinctKeys } from './activityParse.js';

export const KEY_CHUNK = 5000;
export const ROLES = ['actor', 'subject'];

const SQL = {
  upsertKeys: `
    INSERT INTO "OrgActivityKeys" ("id", "profileName", "role", "rawValue")
    SELECT u.id, $1, u.role, u.raw FROM unnest($2::uuid[], $3::text[], $4::text[]) AS u(id, role, raw)
    ON CONFLICT ("profileName", "role", "rawValue") DO NOTHING`,
  keyIds: `
    SELECT "id", "rawValue" FROM "OrgActivityKeys"
     WHERE "profileName" = $1 AND "role" = $2 AND "rawValue" = ANY($3::text[])`,
  deleteActivities: `DELETE FROM "OrgActivities" WHERE "profileName" = $1`,
  insertActivities: `
    INSERT INTO "OrgActivities" ("id", "profileName", "activityType", "profileId", "runId", "sourceId", "sourceLocator",
                                 "actorKeyId", "subjectKeyId", "occurredOn", "periodEnd", "measure", "unit", "attributes")
    SELECT v."id", $2, $3, $4, $5, $6, v."sourceLocator", v."actorKeyId", v."subjectKeyId",
           v."occurredOn", v."periodEnd", v."measure", v."unit", v."attributes"
      FROM jsonb_to_recordset($1::jsonb) AS v("id" uuid, "sourceLocator" text, "actorKeyId" uuid, "subjectKeyId" uuid,
                                              "occurredOn" date, "periodEnd" date, "measure" numeric, "unit" text, "attributes" jsonb)`,
};

async function upsertRoleKeys(client, profileName, role, values) {
  const ids = new Map();
  for (let i = 0; i < values.length; i += KEY_CHUNK) {
    const part = values.slice(i, i + KEY_CHUNK);
    await client.query(SQL.upsertKeys, [profileName, part.map(() => randomUUID()), part.map(() => role), part]);
    const r = await client.query(SQL.keyIds, [profileName, role, part]);
    for (const row of r.rows) ids.set(row.rawValue, row.id);
  }
  return ids;
}

export async function upsertKeys(client, profileName, facts) {
  const distinct = distinctKeys(facts);
  const keyIds = {};
  for (const role of ROLES) keyIds[role] = await upsertRoleKeys(client, profileName, role, [...distinct[role].keys()]);
  return keyIds;
}

export async function writeActivities({ client, run, source, profile, facts }) {
  const keyIds = await upsertKeys(client, profile.name, facts);
  const deleted = run.mode === 'full' ? ((await client.query(SQL.deleteActivities, [profile.name])).rowCount ?? 0) : 0;
  const rows = facts.map(f => ({
    id: randomUUID(), sourceLocator: f.sourceLocator,
    actorKeyId: keyIds.actor.get(f.actor) ?? null, subjectKeyId: keyIds.subject.get(f.subject) ?? null,
    occurredOn: f.occurredOn, periodEnd: f.periodEnd, measure: f.measure, unit: f.unit, attributes: f.attributes,
  }));
  const params = [profile.name, profile.recipe.activity.type, profile.id, run.id, source.id];
  for (let i = 0; i < rows.length; i += CHUNK) {
    await client.query(SQL.insertActivities, [JSON.stringify(rows.slice(i, i + CHUNK)), ...params]);
  }
  return { inserted: rows.length, deleted, keyIds };
}
