// Natural-language reports (PROTOTYPE) — spec → parameterised SQL.
//
// Input is a spec that has already passed validateSpec(). Every identifier and
// SQL fragment comes from the catalog; every user- or model-supplied value goes
// into the params array. The compiler is deterministic: the same spec always
// yields the same SQL, which is what makes a saved report trustworthy.

import { ENTITIES, fieldsOf } from './catalog.js';
import { likeContains, likeEndsWith, likeStartsWith } from '../db/sqlParams.js';
import { COUNT_COLUMN, resolveColumn } from './spec.js';

import {
  COMPARE_COLUMNS, compareColumnLabel, compareColumnSql, compareConditions, comparePredicate,
} from './compare.js';

const CAST = { number: '::numeric', boolean: '::boolean', date: '', text: '', enum: '' };

// `extFields` rides along on the context because every field lookup below needs
// it: this deployment's discovered attributes are ordinary fields once they are
// resolved, and they can appear anywhere a catalog field can.
function createContext(extFields) {
  let n = 0;
  const params = [];
  return {
    alias: () => `t${n++}`,
    param: (v) => { params.push(v); return `$${params.length}`; },
    params,
    ctes: [],
    refCtes: new Map(),
    fieldCtes: new Set(),
    extFields,
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
    const field = fieldsOf(entityName, ctx.extFields)[c.field];

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
  if (colDef.kind === 'field') return fieldExpr(fieldsOf(entityName, ctx.extFields)[colDef.field], alias, ctx);

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

/** The catalog type of a column, so the route can format values. */
export function columnType(entityName, colDef, extFields) {
  const entity = ENTITIES[entityName];
  if (colDef.kind === 'field') return fieldsOf(entityName, extFields)[colDef.field].type;

  if (colDef.kind === 'compare') return COMPARE_COLUMNS[colDef.sub].type;
  if (colDef.kind === 'oneRelationField') {
    return ENTITIES[entity.relations[colDef.relation].target].fields[colDef.field].type;
  }
  if (colDef.kind === 'count') return 'number';
  return colDef.kind === 'manyCount' ? 'number' : 'text';
}

const direction = (d) => (d === 'desc' ? 'DESC' : 'ASC');

// Postgres truncates a column alias at 63 bytes and hands the row back under the
// truncated name, so a column addressed by its full name would read as empty. Only
// discovered attributes get that long — `ext.extension_<32 hex>_<name>` is already
// 47 characters before the name — and they are given a short positional alias
// instead. Shorter keys keep their own name, which keeps the SQL shown to the
// analyst readable.
const MAX_ALIAS_BYTES = 63;
const aliasFor = (key, i) => (Buffer.byteLength(key, 'utf8') <= MAX_ALIAS_BYTES ? key : `c${i}`);

/** One row per record: its id (for the detail link) and the picked columns. */
function rowSelect(spec, root, ctx) {
  const columns = spec.columns
    .map(ref => resolveColumn(spec.entity, ref, ctx.extFields))
    .map((cd, i) => ({ ...cd, alias: aliasFor(cd.key, i) }));
  const select = [`${root}."id" AS "__id"`]
    .concat(columns.map(cd => `${columnSql(spec.entity, cd, root, ctx)} AS "${cd.alias}"`));
  return { select, columns, groupClause: '' };
}


function rowOrder(spec, root, ctx) {
  if (spec.sort) {
    const field = fieldsOf(spec.entity, ctx.extFields)[spec.sort.field];
    return `${fieldExpr(field, root, ctx)} ${direction(spec.sort.direction)} NULLS LAST, ${root}."id"`;
  }
  // A comparison report lists the closest matches first.
  const similarity = ctx.firstCompare
    ? `${compareColumnSql(spec.entity, ctx.firstCompare, 'similarity', root, ctx)} DESC NULLS LAST, `
    : '';
  return `${similarity}${root}."displayName" ASC NULLS LAST, ${root}."id"`;
}

/**
 * "How many users per department": one row per distinct value of the grouped
 * field, with how many records hold it. There is no `__id` — a row is a value,
 * not a record — which is what tells the caller not to offer a detail link.
 *
 * Records with no value are a group of their own rather than being dropped:
 * "312 users with no department" is one of the more useful answers this report
 * gives, and silently leaving it out would make the counts fail to add up.
 */
function groupedSelect(spec, root, ctx) {
  const field = fieldsOf(spec.entity, ctx.extFields)[spec.groupBy];
  const expr = fieldExpr(field, root, ctx);
  const alias = aliasFor(spec.groupBy, 0);
  // count(*) is exact: every condition compiles to an EXISTS subquery, so the root
  // table is never joined and no record can be counted twice.
  return {
    select: [`${expr} AS "${alias}"`, `count(*) AS "${COUNT_COLUMN}"`],
    columns: [
      { key: spec.groupBy, alias, label: field.label, kind: 'field', field: spec.groupBy },
      { key: COUNT_COLUMN, alias: COUNT_COLUMN, label: 'Count', kind: 'count' },
    ],
    groupClause: `\nGROUP BY ${expr}`,
  };
}


// Biggest group first unless asked otherwise, with the value as the tie-breaker so
// equal counts come out in a stable order instead of whatever the plan produced.
function groupedOrder(spec, root, ctx) {
  const expr = fieldExpr(fieldsOf(spec.entity, ctx.extFields)[spec.groupBy], root, ctx);
  const sort = spec.sort || { field: COUNT_COLUMN, direction: 'desc' };
  if (sort.field !== COUNT_COLUMN) return `${expr} ${direction(sort.direction)} NULLS LAST`;
  return `count(*) ${direction(sort.direction)} NULLS LAST, ${expr} ASC NULLS LAST`;
}



/**
 * @param {object} spec  a spec normalised by validateSpec()
 * @param {object} [extFields]  this deployment's discovered fields, by entity
 * @returns {{ text: string, params: any[], columns: object[] }}
 */
export function compileSpec(spec, extFields) {
  const entity = ENTITIES[spec.entity];
  const ctx = createContext(extFields);
  const root = ctx.alias();
  const compares = compareConditions(spec);
  if (compares.some(c => !c.reference.id)) throw new Error('compare references must be resolved before compiling');
  ctx.firstCompare = compares[0];

  // Select before conditions before order: each step can add a parameter or a CTE,
  // and the SQL a given spec compiles to must not depend on the order they run in.
  const grouped = !!spec.groupBy;
  const { select, columns, groupClause } = grouped ? groupedSelect(spec, root, ctx) : rowSelect(spec, root, ctx);

  const preds = spec.conditions.map(c => conditionSql(spec.entity, c, root, ctx));
  const where = `${entity.where(root)} AND ${joinPredicates(preds, spec.match)}`;
  const order = grouped ? groupedOrder(spec, root, ctx) : rowOrder(spec, root, ctx);

  // One extra row tells the caller the result was truncated.
  const limit = ctx.param(spec.limit + 1);
  const withClause = ctx.ctes.length ? `WITH ${ctx.ctes.join(',\n')}\n` : '';
  const text = `${withClause}SELECT ${select.join(',\n  ')}\nFROM "${entity.table}" ${root}\nWHERE ${where}${groupClause}\nORDER BY ${order}\nLIMIT ${limit}`;
  return {
    text,
    params: ctx.params,
    columns: columns.map(cd => ({
      key: cd.key,
      alias: cd.alias,
      label: cd.kind === 'compare' ? compareColumnLabel(cd.sub, ctx.firstCompare) : cd.label,
      type: columnType(spec.entity, cd, extFields),
    })),

  };
}

