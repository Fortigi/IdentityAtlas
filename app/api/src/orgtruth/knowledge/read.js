// Organisation knowledge extraction — what the review screen and the export read.
//
//   listMentions(sourceId)               → mentions with their candidate links
//   listClaims(sourceId, filter)         → statements with subject/object mention and exact evidence
//   listFindings(sourceId)               → issues and follow-up questions
//   exportPackage(sourceId)              → the reproducible JSON package (source, passages, everything above, runs)
//   statementsAbout(targetType, id)      → accepted statements whose mention an analyst linked to this object
//
// The candidates' labels are read from the target tables here (a link stores only ids).
import { query } from '../../db/connection.js';
import { TARGET_TABLES } from '../linking/candidates.js';
import { MENTION_ENTITY_TYPES, PIPELINE_VERSION, PROMPT_VERSION, PREDICATES, PREDICATE_LABELS } from './contracts.js';
import { getTranscript, getPassages } from './store.js';
import { bandOf } from './confidence.js';

const MENTION_TYPES_SQL = `ARRAY[${Object.values(MENTION_ENTITY_TYPES).map(t => `'${t}'`).join(',')}]::text[]`;

const MENTIONS_SQL = `
  SELECT e."id", e."entityType", e."displayName", e."attributes", e."status"
    FROM "OrgEntities" e
   WHERE e."sourceId" = $1 AND e."origin" = 'model' AND e."entityType" = ANY(${MENTION_TYPES_SQL})
   ORDER BY e."displayName"`;

const LINKS_SQL = `
  SELECT "id", "orgEntityId", "targetType", "targetId", "confidence", "signals", "matchedField", "matchedValue",
         "status", "analystOverride", "overriddenBy", "overriddenAt"
    FROM "OrgLinks" WHERE "orgEntityId" = ANY($1::uuid[])
   ORDER BY "confidence" DESC, "id"`;

// The column that says what kind of object a candidate is ("Group", "Klant", "User").
const KIND_COLUMN = { OrgEntity: '"entityType"', Resource: '"resourceType"', Context: '"contextType"', Principal: '"principalType"' };

async function labels(links) {
  const byType = new Map();
  for (const l of links) byType.set(l.targetType, [...(byType.get(l.targetType) ?? []), l.targetId]);
  const out = new Map();
  for (const [type, ids] of byType) {
    const t = TARGET_TABLES[type];
    if (!t) continue;
    const kind = KIND_COLUMN[type] ?? 'NULL::text';
    const r = await query(`SELECT "id", "displayName", ${kind} AS "kind" FROM "${t.table}" WHERE "id" = ANY($1::uuid[])`, [[...new Set(ids)]]);
    for (const row of r.rows) out.set(`${type}:${row.id}`, { label: row.displayName, kind: row.kind ?? null });
  }
  return out;
}

const candidateOf = (l, names) => ({
  linkId: l.id, targetType: l.targetType, targetId: l.targetId, label: names.get(`${l.targetType}:${l.targetId}`)?.label ?? null,
  kind: names.get(`${l.targetType}:${l.targetId}`)?.kind ?? null, confidence: l.confidence,
  reasons: (l.signals ?? '').split(',').filter(Boolean), matchedValue: l.matchedValue, status: l.status,
  analystOverride: l.analystOverride, decidedBy: l.overriddenBy, decidedAt: l.overriddenAt,
});

export async function listMentions(sourceId) {
  const mentions = (await query(MENTIONS_SQL, [sourceId])).rows;
  const links = mentions.length ? (await query(LINKS_SQL, [mentions.map(m => m.id)])).rows : [];
  const names = await labels(links);
  return mentions.map(m => ({
    id: m.id, type: m.attributes?.mentionType ?? null, label: m.displayName, resolution: m.attributes?.resolution ?? null,
    occurrences: m.attributes?.occurrences ?? [], origin: m.attributes?.mentionOrigin ?? 'model',
    originalLabel: m.attributes?.originalLabel ?? null, renamedBy: m.attributes?.renamedBy ?? null,
    candidates: links.filter(l => l.orgEntityId === m.id).map(l => candidateOf(l, names)),
  }));
}

const CLAIMS_SQL = `
  SELECT r."id", r."predicate", r."attributes", r."status", r."confidence", r."fromEntityId", r."toEntityId", r."runId",
         f."displayName" AS "subject", f."attributes"->>'mentionType' AS "subjectType", f."attributes"->>'originalLabel' AS "subjectOriginal",
         t."displayName" AS "object", t."attributes"->>'mentionType' AS "objectType", t."attributes"->>'originalLabel' AS "objectOriginal"
    FROM "OrgRelations" r
    JOIN "OrgEntities" f ON f."id" = r."fromEntityId"
    JOIN "OrgEntities" t ON t."id" = r."toEntityId"
   WHERE r."sourceId" = $1 AND r."attributes" ? 'claimKey'
     AND ($2::text IS NULL OR r."status" = $2)
   ORDER BY (SELECT min(e."startChar") FROM "OrgClaimEvidence" e WHERE e."relationId" = r."id"), r."predicate"`;

const EVIDENCE_SQL = `
  SELECT ev."id", ev."relationId", ev."startChar", ev."endChar", ev."quote", ev."support", ev."verifier", p."seq"
    FROM "OrgClaimEvidence" ev LEFT JOIN "OrgSourcePassages" p ON p."id" = ev."passageId"
   WHERE ev."relationId" = ANY($1::uuid[]) ORDER BY ev."startChar"`;

export async function listClaims(sourceId, { status = null } = {}) {
  const rows = (await query(CLAIMS_SQL, [sourceId, status])).rows;
  const ev = rows.length ? (await query(EVIDENCE_SQL, [rows.map(r => r.id)])).rows : [];
  return rows.map(r => ({
    id: r.id, predicate: r.predicate, qualifier: r.attributes?.qualifier ?? null, modality: r.attributes?.modality ?? null,
    topic: r.attributes?.topic ?? null, support: r.attributes?.support ?? null, status: r.status,
    rejectedBy: r.attributes?.rejectedBy ?? null, edited: r.attributes?.edited ?? null, confidence: r.confidence,
    band: bandOf(r.confidence ?? 0), corroboration: r.attributes?.corroboration ?? null, confidenceParts: r.attributes?.confidenceParts ?? null,
    subject: { mentionId: r.fromEntityId, label: r.subject, type: r.subjectType, originalLabel: r.subjectOriginal ?? null },
    object: { mentionId: r.toEntityId, label: r.object, type: r.objectType, originalLabel: r.objectOriginal ?? null },
    evidence: ev.filter(e => e.relationId === r.id).map(e => ({
      id: e.id, seq: e.seq, startChar: e.startChar, endChar: e.endChar, quote: e.quote, support: e.support, verifier: e.verifier,
    })),
  }));
}

export async function listFindings(sourceId) {
  return (await query(`
    SELECT "id", "kind", "category", "text", "related", "origin", "status", "decidedBy", "decidedAt", "createdAt"
      FROM "OrgKnowledgeFindings" WHERE "sourceId" = $1
     ORDER BY CASE "kind" WHEN 'issue' THEN 0 ELSE 1 END, "category", "createdAt"`, [sourceId])).rows;
}

export async function listRuns(sourceId) {
  return (await query(`
    SELECT "id", "status", "step", "pct", "error", "stats", "triggeredBy", "createdAt", "startedAt", "finishedAt",
           "details" - 'cache' AS "details"
      FROM "OrgImportRuns" WHERE "sourceId" = $1 AND "mode" = 'extract' ORDER BY "createdAt" DESC`, [sourceId])).rows;
}

export async function exportPackage(sourceId) {
  const source = await getTranscript(sourceId);
  if (!source) return null;
  const [passages, mentions, claims, findings, runs] = await Promise.all([
    getPassages(sourceId), listMentions(sourceId), listClaims(sourceId), listFindings(sourceId), listRuns(sourceId),
  ]);
  const { textContent, ...meta } = source;
  return {
    schemaVersion: '0.1',
    pipelineVersion: PIPELINE_VERSION,
    promptVersion: PROMPT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { ...meta, text: textContent },
    passages: passages.map(({ id, seq, startChar, endChar, text, speaker, startMs, endMs }) => ({ id, seq, startChar, endChar, text, speaker, startMs, endMs })),
    mentions, claims, findings,
    runs: runs.map(r => ({ id: r.id, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt, stats: r.stats, model: r.details?.model ?? null, config: r.details?.config ?? null })),
    externalAiUsed: false,
  };
}

const STATEMENTS_SQL = `
  SELECT r."id", r."predicate", r."attributes"->>'qualifier' AS "qualifier", r."status",
         me."id" AS "mentionId", me."displayName" AS "mention", (r."fromEntityId" = me."id") AS "asSubject",
         other."displayName" AS "other", s."id" AS "sourceId", s."displayName" AS "sourceName", s."observedAt",
         (SELECT ev."quote" FROM "OrgClaimEvidence" ev WHERE ev."relationId" = r."id" ORDER BY ev."startChar" LIMIT 1) AS "quote"
    FROM "OrgLinks" l
    JOIN "OrgEntities" me ON me."id" = l."orgEntityId" AND me."entityType" = ANY(${MENTION_TYPES_SQL})
    JOIN "OrgRelations" r ON (r."fromEntityId" = me."id" OR r."toEntityId" = me."id") AND r."status" = 'accepted'
    JOIN "OrgEntities" other ON other."id" = CASE WHEN r."fromEntityId" = me."id" THEN r."toEntityId" ELSE r."fromEntityId" END
    JOIN "OrgSources" s ON s."id" = r."sourceId"
   WHERE l."status" = 'accepted' AND l."targetType" = ANY($1::text[]) AND l."targetId" = ANY($2::uuid[])
   ORDER BY s."observedAt" DESC, r."predicate"
   LIMIT 200`;

/** Accepted statements about an object, through mentions an analyst linked to it. */
export async function statementsAbout(pairs) {
  if (pairs.length === 0) return [];
  const rows = (await query(STATEMENTS_SQL, [pairs.map(p => p.targetType), pairs.map(p => p.id)])).rows;
  return rows.map((r) => {
    const predicate = PREDICATES.includes(r.predicate) ? r.predicate : 'other';
    const verb = predicate === 'other' && r.qualifier ? r.qualifier : PREDICATE_LABELS[predicate];
    const [s, o] = r.asSubject ? [r.mention, r.other] : [r.other, r.mention];
    const extra = predicate !== 'other' && r.qualifier ? ` (${r.qualifier})` : '';
    return {
      id: r.id, predicate, qualifier: r.qualifier, text: `${s} ${verb} ${o}${extra}`,
      quote: r.quote, sourceId: r.sourceId, sourceName: r.sourceName, observedAt: r.observedAt,
    };
  });
}
