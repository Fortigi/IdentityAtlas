// Organisation truth — the one roll-up every activity read starts from (T10).
//
// OrgActivities rows (migration 088) refer to their actor and subject through
// OrgActivityKeys: one key per distinct raw value, resolved and reviewed once.
// Only ACCEPTED keys count as resolved; a row whose actor (or subject) key is
// proposed, rejected or unmatched rolls up with actorType/actorId NULL (resp.
// subject) — "unresolved rows", counted but attributed to nobody.
//
// activityRollupSql(where, { byMonth }) groups the matching rows per activity
// type, subject and actor (and calendar month of occurredOn when byMonth):
//
//   "activityType", unit, "subjectType", "subjectId", "subjectEntityType",
//   "subjectLabel", "actorType", "actorId", month ('YYYY-MM' | NULL),
//   "rowCount", total (sum of measure, 0 without), "firstOn", "lastOn" (YYYY-MM-DD)
//
// Dates leave the database as text: a DATE column parsed by node-postgres
// becomes a local-midnight Date, which shifts a day in any timezone west of UTC.
// `where` is a fixed fragment with $N placeholders (aliases: a = OrgActivities,
// sk / ak = the subject / actor key).
export function activityRollupSql(where, { byMonth = false } = {}) {
  const month = byMonth ? `to_char(a."occurredOn", 'YYYY-MM')` : 'NULL::text';
  return `
    SELECT a."activityType", MAX(a."unit") AS unit,
           sk."targetType" AS "subjectType", sk."targetId" AS "subjectId",
           se."entityType" AS "subjectEntityType", COALESCE(se."displayName", sr."displayName") AS "subjectLabel",
           ak."targetType" AS "actorType", ak."targetId" AS "actorId",
           ${month} AS month,
           COUNT(*)::int AS "rowCount", COALESCE(SUM(a."measure"), 0)::float8 AS total,
           to_char(MIN(a."occurredOn"), 'YYYY-MM-DD') AS "firstOn",
           to_char(MAX(a."occurredOn"), 'YYYY-MM-DD') AS "lastOn"
      FROM "OrgActivities" a
      LEFT JOIN "OrgActivityKeys" sk ON sk."id" = a."subjectKeyId" AND sk."status" = 'accepted'
      LEFT JOIN "OrgActivityKeys" ak ON ak."id" = a."actorKeyId" AND ak."status" = 'accepted'
      LEFT JOIN "OrgEntities" se ON sk."targetType" = 'OrgEntity' AND se."id" = sk."targetId"
      LEFT JOIN "Resources" sr ON sk."targetType" = 'Resource' AND sr."id" = sk."targetId"
     WHERE ${where}
     GROUP BY 1, 3, 4, 5, 6, 7, 8, 9`;
}

export const round2 = (n) => Math.round(Number(n) * 100) / 100;
export const later = (a, b) => (!a || (b && b > a) ? b : a);
export const earlier = (a, b) => (!a || (b && b < a) ? b : a);
