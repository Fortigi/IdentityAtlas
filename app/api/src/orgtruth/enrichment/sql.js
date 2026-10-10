// Organisation truth — the SQL every enrichment read shares (T10).
//
// An enrichment (template 'enrichment') adds attributes to an object that
// already exists: a staff list's expertises on the person. Its rows are
// OrgEntities of an enrichment profile; the object a row is ABOUT is the
// target of the accepted link its key rule made — the first link rule of the
// profile to the profile's `recipe.enrich.targetType`. Other rules of the same
// profile (a manager column) link the row to other people; those are relations,
// not "this row describes that person", so they are left out here. A profile
// whose rules carry no via (or none to the target type) falls back to every
// accepted link to the target type.
//
// Multi-valued attributes (recipe attribute `multi: true`) are stored as a JSON
// array in OrgEntities."attributes"; a single value as a scalar. Both read
// through attributeValuesSql as one text value per element.
//
// Shared by the enrichment read endpoint, the model's enrichment summary, the
// matrix attribute condition (matrix/enrichmentCondition.js) and the matrix
// field listing (matrix/enrichmentFields.js).

const KEY_VIA = `(SELECT kr.r->>'via'
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p."linkRules") = 'array' THEN p."linkRules" ELSE '[]'::jsonb END)
                  WITH ORDINALITY AS kr(r, n)
            WHERE kr.r->>'targetType' = p."recipe"->'enrich'->>'targetType'
            ORDER BY kr.n LIMIT 1)`;

/**
 * SELECT of the accepted, current enrichment rows with the object each is about:
 * columns "entityId", source (the entity type, e.g. 'Maten'), "profileName",
 * attributes, tt (target type), tid (target id). `extraWhere` fragments are
 * AND'ed on (aliases: e = OrgEntities, p = OrgImportProfiles, l = OrgLinks).
 */
export function enrichmentTargetsSql(extraWhere = []) {
  const extra = extraWhere.map(w => `\n       AND ${w}`).join('');
  return `SELECT e."id" AS "entityId", e."entityType" AS source, p."name" AS "profileName",
         e."attributes", l."targetType" AS tt, l."targetId" AS tid
    FROM "OrgEntities" e
    JOIN "OrgImportProfiles" p ON p."id" = e."profileId" AND p."template" = 'enrichment'
    JOIN "OrgLinks" l ON l."orgEntityId" = e."id" AND l."status" = 'accepted'
     AND l."targetType" = p."recipe"->'enrich'->>'targetType'
     AND COALESCE(l."via", 'displayName') = COALESCE(${KEY_VIA}, COALESCE(l."via", 'displayName'))
   WHERE e."status" = 'accepted' AND e."validTo" IS NULL${extra}`;
}

/**
 * Set-returning SQL: every value of attribute `keyToken` (a bound $N) of the
 * row under `alias`, one text per element of an array, the scalar otherwise.
 * An absent key yields one NULL, which matches nothing.
 */
export function attributeValuesSql(alias, keyToken) {
  const v = `${alias}."attributes"->(${keyToken}::text)`;
  return `jsonb_array_elements_text(CASE jsonb_typeof(${v}) WHEN 'array' THEN ${v} ELSE jsonb_build_array(${alias}."attributes"->>(${keyToken}::text)) END)`;
}
