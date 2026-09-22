// Natural-language reports (PROTOTYPE) — spec → parameterised SQL.
//
// Input is a spec that has already passed validateSpec(). Every identifier and
// SQL fragment comes from the catalog; every user- or model-supplied value goes
// into the params array. The compiler is deterministic: the same spec always
// yields the same SQL, which is what makes a saved report trustworthy.

import { ENTITIES } from './catalog.js';
import { likeContains, likeEndsWith, likeStartsWith } from '../db/sqlParams.js';
import { resolveColumn } from './spec.js';
import {
  COMPARE_COLUMNS, compareColumnLabel, compareColumnSql, compareConditions, comparePredicate,
} from './compare.js';

const CAST = { number: '::numeric', boolean: '::boolean', date: '', text: '', enum: '' };

function createContext() {
  let n = 0;
  const params = [];
  return {
    alias: () => `t${n++}`,
    param: (v) => { params.push(v); return `$${params.length}`; },
    params,
    ctes: [],
    refCtes: new Map(),
    fieldCtes: new Set(),
  };
}

/**
 * A field's SQL expression on a table alias. A field that needs a shared lookup
 * computed once per query (the sign-in measurement moment per system) declares it
 * as `cte`; the first use adds it to the query, later uses reuse it.
 */
function fieldExpr(field, alias, ctx) {
  if (field.cte && !ctx.fieldCtes.has(field.cte.name)) {
    ctx.fieldCtes.add(field.cte.name);
    ctx.ctes.push(`${field.cte.name} AS (${field.cte.sql})`);
  }
  return field.sql(alias);
}

function fieldPredicate(field, expr, op, value, ctx) {
  const isText = field.type === 'text' || field.type === 'enum';
  const cast = CAST[field.type];
  switch (op) {
    case 'eq':
      return field.type === 'text'
        ? `lower(${expr}) = lower(${ctx.param(value)})`
        : `${expr} = ${ctx.param(value)}${cast}`;
    case 'neq':
      return field.type === 'text'
        ? `(${expr} IS NULL OR lower(${expr}) <> lower(${ctx.param(value)}))`
        : `(${expr} IS NULL OR ${expr} <> ${ctx.param(value)}${cast})`;
    // Lowercased on both sides, exactly like eq: a list must match the same
    // rows that the same values would match one at a time. The whole list is
    // ONE parameter — a list built per question would otherwise push a
    // different number of placeholders into the SQL text on every call.
    case 'in':
      return `lower(${expr}) = ANY(${ctx.param(value.map(v => String(v).toLowerCase()))})`;
    // ESCAPE '\\' + the shared like* helpers: a value containing % or _ matches
    // literally (routes/likeAudit.test.js enforces this across src/).
    case 'contains': return `${expr} ILIKE ${ctx.param(likeContains(value))} ESCAPE '\\'`;
    case 'notContains': return `(${expr} IS NULL OR ${expr} NOT ILIKE ${ctx.param(likeContains(value))} ESCAPE '\\')`;
    case 'startsWith': return `${expr} ILIKE ${ctx.param(likeStartsWith(value))} ESCAPE '\\'`;
    case 'endsWith': return `${expr} ILIKE ${ctx.param(likeEndsWith(value))} ESCAPE '\\'`;
    case 'isEmpty': return isText ? `(${expr} IS NULL OR ${expr} = '')` : `${expr} IS NULL`;
    case 'isNotEmpty': return isText ? `(${expr} IS NOT NULL AND ${expr} <> '')` : `${expr} IS NOT NULL`;
    case 'gt': return `${expr} > ${ctx.param(value)}::numeric`;
    case 'lt': return `${expr} < ${ctx.param(value)}::numeric`;
    case 'withinLastDays': return `${expr} >= now() - make_interval(days => ${ctx.param(value)}::int)`;
    case 'olderThanDays': return `${expr} < now() - make_interval(days => ${ctx.param(value)}::int)`;
    default: throw new Error(`unsupported operator ${op}`);
  }
}

function joinPredicates(parts, match) {
  if (parts.length === 0) return 'TRUE';
  if (parts.length === 1) return parts[0];
  return `(${parts.join(match === 'any' ? ' OR ' : ' AND ')})`;
}

function conditionSql(entityName, c, alias, ctx) {
  const entity = ENTITIES[entityName];
  if (c.type === 'field') {
    const field = entity.fields[c.field];
    return fieldPredicate(field, fieldExpr(field, alias, ctx), c.op, c.value, ctx);
  }
  if (c.type === 'relation') {
    const rel = entity.relations[c.relation];
    const inner = ctx.alias();
    const { from, where } = rel.from(alias, inner, ctx.alias);
    const innerPreds = c.conditions.map(ic => conditionSql(rel.target, ic, inner, ctx));
    const filter = innerPreds.length ? ` AND ${joinPredicates(innerPreds, c.match)}` : '';
    const exists = `EXISTS (SELECT 1 FROM ${from} WHERE ${where}${filter})`;
    return c.quantifier === 'none' ? `NOT ${exists}` : exists;
  }
  if (c.type === 'compare') return comparePredicate(entityName, c, alias, ctx);
  // group
  return joinPredicates(c.conditions.map(ic => conditionSql(entityName, ic, alias, ctx)), c.match);
}

function columnSql(entityName, colDef, alias, ctx) {
  const entity = ENTITIES[entityName];
  if (colDef.kind === 'field') return fieldExpr(entity.fields[colDef.field], alias, ctx);
  if (colDef.kind === 'compare') return compareColumnSql(entityName, ctx.firstCompare, colDef.sub, alias, ctx);
  const rel = entity.relations[colDef.relation];
  const inner = ctx.alias();
  const { from, where } = rel.from(alias, inner, ctx.alias);
  if (colDef.kind === 'oneRelationField') {
    return `(SELECT ${fieldExpr(ENTITIES[rel.target].fields[colDef.field], inner, ctx)} FROM ${from} WHERE ${where} LIMIT 1)`;
  }
  if (colDef.kind === 'manyCount') return `(SELECT count(DISTINCT ${inner}."id") FROM ${from} WHERE ${where})`;
  return `(SELECT string_agg(DISTINCT ${inner}."displayName", ', ' ORDER BY ${inner}."displayName") FROM ${from} WHERE ${where})`;
}

/** Suffix of the companion column carrying a name list's ids. Not a real column. */
export const LINKS_SUFFIX = '__links';

/** The detail-page kind a name-list column's records belong to, or null. */
export function linkKind(entityName, colDef) {
  if (colDef.kind !== 'manyNames') return null;
  const rel = ENTITIES[entityName].relations[colDef.relation];
  return ENTITIES[rel.target].detailKind ?? null;
}

/**
 * The records behind a name-list column, as `{id, name}` pairs.
 *
 * A `manyNames` column renders as "ASML, AlisQI, Bestuur, …": one string built
 * by string_agg, with every id discarded. That reads fine and is useless for
 * anything else. A chat card could only link the whole run of names to the
 * ROW's own record — so a list of 27 groups became 27 names all pointing at the
 * account that owns them — and a follow-up question about "these groups" had no
 * ids to refer to, because the answer never contained any.
 *
 * Selecting the pairs alongside the string fixes both at the source. The
 * visible column value is unchanged byte for byte, so every existing consumer
 * carries on reading the same string; the pairs ride in a separate column that
 * only callers who know about it look at.
 *
 * DISTINCT is done in an inner SELECT rather than inside jsonb_agg, because
 * `jsonb_agg(DISTINCT x ORDER BY y)` requires the sort key to match the DISTINCT
 * expression — and here they differ deliberately: distinct by (id, name), so
 * two groups that share a name both survive, ordered by name so the list reads
 * in the same order as the string beside it.
 */
function linkColumnSql(entityName, colDef, alias, ctx) {
  if (!linkKind(entityName, colDef)) return null;
  const rel = ENTITIES[entityName].relations[colDef.relation];
  const inner = ctx.alias();
  const { from, where } = rel.from(alias, inner, ctx.alias);
  const pairs = ctx.alias();
  return `(SELECT jsonb_agg(jsonb_build_object('id', ${pairs}."id", 'name', ${pairs}."name") ORDER BY ${pairs}."name")
   FROM (SELECT DISTINCT ${inner}."id" AS "id", ${inner}."displayName" AS "name"
           FROM ${from} WHERE ${where}) ${pairs})`;
}

/** The catalog type of a column, so the route can format values. */
export function columnType(entityName, colDef) {
  const entity = ENTITIES[entityName];
  if (colDef.kind === 'field') return entity.fields[colDef.field].type;
  if (colDef.kind === 'compare') return COMPARE_COLUMNS[colDef.sub].type;
  if (colDef.kind === 'oneRelationField') {
    return ENTITIES[entity.relations[colDef.relation].target].fields[colDef.field].type;
  }
  return colDef.kind === 'manyCount' ? 'number' : 'text';
}

/**
 * @param {object} spec  a spec normalised by validateSpec()
 * @returns {{ text: string, params: any[], columns: object[] }}
 */
export function compileSpec(spec) {
  const entity = ENTITIES[spec.entity];
  const ctx = createContext();
  const root = ctx.alias();
  const compares = compareConditions(spec);
  if (compares.some(c => !c.reference.id)) throw new Error('compare references must be resolved before compiling');
  ctx.firstCompare = compares[0];

  const columns = spec.columns.map(ref => resolveColumn(spec.entity, ref));
  const select = [`${root}."id" AS "__id"`]
    .concat(columns.map(cd => `${columnSql(spec.entity, cd, root, ctx)} AS "${cd.key}"`));
  for (const cd of columns) {
    const pairs = linkColumnSql(spec.entity, cd, root, ctx);
    if (pairs) select.push(`${pairs} AS "${cd.key}${LINKS_SUFFIX}"`);
  }

  const preds = spec.conditions.map(c => conditionSql(spec.entity, c, root, ctx));
  const where = `${entity.where(root)} AND ${joinPredicates(preds, spec.match)}`;

  // A comparison report lists the closest matches first.
  let order;
  // An entity may declare the order its rows are only useful in. `change` does:
  // a list of events sorted by name tells you nothing, and the newest change is
  // the entire point of asking. The request's own sort still wins.
  const sort = spec.sort ?? entity.defaultSort;
  if (sort) {
    order = `${fieldExpr(entity.fields[sort.field], root, ctx)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ${root}."id"`;
  } else {
    const similarity = ctx.firstCompare
      ? `${compareColumnSql(spec.entity, ctx.firstCompare, 'similarity', root, ctx)} DESC NULLS LAST, `
      : '';
    order = `${similarity}${root}."displayName" ASC NULLS LAST, ${root}."id"`;
  }

  // One extra row tells the caller the result was truncated.
  const limit = ctx.param(spec.limit + 1);
  const withClause = ctx.ctes.length ? `WITH ${ctx.ctes.join(',\n')}\n` : '';
  const text = `${withClause}SELECT ${select.join(',\n  ')}\nFROM "${entity.table}" ${root}\nWHERE ${where}\nORDER BY ${order}\nLIMIT ${limit}`;
  return {
    text,
    params: ctx.params,
    columns: columns.map(cd => ({
      key: cd.key,
      label: cd.kind === 'compare' ? compareColumnLabel(cd.sub, ctx.firstCompare) : cd.label,
      type: columnType(spec.entity, cd),
      linkKind: linkKind(spec.entity, cd),
    })),
  };
}
