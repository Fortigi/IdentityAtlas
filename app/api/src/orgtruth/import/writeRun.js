// Organisation truth — write the entities and relations of one run.
//
//   writeRun({ client, run, source, profile, entities, relations })
//     → { entitiesInserted, entitiesUpdated, entitiesClosed,
//         relationsInserted, relationsUpdated, relationsClosed }
//
// Runs on the transaction client the caller opened (db/connection.js tx), so a
// failure leaves nothing half-written. `entities` / `relations` are what
// applyRecipe.js produced.
//
// Entities: an OPEN row (validTo IS NULL) with the same (entityType,
// canonicalKey) in this profile is updated in place — displayName,
// attributes, sourceId, sourceLocator, runId, observedAt — and the history
// trigger keeps the old values. Otherwise a new row: origin 'import', status
// 'accepted', validFrom = the source's observedAt.
// Relations: the same, matched on (fromEntityId, toEntityId, predicate) among
// the open relations of this profile's entities.
// Full mode only: afterwards every open import-origin entity and relation of
// this profile that this run did not touch gets validTo = observedAt. Delta
// mode closes nothing. Analyst- or model-origin claims are never closed.
//
// DECISION (T1, for T2/T4/T7): "this profile" means every VERSION of the
// profile, i.e. every OrgImportProfiles row with the same `name`. A new
// version (PUT /profiles/:id) gets a new id, but it describes the same list,
// so its runs must update — not duplicate — what earlier versions wrote. A row
// this run touches is re-stamped with the run's profile id, so `profileId` on
// an open entity is the version that last wrote it. Readers that want "the
// entities of profile X" should join on the name, not the id.
//
// Bulk SQL (jsonb_to_recordset, CHUNK rows per statement) keeps a 200 000-row
// list to a few hundred round-trips. Every value travels as a parameter.
import { randomUUID } from 'node:crypto';
import { entityKey } from './applyRecipe.js';

export const CHUNK = 1000;
const SEP = '\u0000';
const LINEAGE = `SELECT "id" FROM "OrgImportProfiles" WHERE "name" = $1`;

const SQL = {
  openEntities: `
    SELECT "id", "entityType", "canonicalKey" FROM "OrgEntities"
     WHERE "validTo" IS NULL AND "canonicalKey" IS NOT NULL AND "profileId" IN (${LINEAGE})`,
  updateEntities: `
    UPDATE "OrgEntities" AS e
       SET "displayName" = v."displayName", "attributes" = v."attributes", "sourceId" = $2,
           "sourceLocator" = v."sourceLocator", "runId" = $3, "observedAt" = $4, "profileId" = $5
      FROM jsonb_to_recordset($1::jsonb) AS v("id" uuid, "displayName" text, "attributes" jsonb, "sourceLocator" text)
     WHERE e."id" = v."id"`,
  insertEntities: `
    INSERT INTO "OrgEntities" ("id", "entityType", "displayName", "canonicalKey", "profileId", "attributes",
                               "sourceId", "sourceLocator", "runId", "origin", "status", "observedAt", "validFrom", "createdBy")
    SELECT v."id", v."entityType", v."displayName", v."canonicalKey", $5, v."attributes",
           $2, v."sourceLocator", $3, 'import', 'accepted', $4, $4, $6
      FROM jsonb_to_recordset($1::jsonb) AS v("id" uuid, "entityType" text, "displayName" text, "canonicalKey" text, "attributes" jsonb, "sourceLocator" text)`,
  openRelations: `
    SELECT r."id", r."fromEntityId", r."toEntityId", r."predicate" FROM "OrgRelations" r
      JOIN "OrgEntities" e ON e."id" = r."fromEntityId"
     WHERE r."validTo" IS NULL AND e."profileId" IN (${LINEAGE})`,
  updateRelations: `
    UPDATE "OrgRelations" AS r
       SET "sourceId" = $2, "sourceLocator" = v."sourceLocator", "runId" = $3, "observedAt" = $4
      FROM jsonb_to_recordset($1::jsonb) AS v("id" uuid, "sourceLocator" text)
     WHERE r."id" = v."id"`,
  insertRelations: `
    INSERT INTO "OrgRelations" ("id", "fromEntityId", "toEntityId", "predicate", "sourceId", "sourceLocator",
                                "runId", "origin", "status", "observedAt", "validFrom", "createdBy")
    SELECT v."id", v."fromEntityId", v."toEntityId", v."predicate", $2, v."sourceLocator",
           $3, 'import', 'accepted', $4, $4, $5
      FROM jsonb_to_recordset($1::jsonb) AS v("id" uuid, "fromEntityId" uuid, "toEntityId" uuid, "predicate" text, "sourceLocator" text)`,
  closeEntities: `
    UPDATE "OrgEntities" SET "validTo" = $2
     WHERE "validTo" IS NULL AND "origin" = 'import' AND "runId" IS DISTINCT FROM $3
       AND "profileId" IN (${LINEAGE})`,
  closeRelations: `
    UPDATE "OrgRelations" AS r SET "validTo" = $2
      FROM "OrgEntities" e
     WHERE e."id" = r."fromEntityId" AND r."validTo" IS NULL AND r."origin" = 'import'
       AND r."runId" IS DISTINCT FROM $3 AND e."profileId" IN (${LINEAGE})`,
};

async function inChunks(client, sql, items, params) {
  for (let i = 0; i < items.length; i += CHUNK) {
    await client.query(sql, [JSON.stringify(items.slice(i, i + CHUNK)), ...params]);
  }
}

async function writeEntities(ctx, entities) {
  const open = await ctx.client.query(SQL.openEntities, [ctx.profileName]);
  const openIds = new Map(open.rows.map(r => [entityKey(r.entityType, r.canonicalKey), r.id]));
  const updates = [];
  const inserts = [];
  const idByKey = new Map();
  for (const e of entities) {
    const k = entityKey(e.entityType, e.canonicalKey);
    let id = openIds.get(k);
    if (id) {
      updates.push({ id, displayName: e.displayName, attributes: e.attributes, sourceLocator: e.sourceLocator });
    } else {
      id = randomUUID();
      inserts.push({ id, entityType: e.entityType, canonicalKey: e.canonicalKey, displayName: e.displayName, attributes: e.attributes, sourceLocator: e.sourceLocator });
    }
    idByKey.set(k, id);
  }
  const common = [ctx.sourceId, ctx.runId, ctx.observedAt, ctx.profileId];
  await inChunks(ctx.client, SQL.updateEntities, updates, common);
  await inChunks(ctx.client, SQL.insertEntities, inserts, [...common, ctx.createdBy]);
  return { inserted: inserts.length, updated: updates.length, idByKey };
}

async function writeRelations(ctx, relations, idByKey) {
  const open = await ctx.client.query(SQL.openRelations, [ctx.profileName]);
  const openIds = new Map(open.rows.map(r => [[r.fromEntityId, r.toEntityId, r.predicate].join(SEP), r.id]));
  const updates = [];
  const inserts = [];
  for (const rel of relations) {
    const fromEntityId = idByKey.get(entityKey(rel.fromType, rel.fromKey));
    const toEntityId = idByKey.get(entityKey(rel.toType, rel.toKey));
    if (!fromEntityId || !toEntityId) continue; // not produced by this run's entities
    const id = openIds.get([fromEntityId, toEntityId, rel.predicate].join(SEP));
    if (id) updates.push({ id, sourceLocator: rel.sourceLocator });
    else inserts.push({ id: randomUUID(), fromEntityId, toEntityId, predicate: rel.predicate, sourceLocator: rel.sourceLocator });
  }
  const common = [ctx.sourceId, ctx.runId, ctx.observedAt];
  await inChunks(ctx.client, SQL.updateRelations, updates, common);
  await inChunks(ctx.client, SQL.insertRelations, inserts, [...common, ctx.createdBy]);
  return { inserted: inserts.length, updated: updates.length };
}

async function closeUntouched(ctx) {
  const params = [ctx.profileName, ctx.observedAt, ctx.runId];
  const relations = await ctx.client.query(SQL.closeRelations, params);
  const entities = await ctx.client.query(SQL.closeEntities, params);
  return { entities: entities.rowCount ?? 0, relations: relations.rowCount ?? 0 };
}

export async function writeRun({ client, run, source, profile, entities, relations }) {
  const ctx = {
    client, runId: run.id, sourceId: source.id, observedAt: source.observedAt,
    profileId: profile.id, profileName: profile.name, createdBy: run.triggeredBy ?? null,
  };
  try {
    const ent = await writeEntities(ctx, entities);
    const rel = await writeRelations(ctx, relations, ent.idByKey);
    const closed = run.mode === 'full' ? await closeUntouched(ctx) : { entities: 0, relations: 0 };
    return {
      entitiesInserted: ent.inserted, entitiesUpdated: ent.updated, entitiesClosed: closed.entities,
      relationsInserted: rel.inserted, relationsUpdated: rel.updated, relationsClosed: closed.relations,
    };
  } catch (err) {
    if (err?.code === '23505') {
      throw new Error('Another run of this profile wrote the same entities at the same time; nothing was saved. Start the run again.', { cause: err });
    }
    throw err;
  }
}
