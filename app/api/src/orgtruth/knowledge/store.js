// Organisation knowledge extraction — reading and writing the transcript tables.
//
// Sources and passages:
//   findTranscriptBySha(sha)              → the existing transcript with those bytes, or null
//   insertTranscript(fields)              → the stored OrgSources row (+ its passages)
//   listTranscripts()                     → transcripts with their latest extraction run
//   getTranscript(id) / getPassages(id)
// Runs (OrgImportRuns rows with mode 'extract'):
//   createExtractRun({ sourceId, triggeredBy, config }), findActiveExtraction(), getRun(id),
//   updateRun(id, fields), requestCancel(id), latestCache(sourceId), failInterruptedRuns()
// Results:
//   writeResults(client, { run, source, passages, result, resolutions, findings }) → counts
//
// Idempotency: a mention is keyed (sourceId, entityType, canonicalKey), a statement
// (sourceId, attributes.claimKey), evidence (relationId, offsets), a finding
// (sourceId, findingKey), a link (entity, target, via). A re-run updates those rows
// and NEVER changes a status an analyst set: statuses are written on insert only.
import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../../db/connection.js';
import { isUuid } from '../import/httpHelpers.js';
import { MENTION_ENTITY_TYPES, PIPELINE_VERSION, PROMPT_VERSION } from './contracts.js';
import { findingKey } from './findings.js';

export const VIA = 'mention';

const SOURCE_COLUMNS = `"id", "kind", "displayName", "fileName", "mimeType", "byteSize", "sha256", "metadata",
  "observedAt", "uploadedBy", "createdAt"`;

export async function findTranscriptBySha(sha) {
  return (await queryOne(`SELECT ${SOURCE_COLUMNS} FROM "OrgSources" WHERE "kind" = 'transcript' AND "sha256" = $1 ORDER BY "createdAt" LIMIT 1`, [sha])) ?? null;
}

/** @param {{ displayName, fileName, mimeType, buffer, text, sha256, observedAt, uploadedBy, metadata, passages }} f */
export async function insertTranscript(client, f) {
  const id = randomUUID();
  const row = (await client.query(`
    INSERT INTO "OrgSources" ("id", "kind", "displayName", "fileName", "mimeType", "byteSize", "sha256", "content", "textContent", "metadata", "observedAt", "uploadedBy")
    VALUES ($1, 'transcript', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING ${SOURCE_COLUMNS}`,
  [id, f.displayName, f.fileName, f.mimeType, f.buffer.length, f.sha256, f.buffer, f.text, JSON.stringify(f.metadata), f.observedAt, f.uploadedBy])).rows[0];
  for (const p of f.passages) {
    await client.query(`
      INSERT INTO "OrgSourcePassages" ("id", "sourceId", "seq", "startChar", "endChar", "text", "speaker", "startMs", "endMs")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), id, p.seq, p.startChar, p.endChar, p.text, p.speaker, p.startMs, p.endMs]);
  }
  return row;
}

export async function listTranscripts() {
  return (await query(`
    SELECT ${SOURCE_COLUMNS},
           (SELECT count(*)::int FROM "OrgSourcePassages" p WHERE p."sourceId" = s."id") AS "passageCount",
           (SELECT row_to_json(r) FROM (
              SELECT "id", "status", "step", "pct", "createdAt", "finishedAt", "stats"
                FROM "OrgImportRuns" WHERE "sourceId" = s."id" AND "mode" = 'extract'
               ORDER BY "createdAt" DESC LIMIT 1) r) AS "lastRun"
      FROM "OrgSources" s WHERE s."kind" = 'transcript'
     ORDER BY s."createdAt" DESC`)).rows;
}

export async function getTranscript(id) {
  if (!isUuid(id)) return null;
  return (await queryOne(`SELECT ${SOURCE_COLUMNS}, "textContent" FROM "OrgSources" WHERE "id" = $1 AND "kind" = 'transcript'`, [id])) ?? null;
}

export async function getPassages(sourceId) {
  return (await query(`SELECT * FROM "OrgSourcePassages" WHERE "sourceId" = $1 ORDER BY "seq"`, [sourceId])).rows;
}

// ─── runs ────────────────────────────────────────────────────────────────
export async function createExtractRun({ sourceId, triggeredBy, config }) {
  const details = { pipelineVersion: PIPELINE_VERSION, promptVersion: PROMPT_VERSION, config, progress: null };
  return queryOne(`
    INSERT INTO "OrgImportRuns" ("id", "sourceId", "mode", "status", "step", "pct", "triggeredBy", "details")
    VALUES ($1, $2, 'extract', 'queued', 'queued', 0, $3, $4) RETURNING *`,
  [randomUUID(), sourceId, triggeredBy, JSON.stringify(details)]);
}

/** One extraction at a time per deployment: the model server has one slot. */
export async function findActiveExtraction() {
  return (await queryOne(`SELECT * FROM "OrgImportRuns" WHERE "mode" = 'extract' AND "status" IN ('queued', 'running') ORDER BY "createdAt" LIMIT 1`)) ?? null;
}

export async function getRun(id) {
  if (!isUuid(id)) return null;
  return (await queryOne(`SELECT * FROM "OrgImportRuns" WHERE "id" = $1 AND "mode" = 'extract'`, [id])) ?? null;
}

const RUN_FIELDS = new Set(['status', 'step', 'pct', 'stats', 'error', 'details', 'startedAt', 'finishedAt']);
export async function updateRun(id, fields) {
  const keys = Object.keys(fields).filter(k => RUN_FIELDS.has(k));
  const set = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const val = (k) => (k === 'stats' || k === 'details' ? JSON.stringify(fields[k]) : fields[k]);
  await query(`UPDATE "OrgImportRuns" SET ${set} WHERE "id" = $1`, [id, ...keys.map(val)]);
}

export async function requestCancel(id) {
  return (await queryOne(`UPDATE "OrgImportRuns" SET "cancelRequested" = true WHERE "id" = $1 AND "mode" = 'extract' AND "status" IN ('queued', 'running') RETURNING "id"`, [id])) ?? null;
}

export async function isCancelRequested(id) {
  return (await queryOne(`SELECT "cancelRequested" FROM "OrgImportRuns" WHERE "id" = $1`, [id]))?.cancelRequested === true;
}

/** The stage cache of the latest run of this source that got anywhere (resume). */
export async function latestCache(sourceId) {
  const row = await queryOne(`
    SELECT "details"->'cache' AS cache FROM "OrgImportRuns"
     WHERE "sourceId" = $1 AND "mode" = 'extract' AND "details" ? 'cache'
     ORDER BY "createdAt" DESC LIMIT 1`, [sourceId]);
  return row?.cache ?? {};
}

/** At startup: a run that was queued or running when the process stopped will never finish. */
export async function failInterruptedRuns() {
  const r = await query(`
    UPDATE "OrgImportRuns" SET "status" = 'failed', "error" = 'Interrupted by a restart; start the extraction again to resume where it stopped.',
           "finishedAt" = now() AT TIME ZONE 'utc'
     WHERE "mode" = 'extract' AND "status" IN ('queued', 'running') RETURNING "id"`);
  return r.rows.length;
}

// ─── results ─────────────────────────────────────────────────────────────
const UPSERT_MENTION = `
  INSERT INTO "OrgEntities" ("id", "entityType", "displayName", "canonicalKey", "attributes", "sourceId", "sourceLocator", "runId",
                             "origin", "status", "observedAt", "createdBy")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'model', 'proposed', $9, 'knowledge-extraction')
  ON CONFLICT ("sourceId", "entityType", "canonicalKey") WHERE "profileId" IS NULL AND "origin" = 'model' AND "canonicalKey" IS NOT NULL
  DO UPDATE SET "runId" = EXCLUDED."runId",
    -- a reviewer's name and type (knowledge/mentions.js) survive a re-run
    "displayName" = CASE WHEN "OrgEntities"."attributes" ? 'renamedBy' THEN "OrgEntities"."displayName" ELSE EXCLUDED."displayName" END,
    "attributes" = EXCLUDED."attributes" || jsonb_strip_nulls(jsonb_build_object(
      'originalLabel', "OrgEntities"."attributes"->'originalLabel', 'renamedBy', "OrgEntities"."attributes"->'renamedBy',
      'renamedAt', "OrgEntities"."attributes"->'renamedAt', 'typeChangedBy', "OrgEntities"."attributes"->'typeChangedBy',
      'label', CASE WHEN "OrgEntities"."attributes" ? 'renamedBy' THEN "OrgEntities"."attributes"->'label' END,
      'mentionType', CASE WHEN "OrgEntities"."attributes" ? 'typeChangedBy' THEN "OrgEntities"."attributes"->'mentionType' END))
  RETURNING "id"`;

export const UPSERT_LINK = `
  INSERT INTO "OrgLinks" ("id", "orgEntityId", "targetType", "targetId", "confidence", "signals", "matchedField", "matchedValue",
                          "origin", "status", "runId", "via", "orgValue")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'model', 'proposed', $9, $10, $11)
  ON CONFLICT ("orgEntityId", "targetType", "targetId", (COALESCE("via", ''))) DO UPDATE SET
    "confidence" = EXCLUDED."confidence", "signals" = EXCLUDED."signals", "matchedField" = EXCLUDED."matchedField",
    "matchedValue" = EXCLUDED."matchedValue", "runId" = EXCLUDED."runId", "updatedAt" = now() AT TIME ZONE 'utc'
  WHERE "OrgLinks"."analystOverride" IS NULL`;

const UPSERT_CLAIM = `
  INSERT INTO "OrgRelations" ("id", "fromEntityId", "toEntityId", "predicate", "attributes", "sourceId", "sourceLocator", "runId",
                              "origin", "status", "confidence", "observedAt", "createdBy")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'model', $9, $10, $11, 'knowledge-extraction')
  ON CONFLICT ("sourceId", ("attributes"->>'claimKey')) WHERE "attributes" ? 'claimKey'
  DO UPDATE SET "runId" = EXCLUDED."runId", "confidence" = EXCLUDED."confidence",
    "attributes" = "OrgRelations"."attributes" || jsonb_build_object('modality', EXCLUDED."attributes"->'modality',
      'topic', EXCLUDED."attributes"->'topic', 'support', EXCLUDED."attributes"->'support')
  RETURNING "id"`;

const UPSERT_EVIDENCE = `
  INSERT INTO "OrgClaimEvidence" ("id", "relationId", "sourceId", "passageId", "startChar", "endChar", "quote", "support", "verifier", "runId")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT ("relationId", "startChar", "endChar") DO UPDATE SET
    "support" = EXCLUDED."support", "verifier" = EXCLUDED."verifier", "runId" = EXCLUDED."runId"`;

const UPSERT_FINDING = `
  INSERT INTO "OrgKnowledgeFindings" ("id", "sourceId", "runId", "kind", "category", "text", "findingKey", "related", "origin")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT ("sourceId", "findingKey") DO UPDATE SET "runId" = EXCLUDED."runId", "related" = EXCLUDED."related"`;

// The verifier's verdict over all quotes of a statement: one supported quote is enough.
export function claimSupport(evidence) {
  const s = new Set(evidence.map(e => e.support));
  if (s.has('supported')) return 'supported';
  if (s.has('unclear') || s.has('unchecked')) return 'unclear';
  return 'unsupported';
}
const CONFIDENCE = { supported: 80, unclear: 50, unsupported: 20 };

async function writeMentions(client, { run, source, passages, result, resolutions }) {
  const ids = new Map();
  const seqId = new Map(passages.map(p => [p.seq, p.id]));
  let links = 0;
  for (const m of result.mentions) {
    const r = resolutions.get(m.key) ?? { status: 'unmatched', candidates: [] };
    const attrs = {
      mentionType: m.type, label: m.label, mentionOrigin: m.origin, resolution: r.status,
      occurrences: m.occurrences.map(o => ({ passageId: seqId.get(o.seq) ?? null, seq: o.seq, startChar: o.startChar, endChar: o.endChar })),
    };
    const first = m.occurrences[0];
    const row = (await client.query(UPSERT_MENTION, [randomUUID(), MENTION_ENTITY_TYPES[m.type], m.label, m.key, JSON.stringify(attrs),
      source.id, first ? `passage:${first.seq}` : null, run.id, source.observedAt])).rows[0];
    ids.set(m.key, row.id);
    for (const c of r.candidates) {
      await client.query(UPSERT_LINK, [randomUUID(), row.id, c.targetType, c.targetId, c.confidence, c.signals.join(','),
        c.matchedField, c.matchedValue, run.id, VIA, m.label]);
      links += 1;
    }
  }
  return { ids, links };
}

async function writeClaims(client, { run, source, passages, result, mentionIds }) {
  const ids = new Map();
  const seqId = new Map(passages.map(p => [p.seq, p.id]));
  let evidence = 0;
  for (const c of result.claims) {
    const from = mentionIds.get(c.subjectKey);
    const to = mentionIds.get(c.objectKey);
    if (!from || !to) continue;
    const support = claimSupport(c.evidence);
    // MEASURED (2026-10-11, Fortigi interview): the 4B verifier called half of the
    // correct statements unsupported, so it only lowers confidence and flags the
    // statement; it never rejects. Hallucinations are stopped by the deterministic
    // checks (quote in the passage, both sides in it), not by a second model opinion.
    const attrs = { claimKey: c.key, qualifier: c.qualifier, modality: c.modality, topic: c.topic, support };
    const status = 'proposed';
    const row = (await client.query(UPSERT_CLAIM, [randomUUID(), from, to, c.predicate, JSON.stringify(attrs), source.id,
      `passage:${c.evidence[0].seq}`, run.id, status, CONFIDENCE[support], source.observedAt])).rows[0];
    ids.set(c.key, row.id);
    for (const e of c.evidence) {
      await client.query(UPSERT_EVIDENCE, [randomUUID(), row.id, source.id, seqId.get(e.seq) ?? null, e.startChar, e.endChar,
        e.quote, e.support, e.verifier, run.id]);
      evidence += 1;
    }
  }
  return { ids, evidence };
}

async function writeFindings(client, { run, source, passages, findings, mentionIds, claimIds }) {
  const seqId = new Map(passages.map(p => [p.seq, p.id]));
  for (const f of findings) {
    const related = {
      mentions: (f.related.mentions ?? []).map(k => mentionIds.get(k)).filter(Boolean),
      claims: (f.related.claims ?? []).map(k => claimIds.get(k)).filter(Boolean),
      passages: (f.related.passages ?? []).map(n => seqId.get(n)).filter(Boolean),
    };
    await client.query(UPSERT_FINDING, [randomUUID(), source.id, run.id, f.kind, f.category, f.text, findingKey(f), JSON.stringify(related), f.origin]);
  }
  return findings.length;
}

export async function writeResults(client, { run, source, passages, result, resolutions, findings }) {
  const m = await writeMentions(client, { run, source, passages, result, resolutions });
  const c = await writeClaims(client, { run, source, passages, result, mentionIds: m.ids });
  const f = await writeFindings(client, { run, source, passages, findings, mentionIds: m.ids, claimIds: c.ids });
  return { mentions: m.ids.size, links: m.links, claims: c.ids.size, evidence: c.evidence, findings: f };
}
