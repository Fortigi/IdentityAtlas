// Organisation truth — link the entities of one run to the system truth
// (owned by workstream T2). Called by the import run (T1) once the entities
// and relations of that run are written, inside the same background job.
//
// Contract:
//   linkRun({ runId, profile, log }) → { runId, linked, proposed, ambiguous, none, rejected }
//
// `profile` is the normalised profile row ({ recipe, linkRules }); linkRules
// may still be a JSONB string from a raw row. The function reads the run's open
// entities ("runId" = $1, "validTo" IS NULL), scores every candidate per link
// rule (score.js), plans the writes against the links already stored
// (plan.js: analyst overrides win, stale links are rejected, never deleted),
// and writes them in one transaction. Counts:
//   linked     entities with an accepted link (incl. ones an analyst pinned)
//   proposed   entities whose best candidate is under the threshold
//   ambiguous  entities with a tie at/above the threshold
//   none       entities with no candidate worth reviewing
//   rejected   stored links this run set to 'rejected' (additive to the stub's shape)
//
// OrgLinks."signals" (TEXT) holds the NAMES of the signals that matched, as a
// comma-separated string without spaces, e.g. "email,name" (normalizeLinkRules
// defaults a name to "<attribute>→<targetField>"). The UI splits it on ",".
// "matchedField"/"matchedValue" are those of the strongest matching signal.
//
// The target tables are read OUTSIDE the transaction (a large read, no locks
// needed); the existing links are read inside it, so a concurrent analyst
// override is either seen or protected by the upsert's
// `WHERE "analystOverride" IS NULL`.
import { randomUUID } from 'node:crypto';
import { query, tx } from '../../db/connection.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { loadRuleIndexes } from './candidates.js';
import { scoreEntities } from './score.js';
import { planLinkWrites } from './plan.js';

export const UPSERT_CHUNK = 5000;

const ENTITIES_SQL = `SELECT "id", "entityType", "displayName", "canonicalKey", "attributes"
  FROM "OrgEntities" WHERE "runId" = $1 AND "validTo" IS NULL`;

const EXISTING_SQL = `SELECT "id", "orgEntityId", "targetType", "targetId", "status", "analystOverride"
  FROM "OrgLinks" WHERE "orgEntityId" = ANY($1::uuid[])`;

// One statement per chunk: unnest the column arrays. A row an analyst has
// overridden is never updated (the WHERE on the conflict branch).
const UPSERT_SQL = `INSERT INTO "OrgLinks"
    ("id", "orgEntityId", "targetType", "targetId", "confidence", "signals", "matchedField", "matchedValue",
     "origin", "status", "runId")
  SELECT u.id, u.eid, u.tt, u.tid, u.conf, u.sig, u.mf, u.mv, 'import', u.st, $10::uuid
    FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::uuid[], $5::smallint[], $6::text[], $7::text[], $8::text[], $9::text[])
      AS u(id, eid, tt, tid, conf, sig, mf, mv, st)
  ON CONFLICT ("orgEntityId", "targetType", "targetId") DO UPDATE SET
    "confidence" = EXCLUDED."confidence", "signals" = EXCLUDED."signals",
    "matchedField" = EXCLUDED."matchedField", "matchedValue" = EXCLUDED."matchedValue",
    "status" = EXCLUDED."status", "runId" = EXCLUDED."runId", "updatedAt" = now() AT TIME ZONE 'utc'
  WHERE "OrgLinks"."analystOverride" IS NULL`;

const REJECT_SQL = `UPDATE "OrgLinks" SET "status" = 'rejected', "updatedAt" = now() AT TIME ZONE 'utc'
  WHERE "id" = ANY($1::uuid[]) AND "analystOverride" IS NULL`;

/** Column arrays for UPSERT_SQL ($1..$9; $10 is the run id). */
export function upsertParams(rows, runId) {
  return [
    rows.map(() => randomUUID()),
    rows.map(r => r.orgEntityId),
    rows.map(r => r.targetType),
    rows.map(r => r.targetId),
    rows.map(r => r.confidence),
    rows.map(r => r.signals),
    rows.map(r => r.matchedField),
    rows.map(r => r.matchedValue),
    rows.map(r => r.status),
    runId,
  ];
}

function rulesOf(profile) {
  const rules = parseJsonbColumn(profile?.linkRules);
  return Array.isArray(rules) ? rules : [];
}

function entitiesFrom(rows) {
  return rows.map(r => ({ ...r, attributes: parseJsonbColumn(r.attributes) ?? {} }));
}

function logPerType(log, decisions, plan) {
  if (typeof log !== 'function') return;
  const byType = new Map();
  for (const d of decisions) byType.set(d.entityType, (byType.get(d.entityType) ?? 0) + 1);
  for (const [type, n] of byType) log(`linking ${type}: ${n} entities scored`);
  const c = plan.counts;
  log(`linking: ${c.linked} linked, ${c.proposed} proposed, ${c.ambiguous} ambiguous, ${c.none} none, ${c.rejected} stale links rejected`);
}

async function writePlan(client, plan, runId) {
  for (let i = 0; i < plan.upserts.length; i += UPSERT_CHUNK) {
    await client.query(UPSERT_SQL, upsertParams(plan.upserts.slice(i, i + UPSERT_CHUNK), runId));
  }
  if (plan.rejectIds.length > 0) await client.query(REJECT_SQL, [plan.rejectIds]);
}

const zero = (runId) => ({ runId, linked: 0, proposed: 0, ambiguous: 0, none: 0, rejected: 0 });

export async function linkRun({ runId, profile, log }) {
  const rules = rulesOf(profile);
  if (rules.length === 0) return zero(runId);
  const ruled = new Set(rules.map(r => r.entityType));
  const entities = entitiesFrom((await query(ENTITIES_SQL, [runId])).rows).filter(e => ruled.has(e.entityType));
  if (entities.length === 0) return zero(runId);

  const decisions = scoreEntities(entities, await loadRuleIndexes(rules));
  const thresholds = new Map(rules.map(r => [r.entityType, r.threshold]));

  const plan = await tx(async (client) => {
    const existing = (await client.query(EXISTING_SQL, [entities.map(e => e.id)])).rows;
    const p = planLinkWrites({ decisions, existing, thresholdFor: t => thresholds.get(t), runId });
    await writePlan(client, p, runId);
    return p;
  });
  logPerType(log, decisions, plan);
  return { runId, ...plan.counts };
}
