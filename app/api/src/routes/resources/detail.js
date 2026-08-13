// Phase helpers for GET /api/resources/:id, extracted from resources.js so the
// handler — a long sequence of independent attribute/count fetches — stays
// under the complexity threshold.
// Each fetch keeps its own try/catch (swallow a missing optional table, rethrow
// anything else to the handler's 500). Covered through resources.test.js +
// resources.contract.test.js. SQL is moved verbatim — no behaviour change.

import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { cleanRow, getPermissionTable } from '../details/shared.js';
import { isMissingSchema } from '../../db/schemaErrors.js';

// 1. Current attributes (+ parsed extendedAttributes). Returns null when the
//    resource doesn't exist (handler → 404).
export async function fetchResourceAttributes(pool, res, resourceId) {
  const resourceResult = await timedQuery(pool, 'resource-attributes', res,
    `SELECT * FROM "Resources" WHERE id = $1`, [resourceId]);
  if (resourceResult.rows.length === 0) return null;
  const attributes = cleanRow(resourceResult.rows[0]);
  // Normalise extendedAttributes (pg returns JSONB already parsed).
  if (attributes.extendedAttributes) {
    attributes.extendedAttributesParsed = parseJsonbColumn(attributes.extendedAttributes);
  }
  return attributes;
}

// 1b. Risk score — stored in RiskScores keyed by (entityId, entityType). Merge
//     it onto attributes so the detail page's Risk tab can render.
export async function mergeResourceRiskScore(attributes, resourceId) {
  try {
    const rs = await db.query(
      `SELECT "riskScore", "riskTier", "riskDirectScore", "riskMembershipScore",
              "riskStructuralScore", "riskPropagatedScore", "riskExplanation",
              "riskClassifierMatches", "riskOverride", "riskOverrideReason", "riskScoredAt"
         FROM "RiskScores"
        WHERE "entityId"::text = $1 AND "entityType" = 'Resource'
        LIMIT 1`,
      [resourceId]
    );
    if (rs.rows.length > 0) Object.assign(attributes, cleanRow(rs.rows[0]));
  } catch (e) { if (!isMissingSchema(e)) throw e; /* RiskScores may not exist on older deployments */ }
}

// 2. Tags (both 'resource' and 'group' entity types, for backward compat).
export async function fetchResourceTags(pool, res, resourceId) {
  try {
    const r = await timedQuery(pool, 'resource-tags', res, `
        SELECT t.id, t.name, t.color
        FROM "GraphTagAssignments" ta
        JOIN "GraphTags" t ON ta."tagId" = t.id
        WHERE ta."entityId" = $1 AND t."entityType" IN ('resource', 'group')
      `, [resourceId]);
    return r.rows;
  } catch (e) { if (!isMissingSchema(e)) throw e; return []; /* table may not exist */ }
}

// 3. Member count, broken down by the universal assignmentType (Direct /
//    Indirect / Eligible). Falls back to the permission view (no type breakdown)
//    when ResourceAssignments is absent.
export async function fetchMemberBreakdown(pool, res, resourceId) {
  let memberCount = 0;
  const assignmentByType = { Direct: 0, Indirect: 0, Eligible: 0 };
  try {
    const r = await timedQuery(pool, 'resource-member-breakdown', res, `
        SELECT "assignmentType",
               COUNT(DISTINCT "principalId")::int AS cnt
        FROM "ResourceAssignments"
        WHERE "resourceId" = $1
        GROUP BY "assignmentType"
      `, [resourceId]);
    for (const row of r.rows) {
      if (row.assignmentType in assignmentByType) assignmentByType[row.assignmentType] = row.cnt;
    }
    memberCount = Object.values(assignmentByType).reduce((a, b) => a + b, 0);
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    // Fall back to permission view (no type breakdown there — leave counts 0)
    try {
      const table = await getPermissionTable(pool);
      const r = await timedQuery(pool, 'resource-member-count-view', res,
        `SELECT COUNT(DISTINCT "memberId") AS cnt FROM ${table} WHERE "resourceId" = $1`, [resourceId]);
      memberCount = r.rows[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* view may not exist */ }
  }
  return { memberCount, assignmentByType };
}

// 4. Access-package count (business roles that contain this resource).
export async function fetchAccessPackageCount(pool, res, resourceId) {
  try {
    const r = await timedQuery(pool, 'resource-ap-count', res, `
        SELECT COUNT(DISTINCT rrs."parentResourceId") AS cnt
        FROM "ResourceRelationships" rrs
        INNER JOIN "Resources" br ON rrs."parentResourceId" = br.id AND br."resourceType" = 'BusinessRole'
        WHERE rrs."childResourceId" = $1
          AND rrs."relationshipType" = 'Contains'
          AND rrs."parentResourceId" IS NOT NULL
      `, [resourceId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* table may not exist */ }
}

// 4b. Parent resource count (all parents via any relationship type).
export async function fetchParentResourceCount(pool, res, resourceId) {
  try {
    const r = await timedQuery(pool, 'resource-parent-count', res, `
        SELECT COUNT(DISTINCT rrs."parentResourceId") AS cnt
        FROM "ResourceRelationships" rrs
        WHERE rrs."childResourceId" = $1
      `, [resourceId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* table may not exist */ }
}

// 5. History count (v5: the _history audit table).
export async function fetchResourceHistoryCount(resourceId) {
  try {
    const r = await db.queryOne(
      `SELECT COUNT(*)::int AS cnt FROM "_history" WHERE "tableName" = 'Resources' AND "rowId" = $1`,
      [resourceId]
    );
    return r?.cnt ?? 0;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* _history may not exist on older deployments */ }
}

// 6. Context-membership count (v6 — the ContextMembers join, memberType scope).
export async function fetchResourceContextCount(resourceId) {
  try {
    const r = await db.queryOne(
      `SELECT COUNT(*)::int AS cnt FROM "ContextMembers" WHERE "memberType" = 'Resource' AND "memberId"::text = $1`,
      [resourceId]
    );
    return r?.cnt ?? 0;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* ContextMembers may not exist on older deployments */ }
}
