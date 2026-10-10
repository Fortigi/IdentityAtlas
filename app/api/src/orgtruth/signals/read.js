// Organisation truth — GET /org-truth/signals?type=<collection type>:
//
//   { type, settings, asOf, findings }   (findings + asOf: signals/findings.js)
//
// Reads the type's accepted, current collection entities, the activity on them
// (accepted subject keys; activity/sql.js), their member links to people, the
// identity ↔ account links between all those people and their labels, then
// hands everything to the pure computeFindings.
import { query } from '../../db/connection.js';
import { ENTITY_TEMPLATE_SQL } from '../templates.js';
import { resolveLabels } from '../model/entities.js';
import { activityRollupSql } from '../activity/sql.js';
import { loadFamily } from '../activity/family.js';
import { settingsFor } from './settings.js';
import { computeFindings } from './findings.js';

const entitiesSql = `
  SELECT e."id", e."displayName", e."attributes" FROM "OrgEntities" e
   WHERE e."entityType" = $1 AND e."status" = 'accepted' AND e."validTo" IS NULL
     AND ${ENTITY_TEMPLATE_SQL('e')} = 'collection'
   ORDER BY e."displayName"`;

const activitySql = activityRollupSql(
  `sk."targetType" = 'OrgEntity' AND se."entityType" = $1 AND se."status" = 'accepted' AND se."validTo" IS NULL`,
);

const membersSql = `
  SELECT l."orgEntityId", COALESCE(l."via", 'displayName') AS via, l."targetType", l."targetId"
    FROM "OrgLinks" l JOIN "OrgEntities" e ON e."id" = l."orgEntityId"
   WHERE e."entityType" = $1 AND e."status" = 'accepted' AND e."validTo" IS NULL
     AND l."status" = 'accepted' AND l."targetType" IN ('Principal', 'Identity')`;

export async function getSignals(type) {
  const settings = await settingsFor(type);
  const [entities, activity, members] = await Promise.all([
    query(entitiesSql, [type]).then(r => r.rows),
    query(activitySql, [type]).then(r => r.rows),
    query(membersSql, [type]).then(r => r.rows),
  ]);
  const refs = [
    ...activity.filter(r => r.actorId).map(r => ({ targetType: r.actorType, targetId: r.actorId })),
    ...members,
  ];
  const family = await loadFamily(refs);
  const labels = await resolveLabels(refs);
  const { asOf, findings } = computeFindings({ entities, activity, members, family, labels, settings });
  return { type, settings, asOf, findings };
}
