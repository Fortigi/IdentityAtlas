// SQL fragments shared by the analytics query builders.
//
// Every fragment is a constant or is built from a whitelisted field definition
// (fields.js); values — including discovered extendedAttributes keys, unknown
// labels and scope system ids — always go through `bind`, never into the text.

import { GROUP_PRINCIPAL_TYPE } from '../lib/principalTypes.js';
import { HIDDEN_BY_DEFAULT_RESOURCE_TYPES } from '../lib/resourceVisibility.js';
import { fieldSql } from './fields.js';

// The type values the analytics definitions branch on — the group principals
// excluded from every account count, and the resource types excluded from the
// governed-share denominator. ontologyTerms.test.js checks each against the
// core ontology's value lists.
export const TYPE_VALUE_DEPENDENCIES = Object.freeze([
  { entity: 'Principal', column: 'principalType', value: GROUP_PRINCIPAL_TYPE, usedBy: 'every account count (excluded)' },
  ...HIDDEN_BY_DEFAULT_RESOURCE_TYPES.map(value => (
    { entity: 'Resource', column: 'resourceType', value, usedBy: 'assignments.governedShare denominator (excluded)' })),
]);

// Identity-dimension values for accounts that do not map to exactly one identity.
// An account is counted once per dataset, so it needs ONE bucket.
export const NOT_LINKED = '(not linked)';
export const MULTIPLE_IDENTITIES = '(multiple identities)';

/**
 * One row per linked account: how many identities it belongs to and, when it is
 * exactly one, which. The schema allows an account in several identities (no
 * unique index on IdentityMembers.principalId); such accounts are bucketed, not
 * duplicated. MIN over text because uuid has no MIN aggregate.
 */
export const IDENTITY_MAP_CTE = `idmap AS (
    SELECT im."principalId", COUNT(*)::int AS n, MIN(im."identityId"::text) AS "identityId"
      FROM "IdentityMembers" im
     GROUP BY im."principalId"
  )`;

/** Joins that give an account (alias p) its single identity (alias i). */
export const IDENTITY_JOINS = `LEFT JOIN idmap im ON im."principalId" = p."id"
  LEFT JOIN "Identities" i ON im.n = 1 AND i."id"::text = im."identityId"`;

/**
 * The live-account predicate on alias p: not tombstoned, not a group principal
 * (a container, not an account), and in source scope when the profile has one.
 */
export function liveAccountWhere(scope, bind) {
  const parts = [
    `p."deletedAt" IS NULL`,
    `(p."principalType" IS NULL OR p."principalType" <> ${bind(GROUP_PRINCIPAL_TYPE)})`,
  ];
  if (scope?.systemIds) parts.push(`p."systemId" = ANY(${bind(scope.systemIds)}::int[])`);
  return parts.join(' AND ');
}

/** NULL or blank → the dimension's unknown label. */
export function normalized(valueSql, unknownLabel, bind) {
  return `COALESCE(NULLIF(btrim(${valueSql}), ''), ${bind(unknownLabel)})`;
}

/**
 * The SELECT expression for one dimension on the live tables. Identity
 * dimensions read through the identity map: no identity → NOT_LINKED, several →
 * MULTIPLE_IDENTITIES, otherwise the identity's (normalized) value.
 * `viaAccount` is false only when the query's own grain is the identity.
 */
export function dimensionSql({ field, dimension, bind, viaAccount = true }) {
  const value = normalized(fieldSql(field, bind), dimension.unknownLabel, bind);
  if (field.entity !== 'Identity' || !viaAccount) return value;
  return `CASE WHEN im."principalId" IS NULL THEN ${bind(NOT_LINKED)}
               WHEN im.n > 1 THEN ${bind(MULTIPLE_IDENTITIES)}
               ELSE ${value} END`;
}

/** `SELECT` list items `<expr> AS d0, …` and the matching positional GROUP BY / ORDER BY. */
export function groupingClauses(exprs) {
  if (exprs.length === 0) return { select: '', groupBy: '', orderBy: '' };
  const ordinals = exprs.map((_, i) => i + 1).join(', ');
  return {
    select: exprs.map((e, i) => `${e} AS d${i}`).join(',\n         ') + ',',
    groupBy: `GROUP BY ${ordinals}`,
    orderBy: `ORDER BY ${ordinals}`,
  };
}
