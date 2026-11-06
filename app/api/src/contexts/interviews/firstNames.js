// Context interviews — who a first name alone ("Piet") is.
//
//   resolveFirstNames(db, contextId, firsts) → Map(first → { id, displayName, holderCol })
//
// An interview names colleagues by their first name. Who "Piet" is depends on
// how close to the context he is, so the search widens step by step, for all
// the names at once (one statement per step), and a name leaves the search at
// the first step that decides it:
//
//   (a) LOCAL_SQL    the context's current members and role holders
//   (b) CLAIMED_SQL  the people this context's interviews already name: the
//                    holders of its claims (any interview) and its interviewees —
//                    a former member is not a member any more, but is named
//   (c) NEARBY_SQL   the members and role holders of the contexts next to it: its
//                    SameUnitAs variants, its parent and its siblings
//   (d) ORG_SQL      every live user account whose first name it is — only when
//                    exactly ONE has it (in a large organisation this rarely
//                    resolves, and that is the point); ORG_ROWS or more rows for a
//                    name is no match
//
// A step that finds exactly one person decides; a step that finds two or more
// also decides — as no match: a wider circle cannot make an ambiguous name
// unique. Accounts and persons both count in (a)–(c); a person and one of their
// accounts are two candidates. Read in "First Last" and "Last, First" order.
// The caller flags every hit 'firstName' (the review asks to check the person).

import { normalizeName } from '../../lib/nameMatch.js';

const firstWord = (norm) => norm.split(' ')[0];
const escapeLike = (s) => s.replace(/[\\%_]/g, ch => `\\${ch}`);

// The people of a set of contexts (members and role holders), whose display name
// starts with — or after "Last, " carries — one of the first names.
const peopleOf = (contexts) => `
  SELECT p.id, p."displayName", 'principalId' AS "holderCol"
    FROM "Principals" p
   WHERE p."deletedAt" IS NULL
     AND (p.id IN (SELECT "principalId" FROM "ContextRoles" WHERE "contextId" IN (${contexts}))
          OR p.id IN (SELECT "memberId" FROM "ContextMembers" WHERE "contextId" IN (${contexts}) AND "memberType" = 'Principal'))
     AND p."displayName" ILIKE ANY($2::text[])
  UNION ALL
  SELECT i.id, i."displayName", 'identityId' AS "holderCol"
    FROM "Identities" i
   WHERE (i.id IN (SELECT "identityId" FROM "ContextRoles" WHERE "contextId" IN (${contexts}))
          OR i.id IN (SELECT "memberId" FROM "ContextMembers" WHERE "contextId" IN (${contexts}) AND "memberType" = 'Identity'))
     AND i."displayName" ILIKE ANY($2::text[])`;

export const LOCAL_SQL = peopleOf('$1::uuid');

export const CLAIMED_SQL = `
  SELECT p.id, p."displayName", 'principalId' AS "holderCol"
    FROM "Principals" p
   WHERE p."deletedAt" IS NULL
     AND (p.id IN (SELECT "principalId" FROM "ContextClaims" WHERE "contextId" = $1::uuid AND "principalId" IS NOT NULL)
          OR p.id IN (SELECT "principalId" FROM "ContextInterviews" WHERE "contextId" = $1::uuid AND "principalId" IS NOT NULL))
     AND p."displayName" ILIKE ANY($2::text[])
  UNION ALL
  SELECT i.id, i."displayName", 'identityId' AS "holderCol"
    FROM "Identities" i
   WHERE (i.id IN (SELECT "identityId" FROM "ContextClaims" WHERE "contextId" = $1::uuid AND "identityId" IS NOT NULL)
          OR i.id IN (SELECT "identityId" FROM "ContextInterviews" WHERE "contextId" = $1::uuid AND "identityId" IS NOT NULL))
     AND i."displayName" ILIKE ANY($2::text[])`;

// The contexts next to $1: SameUnitAs variants (either side), the parent, the siblings.
const NEARBY_CONTEXTS = `
    SELECT CASE WHEN r."contextId" = $1::uuid THEN r."relatedContextId" ELSE r."contextId" END
      FROM "ContextRelationships" r
     WHERE r."relationshipType" = 'SameUnitAs' AND $1::uuid IN (r."contextId", r."relatedContextId")
    UNION
    SELECT c."parentContextId" FROM "Contexts" c WHERE c.id = $1::uuid AND c."parentContextId" IS NOT NULL
    UNION
    SELECT s.id FROM "Contexts" s JOIN "Contexts" c ON c.id = $1::uuid
     WHERE s."parentContextId" = c."parentContextId" AND s.id <> $1::uuid`;

export const NEARBY_SQL = peopleOf(NEARBY_CONTEXTS);

export const FIRST_NAME_STEPS = Object.freeze([LOCAL_SQL, CLAIMED_SQL, NEARBY_SQL]);

// Org-wide, per first name at most ORG_ROWS candidate rows (LATERAL … LIMIT):
// as many rows as that is no match, whatever they hold.
export const ORG_ROWS = 20;

export const ORG_SQL = `
  SELECT f.fn AS "firstName", p.id, p."displayName", 'principalId' AS "holderCol"
    FROM unnest($1::text[], $2::text[], $3::text[]) AS f(fn, lead, comma)
    CROSS JOIN LATERAL (
      SELECT p.id, p."displayName"
        FROM "Principals" p
       WHERE p."deletedAt" IS NULL AND p."principalType" = 'User'
         AND (p."displayName" ILIKE f.lead OR p."displayName" ILIKE f.comma)
       LIMIT ${ORG_ROWS}) p`;

/** The rows whose normalised first name is `first` — "First Last" or "Last, First". Pure. */
function hitsOf(rows, first) {
  const hits = new Map();
  for (const r of rows) {
    const norm = normalizeName(r.displayName);
    if (firstWord(norm) === first) hits.set(`${r.holderCol}:${r.id}`, r);
  }
  return [...hits.values()];
}

/** { row } when exactly one row has that first name, 'ambiguous' for two or more, null for none. Pure. */
export function pickFirstName(rows, first) {
  const hits = hitsOf(rows, first);
  if (hits.length === 0) return null;
  return hits.length === 1 ? { row: hits[0] } : 'ambiguous';
}

/** The one row whose normalised first name is `first`, or null (none, or two). Pure. */
export function uniqueFirstName(rows, first) {
  return pickFirstName(rows, first)?.row ?? null;
}

const leadOf = (f) => `${escapeLike(f)} %`;
const commaOf = (f) => `%, ${escapeLike(f)}%`;

/** The ILIKE patterns of a step for these first names. Pure. */
export const patternsOf = (firsts) => firsts.flatMap(f => [leadOf(f), commaOf(f)]);

async function orgWide(db, firsts, out) {
  const { rows } = await db.query(ORG_SQL, [firsts, firsts.map(leadOf), firsts.map(commaOf)]);
  for (const first of firsts) {
    const mine = rows.filter(r => r.firstName === first);
    const pick = mine.length < ORG_ROWS ? pickFirstName(mine, first) : null;
    if (pick?.row) out.set(first, pick.row);
  }
}

/**
 * @param firsts  distinct normalised first names (one word each)
 * @returns Map(first → row) for the names one step decided on exactly one person
 */
export async function resolveFirstNames(db, contextId, firsts) {
  const out = new Map();
  let open = [...firsts];
  for (const sql of FIRST_NAME_STEPS) {
    if (open.length === 0) return out;
    const { rows } = await db.query(sql, [contextId, patternsOf(open)]);
    const next = [];
    for (const first of open) {
      const pick = pickFirstName(rows, first);
      if (pick?.row) out.set(first, pick.row);
      else if (!pick) next.push(first);
    }
    open = next;
  }
  if (open.length > 0) await orgWide(db, open, out);
  return out;
}
