// Natural-language reports (PROTOTYPE) — the "compare with a reference" building block.
//
// Role-mining questions compare SETS: "groups with the same members as business
// role X", "users with the same group memberships as Jan", "groups that overlap
// 80% with group Y". A compare condition keeps a row when the set it reaches over
// a many-relation (its members, its groups, …) relates to the same set of one
// reference record in the requested way:
//
//   identical    the two sets are equal (and not empty)
//   containsAll  the row has every item the reference has (superset)
//   within       everything the row has, the reference has too (subset, not empty)
//   similar      Jaccard overlap ≥ minSimilarity %
//
// The reference is named by the model ("Fortigi - Algemeen - Maten"); the service
// resolves it to exactly one record id before anything runs (resolveReferences),
// and asks the analyst when the name is ambiguous. SQL compares ids only.

import { ENTITIES } from './catalog.js';

export const MEASURES = {
  identical: { label: 'exactly the same' },
  containsAll: { label: 'contains all of' },
  within: { label: 'only items also in' },
  similar: { label: 'mostly the same (≥ %)' },
};

export const DEFAULT_MIN_SIMILARITY = 80;
export const MAX_COMPARES = 3;

export const COMPARE_COLUMNS = {
  similarity: { label: 'Similarity %', type: 'number' },
  shared: { label: 'Shared', type: 'number' },
  onlyHere: { label: 'Only here', type: 'number' },
  onlyReference: { label: 'Only in reference', type: 'number' },
  onlyHereNames: { label: 'Only here (names)', type: 'text' },
  onlyReferenceNames: { label: 'Missing vs reference (names)', type: 'text' },
};
export const DEFAULT_COMPARE_COLUMNS = ['compare.similarity', 'compare.onlyHereNames', 'compare.onlyReferenceNames'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const has = (obj, key) => obj != null && Object.hasOwn(obj, key);

/** The base entity (no implied type filter) that shares a table with this one. */
export function baseEntityOf(entityName) {
  const table = ENTITIES[entityName].table;
  return Object.keys(ENTITIES).find(n => ENTITIES[n].table === table && !ENTITIES[n].implicit) || entityName;
}

export const manyRelationsOf = (entityName) =>
  Object.entries(ENTITIES[entityName].relations).filter(([, r]) => r.cardinality === 'many').map(([n]) => n);

/**
 * Validate one compare condition.
 * @param {Function} aliasOf  maps an entity word ("groups", "resource") to an entity name, or undefined
 */
export function validateCompare(entityName, c, err, aliasOf) {
  const entity = ENTITIES[entityName];
  const rel = has(entity.relations, c.relation) ? entity.relations[c.relation] : null;
  if (!rel || rel.cardinality !== 'many') {
    err(`compare needs one of these relations of ${entityName}: ${manyRelationsOf(entityName).join(', ')}`);
    return null;
  }
  if (!has(MEASURES, c.measure)) {
    err(`compare measure must be one of: ${Object.keys(MEASURES).join(', ')}`);
    return null;
  }
  const refEntityName = aliasOf(c.reference?.entity);
  if (!refEntityName) {
    err(`compare reference needs an entity (${Object.keys(ENTITIES).join(', ')})`);
    return null;
  }
  const refRel = ENTITIES[refEntityName].relations[c.relation];
  if (!refRel || ENTITIES[refRel.target].table !== ENTITIES[rel.target].table) {
    err(`a ${refEntityName} has no "${c.relation}" to compare with`);
    return null;
  }
  const name = typeof c.reference?.name === 'string' ? c.reference.name.trim() : '';
  if (!name) { err('compare reference needs the name of the record to compare with'); return null; }
  if (name.length > 200) { err('compare reference name is too long'); return null; }

  const out = { type: 'compare', relation: c.relation, measure: c.measure, reference: { entity: refEntityName, name } };
  if (typeof c.reference.id === 'string' && UUID.test(c.reference.id)) out.reference.id = c.reference.id;
  if (typeof c.reference.type === 'string' && c.reference.type.length <= 100) out.reference.type = c.reference.type;
  if (c.measure === 'similar') {
    const n = Number(c.minSimilarity ?? DEFAULT_MIN_SIMILARITY);
    if (!Number.isFinite(n) || n < 1 || n > 100) { err('minSimilarity must be a percentage between 1 and 100'); return null; }
    out.minSimilarity = Math.round(n);
  }
  return out;
}

/** Every compare condition in a spec, top-level first, then inside groups. */
export function compareConditions(spec) {
  const out = [];
  for (const c of spec.conditions) {
    if (c.type === 'compare') out.push(c);
    if (c.type === 'group') out.push(...c.conditions.filter(ic => ic.type === 'compare'));
  }
  return out;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

/** CTE with the reference record's set, memoised per condition. */
function referenceCte(c, ctx) {
  if (!ctx.refCtes.has(c)) {
    const refEntity = ENTITIES[c.reference.entity];
    const outer = ctx.alias();
    const inner = ctx.alias();
    const { from, where } = refEntity.relations[c.relation].from(outer, inner, ctx.alias);
    const name = `ref${ctx.refCtes.size}`;
    ctx.ctes.push(`${name} AS (SELECT DISTINCT ${inner}."id" AS id FROM "${refEntity.table}" ${outer}, ${from}
      WHERE ${outer}."id" = ${ctx.param(c.reference.id)}::uuid AND ${where})`);
    ctx.refCtes.set(c, name);
  }
  return ctx.refCtes.get(c);
}

function candidateSelect(entityName, c, alias, ctx) {
  const inner = ctx.alias();
  const { from, where } = ENTITIES[entityName].relations[c.relation].from(alias, inner, ctx.alias);
  return { sql: `SELECT DISTINCT ${inner}."id" AS id FROM ${from} WHERE ${where}`, from, where, inner };
}

function metrics(entityName, c, alias, ctx) {
  const ref = referenceCte(c, ctx);
  const cand = () => candidateSelect(entityName, c, alias, ctx).sql;
  return {
    ref,
    shared: `(SELECT count(*) FROM (${cand()}) c WHERE c.id IN (SELECT id FROM ${ref}))`,
    size: `(SELECT count(*) FROM (${cand()}) c)`,
    refSize: `(SELECT count(*) FROM ${ref})`,
  };
}

export function comparePredicate(entityName, c, alias, ctx) {
  const m = metrics(entityName, c, alias, ctx);
  let pred;
  switch (c.measure) {
    case 'identical': pred = `(${m.refSize} > 0 AND ${m.size} = ${m.refSize} AND ${m.shared} = ${m.refSize})`; break;
    case 'containsAll': pred = `(${m.refSize} > 0 AND ${m.shared} = ${m.refSize})`; break;
    case 'within': pred = `(${m.size} > 0 AND ${m.shared} = ${m.size})`; break;
    default: pred = `(${m.refSize} > 0 AND ${m.shared} * 100 >= ${ctx.param(c.minSimilarity)}::int * (${m.size} + ${m.refSize} - ${m.shared}))`;
  }
  // The reference itself trivially matches — never list it.
  const sameTable = ENTITIES[entityName].table === ENTITIES[c.reference.entity].table;
  return sameTable ? `(${alias}."id" <> ${ctx.param(c.reference.id)}::uuid AND ${pred})` : pred;
}

export function compareColumnSql(entityName, c, sub, alias, ctx) {
  const m = metrics(entityName, c, alias, ctx);
  switch (sub) {
    case 'similarity': return `round(100.0 * ${m.shared} / NULLIF(${m.size} + ${m.refSize} - ${m.shared}, 0))`;
    case 'shared': return m.shared;
    case 'onlyHere': return `(${m.size} - ${m.shared})`;
    case 'onlyReference': return `(${m.refSize} - ${m.shared})`;
    case 'onlyHereNames': {
      const cand = candidateSelect(entityName, c, alias, ctx);
      return `(SELECT string_agg(DISTINCT ${cand.inner}."displayName", ', ' ORDER BY ${cand.inner}."displayName")
        FROM ${cand.from} WHERE ${cand.where} AND ${cand.inner}."id" NOT IN (SELECT id FROM ${m.ref}))`;
    }
    default: {
      const target = ENTITIES[ENTITIES[entityName].relations[c.relation].target].table;
      const x = ctx.alias();
      return `(SELECT string_agg(DISTINCT ${x}."displayName", ', ' ORDER BY ${x}."displayName") FROM "${target}" ${x}
        WHERE ${x}."id" IN (SELECT id FROM ${m.ref}) AND ${x}."id" NOT IN (${candidateSelect(entityName, c, alias, ctx).sql}))`;
    }
  }
}

// ── Plain language ───────────────────────────────────────────────────────────

function humanType(type, fallback) {
  if (!type) return fallback;
  return type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

export function explainCompare(entityName, c) {
  const rel = ENTITIES[entityName].relations[c.relation];
  const noun = rel.compareNoun || rel.label.toLowerCase();
  const ref = `${humanType(c.reference.type, ENTITIES[c.reference.entity].label.toLowerCase())} "${c.reference.name}"`;
  switch (c.measure) {
    case 'identical': return `has exactly the same ${noun} as ${ref}`;
    case 'containsAll': return `has all ${noun} of ${ref} (and possibly more)`;
    case 'within': return `has only ${noun} that ${ref} also has`;
    default: return `shares at least ${c.minSimilarity}% of its ${noun} with ${ref}`;
  }
}

export function compareColumnLabel(sub, c) {
  if (sub === 'onlyReference') return `Only in "${c.reference.name}"`;
  if (sub === 'onlyReferenceNames') return `Missing vs "${c.reference.name}"`;
  return COMPARE_COLUMNS[sub].label;
}

// ── Reference resolution (needs the database) ────────────────────────────────

const typeColumn = (table) => (table === 'Resources' ? 'resourceType' : 'principalType');

async function findByName(query, entityName, name, exact) {
  const entity = ENTITIES[entityName];
  const t = 'r0';
  const { rows } = await query(
    `SELECT ${t}."id", ${t}."displayName", ${t}."${typeColumn(entity.table)}" AS type FROM "${entity.table}" ${t}
     WHERE ${entity.where(t)} AND ${exact ? `lower(${t}."displayName") = lower($1)` : `${t}."displayName" ILIKE $1`}
     ORDER BY ${t}."displayName" LIMIT 6`,
    [exact ? name : `%${name.replace(/[\\%_]/g, (m) => `\\${m}`)}%`],
  );
  return rows;
}

/**
 * Resolve every compare reference in a validated spec to one record id, in place.
 * Tries the named entity first, then its base entity (a business role named as a
 * "group" is still found); exact names win over partial ones.
 * @param {Function} query  db query function
 * @returns {Promise<{ problems: { kind: 'ambiguous'|'notFound'|'gone', name: string, label: string, options: string[] }[] }>}
 */
export async function resolveReferences(spec, query) {
  const problems = [];
  for (const c of compareConditions(spec)) {
    const ref = c.reference;
    const label = ENTITIES[ref.entity].label.toLowerCase();
    const candidates = [...new Set([ref.entity, baseEntityOf(ref.entity)])];

    if (ref.id) {
      const table = ENTITIES[ref.entity].table;
      const { rows } = await query(
        `SELECT "id", "displayName", "${typeColumn(table)}" AS type FROM "${table}" WHERE "id" = $1 AND "deletedAt" IS NULL`, [ref.id]);
      if (rows.length === 1) { ref.name = rows[0].displayName; ref.type = rows[0].type; continue; }
      delete ref.id;
    }

    let resolved = false;
    for (const exact of [true, false]) {
      for (const entityName of candidates) {
        const rows = await findByName(query, entityName, ref.name, exact);
        if (rows.length === 1) {
          Object.assign(ref, { entity: entityName, id: rows[0].id, name: rows[0].displayName, type: rows[0].type });
          resolved = true;
        } else if (rows.length > 1) {
          problems.push({ kind: 'ambiguous', name: ref.name, label, options: rows.map(r => r.displayName) });
          resolved = true;
        }
        if (resolved) break;
      }
      if (resolved) break;
    }
    if (!resolved) problems.push({ kind: 'notFound', name: ref.name, label, options: [] });
  }
  return { problems };
}

export function referenceProblemText(p) {
  return p.kind === 'ambiguous'
    ? `Which ${p.label} do you mean by "${p.name}"?`
    : `I could not find a ${p.label} named "${p.name}". What is its exact name?`;
}
