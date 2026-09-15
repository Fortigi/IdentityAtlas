// Natural-language reports (PROTOTYPE) — spec → parameterised SQL.
//
// Input is a spec that has already passed validateSpec(). Every identifier and
// SQL fragment comes from the catalog; every user- or model-supplied value goes
// into the params array. The compiler is deterministic: the same spec always
// yields the same SQL, which is what makes a saved report trustworthy.

import { ENTITIES } from './catalog.js';
import { resolveColumn } from './spec.js';

const CAST = { number: '::numeric', boolean: '::boolean', date: '', text: '', enum: '' };

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

function createContext() {
  let n = 0;
  const params = [];
  return {
    alias: () => `t${n++}`,
    param: (v) => { params.push(v); return `$${params.length}`; },
    params,
  };
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
    case 'contains': return `${expr} ILIKE ${ctx.param(`%${escapeLike(value)}%`)}`;
    case 'notContains': return `(${expr} IS NULL OR ${expr} NOT ILIKE ${ctx.param(`%${escapeLike(value)}%`)})`;
    case 'startsWith': return `${expr} ILIKE ${ctx.param(`${escapeLike(value)}%`)}`;
    case 'endsWith': return `${expr} ILIKE ${ctx.param(`%${escapeLike(value)}`)}`;
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
    return fieldPredicate(field, field.sql(alias), c.op, c.value, ctx);
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
  // group
  return joinPredicates(c.conditions.map(ic => conditionSql(entityName, ic, alias, ctx)), c.match);
}

function columnSql(entityName, colDef, alias, ctx) {
  const entity = ENTITIES[entityName];
  if (colDef.kind === 'field') return entity.fields[colDef.field].sql(alias);
  const rel = entity.relations[colDef.relation];
  const inner = ctx.alias();
  const { from, where } = rel.from(alias, inner, ctx.alias);
  if (colDef.kind === 'oneRelationField') {
    return `(SELECT ${ENTITIES[rel.target].fields[colDef.field].sql(inner)} FROM ${from} WHERE ${where} LIMIT 1)`;
  }
  if (colDef.kind === 'manyCount') return `(SELECT count(DISTINCT ${inner}."id") FROM ${from} WHERE ${where})`;
  return `(SELECT string_agg(DISTINCT ${inner}."displayName", ', ' ORDER BY ${inner}."displayName") FROM ${from} WHERE ${where})`;
}

/** The catalog type of a column, so the route can format values. */
export function columnType(entityName, colDef) {
  const entity = ENTITIES[entityName];
  if (colDef.kind === 'field') return entity.fields[colDef.field].type;
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

  const columns = spec.columns.map(ref => resolveColumn(spec.entity, ref));
  const select = [`${root}."id" AS "__id"`]
    .concat(columns.map(cd => `${columnSql(spec.entity, cd, root, ctx)} AS "${cd.key}"`));

  const preds = spec.conditions.map(c => conditionSql(spec.entity, c, root, ctx));
  const where = `${entity.where(root)} AND ${joinPredicates(preds, spec.match)}`;

  const order = spec.sort
    ? `${entity.fields[spec.sort.field].sql(root)} ${spec.sort.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ${root}."id"`
    : `${root}."displayName" ASC NULLS LAST, ${root}."id"`;

  // One extra row tells the caller the result was truncated.
  const limit = ctx.param(spec.limit + 1);
  const text = `SELECT ${select.join(',\n  ')}\nFROM "${entity.table}" ${root}\nWHERE ${where}\nORDER BY ${order}\nLIMIT ${limit}`;
  return {
    text,
    params: ctx.params,
    columns: columns.map(cd => ({ key: cd.key, label: cd.label, type: columnType(spec.entity, cd) })),
  };
}
