// Identity Atlas Interviews — finding the entity a spoken mention may refer to.
//
// Minimum in, minimum out: the client sends only the mentioned words, the kind of
// entity it is looking for and, optionally, the interview's team scope. The answer
// is at most MAX_CANDIDATES candidates with a display name and a short distinguishing
// label (job title, department, system) — no email, no employee id, no attributes.
//
// Matching reuses the custom-report reference lookup's fuzzy rule (pg_trgm similarity
// blended with word similarity, nlreports/references.js) and the not-deleted filters of
// the report catalog (nlreports/catalog.js), so "a name matches" means the same in both.
// Scope is context support: a candidate inside the scope context (or any context below
// it) ranks first and is flagged `inScope`. The decision whether a candidate may be
// SUGGESTED is resolution.js's, never this module's.

import { ENTITIES } from '../nlreports/catalog.js';
import { MIN_SIMILARITY, MIN_WORD_SIMILARITY } from '../nlreports/references.js';
import { likeContains } from '../db/sqlParams.js';

export const MAX_CANDIDATES = 5;
export const MIN_QUERY = 2;
export const MAX_QUERY = 100;

// The context subtree below $3 (null → empty). Bounded by the context tree's depth.
const SCOPE_CTE = `WITH RECURSIVE scope AS (
    SELECT c."id" FROM "Contexts" c WHERE c."id" = $3::uuid
    UNION
    SELECT c."id" FROM "Contexts" c JOIN scope s ON c."parentContextId" = s."id"
  )`;

const member = (type, idExpr) =>
  `EXISTS (SELECT 1 FROM "ContextMembers" cm JOIN scope s ON s."id" = cm."contextId"
            WHERE cm."memberType" = '${type}' AND cm."memberId" = ${idExpr})`;

const systemName = (t) => `(SELECT s."displayName" FROM "Systems" s WHERE s."id" = ${t}."systemId")`;

// Per kind: the label columns, and what "inside the scope" means. A person counts as in
// scope through the person (Identity member) or through any of their accounts.
const KINDS = {
  identity: {
    labels: (t) => `${t}."jobTitle" AS "l1", ${t}."department" AS "l2", NULL::text AS "l3"`,
    inScope: (t) => `(${member('Identity', `${t}."id"`)} OR EXISTS (
        SELECT 1 FROM "IdentityMembers" im WHERE im."identityId" = ${t}."id" AND ${member('Principal', 'im."principalId"')}))`,
  },
  account: {
    labels: (t) => `${t}."jobTitle" AS "l1", ${t}."department" AS "l2", ${systemName(t)} AS "l3"`,
    inScope: (t) => `(${member('Principal', `${t}."id"`)} OR EXISTS (
        SELECT 1 FROM "IdentityMembers" im WHERE im."principalId" = ${t}."id" AND ${member('Identity', 'im."identityId"')}))`,
  },
  resource: {
    labels: (t) => `${t}."resourceType" AS "l1", ${systemName(t)} AS "l2", NULL::text AS "l3"`,
    inScope: (t) => member('Resource', `${t}."id"`),
  },
  context: {
    labels: (t) => `${t}."contextType" AS "l1", NULL::text AS "l2", NULL::text AS "l3"`,
    inScope: (t) => `${t}."id" IN (SELECT "id" FROM scope)`,
  },
};

export const SEARCH_KINDS = Object.freeze(Object.keys(KINDS));

/** The SQL for one kind. Constant per kind: user input only ever travels as $1..$3. */
export function searchSql(kind) {
  const def = KINDS[kind];
  const entity = ENTITIES[kind];
  const t = 'n0';
  const dn = `lower(${t}."displayName")`;
  return `${SCOPE_CTE}
  SELECT ${t}."id", ${t}."displayName", ${def.labels(t)},
         round((similarity(${dn}, lower($1)) * 0.6 + word_similarity(lower($1), ${dn}) * 0.4)::numeric, 2) AS "score",
         ${def.inScope(t)} AS "inScope"
    FROM "${entity.table}" ${t}
   WHERE ${entity.where(t)} AND ${t}."displayName" IS NOT NULL
     AND (${t}."displayName" ILIKE $2 ESCAPE '\\'
          OR similarity(${dn}, lower($1)) >= ${MIN_SIMILARITY}
          OR word_similarity(lower($1), ${dn}) >= ${MIN_WORD_SIMILARITY})
   ORDER BY "inScope" DESC, "score" DESC, ${t}."displayName", ${t}."id"
   LIMIT ${MAX_CANDIDATES + 1}`;
}

/** "Consultant · Finance · Entra ID" — the non-empty label parts, in order. */
export function labelOf(row) {
  return [row.l1, row.l2, row.l3].filter(v => typeof v === 'string' && v.trim() !== '').join(' · ');
}

/**
 * Search one kind of entity by a mentioned name.
 * @returns {Promise<{ candidates: object[], truncated: boolean }>}
 */
export async function searchEntities(query, { kind, text, scopeContextId = null }) {
  const { rows } = await query(searchSql(kind), [text, likeContains(text), scopeContextId]);
  const candidates = rows.slice(0, MAX_CANDIDATES).map(r => ({
    id: r.id,
    kind,
    displayName: r.displayName,
    label: labelOf(r),
    score: Number(r.score),
    inScope: r.inScope === true,
  }));
  return { candidates, truncated: rows.length > MAX_CANDIDATES };
}
