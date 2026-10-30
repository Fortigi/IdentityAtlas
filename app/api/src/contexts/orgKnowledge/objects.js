// Organizational knowledge — the canonical objects a knowledge claim names.
//
//   objectFor(client, kind, name)   → the id of the Activity / Expertise / Duty
//                                     context called `name`, created when there is none
//   listObjects(db, kind?)          → every object with how many people are said to hold it
//
// One root per kind ("Activities", "Expertise", "Duties": contextType = the kind's
// type, extendedAttributes.knowledgeRoot = true), the objects below it. Manual
// contexts (variant 'manual', template Tag, people as members): an analyst may
// rename or merge them on the Contexts page like any tag; no plugin or crawler
// touches them. A name matches an existing object case-, accent- and
// spacing-insensitively (lib/orgKnowledge.js objectKey), or one of its aliases.
// Design: docs/architecture/m1-discovery-and-design.md.

import { KNOWLEDGE, MAX_OBJECT_NAME, objectKey } from '../../lib/orgKnowledge.js';

const NORMALIZED = (col) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;

export const FIND_OBJECT_SQL = `
  SELECT c.id, c."displayName"
    FROM "Contexts" c
   WHERE c."contextType" = $1
     AND COALESCE((c."extendedAttributes"->>'knowledgeRoot')::boolean, false) = false
     AND (${NORMALIZED('c."displayName"')} = $2
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(c."extendedAttributes"->'aliases', '[]'::jsonb)) a
                      WHERE ${NORMALIZED('a')} = $2))
   ORDER BY c."createdAt"
   LIMIT 1`;

export const FIND_ROOT_SQL = `
  SELECT id FROM "Contexts"
   WHERE "contextType" = $1 AND "parentContextId" IS NULL
     AND COALESCE(("extendedAttributes"->>'knowledgeRoot')::boolean, false)
   ORDER BY "createdAt" LIMIT 1`;

export const INSERT_OBJECT_SQL = `
  INSERT INTO "Contexts" (id, "contextType", "contextCategory", "targetType", variant, "displayName", description,
                          "parentContextId", "extendedAttributes", "createdByUser")
  VALUES (gen_random_uuid(), $1, 'Tag', 'Identity', 'manual', $2, $3, $4, $5::jsonb, 'workbench')
  RETURNING id`;

// The key is computed here (case and spacing aside, as NORMALIZED does in SQL).
const sqlKey = (name) => objectKey(name);

async function rootFor(client, spec) {
  const found = (await client.query(FIND_ROOT_SQL, [spec.contextType])).rows[0];
  if (found) return found.id;
  const r = await client.query(INSERT_OBJECT_SQL, [
    spec.contextType, spec.rootName,
    `What people are said to hold: ${spec.predicate}. Built from confirmed claims (Authorization workbench).`,
    null, JSON.stringify({ knowledgeRoot: true }),
  ]);
  return r.rows[0].id;
}

/**
 * The object `name` of `kind`: an existing one when its name (or an alias) is
 * the same, else a new one under the kind's root. Run inside the caller's
 * transaction. Returns { id, created }.
 */
export async function objectFor(client, kind, name) {
  const spec = KNOWLEDGE[kind];
  if (!spec) throw new Error(`Not a knowledge kind: ${kind}`);
  const display = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_OBJECT_NAME);
  if (!display) throw new Error('An object needs a name');
  const existing = (await client.query(FIND_OBJECT_SQL, [spec.contextType, sqlKey(display)])).rows[0];
  if (existing) return { id: existing.id, created: false };
  const parent = await rootFor(client, spec);
  const r = await client.query(INSERT_OBJECT_SQL, [spec.contextType, display, null, parent, JSON.stringify({ knowledgeKind: kind })]);
  return { id: r.rows[0].id, created: true };
}

export const LIST_OBJECTS_SQL = `
  SELECT c.id, c."displayName", c."contextType",
         COUNT(DISTINCT COALESCE(cl."identityId"::text, cl."principalId"::text))
           FILTER (WHERE cl."claimStatus" IN ('confirmed', 'edited'))::int AS "confirmedPeople",
         COUNT(DISTINCT COALESCE(cl."identityId"::text, cl."principalId"::text))
           FILTER (WHERE cl."claimStatus" = 'proposed')::int AS "proposedPeople"
    FROM "Contexts" c
    LEFT JOIN "ContextClaims" cl ON cl."objectContextId" = c.id
   WHERE c."contextType" = ANY($1::text[])
     AND COALESCE((c."extendedAttributes"->>'knowledgeRoot')::boolean, false) = false
   GROUP BY c.id
   ORDER BY c."contextType", c."displayName"`;

/** The objects of one kind (or all three), each with how many people hold it, confirmed and proposed. */
export async function listObjects(db, kind = null) {
  const types = kind ? [KNOWLEDGE[kind].contextType] : Object.values(KNOWLEDGE).map(k => k.contextType);
  return (await db.query(LIST_OBJECTS_SQL, [types])).rows;
}
