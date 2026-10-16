// Organisation truth — the enrichments about one system object, as ordinary
// attributes labelled with their source (GET /org-truth/enrichment/:targetType/:id).
//
//   { groups: [{ source: 'Maten', profileName, entityId,
//                attributes: { expertises: ['IAM', 'Azure'], level: 'Senior' } }] }
//
// One group per enrichment row about the object (orgtruth/enrichment/sql.js: its
// key link), ordered by profile name and row name. A Principal also gets the
// rows about its identity, an Identity the rows about its accounts (the same
// widening as linkedTo.js); a row reached through two of them is listed once.
// Attributes are returned as stored: a multi-valued one is a list.
import { query } from '../../db/connection.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { targetsOf } from '../model/linkedTo.js';
import { enrichmentTargetsSql } from './sql.js';

export const ENRICHMENT_TARGET_TYPES = ['Identity', 'Principal', 'Resource'];

const enrichmentSql = `${enrichmentTargetsSql([`l."targetType" = ANY($1::text[])`, `l."targetId" = ANY($2::uuid[])`])}
   ORDER BY p."name", e."displayName", e."id"`;

/** Pure: enrichment rows → groups, one per enrichment row. */
export function shapeEnrichment(rows) {
  const seen = new Set();
  const groups = [];
  for (const r of rows) {
    if (seen.has(r.entityId)) continue;
    seen.add(r.entityId);
    groups.push({ source: r.source, profileName: r.profileName, entityId: r.entityId, attributes: parseJsonbColumn(r.attributes) ?? {} });
  }
  return { groups };
}

export async function getEnrichment(targetType, id) {
  const pairs = await targetsOf(targetType, id);
  const rows = (await query(enrichmentSql, [pairs.map(p => p.targetType), pairs.map(p => p.id)])).rows;
  return shapeEnrichment(rows);
}
