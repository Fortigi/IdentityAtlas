// manager-hierarchy plugin.
//
// Reads `Principals.managerId` within a single system and produces a tree of
// contexts where each node corresponds to a manager (a principal with at
// least one direct report). Members of a node = that manager's direct reports.
//
// Node names are built from one or more *configurable* Principal attributes
// (default: department), optionally with the manager's name appended. An
// attribute can be a real Principal column (department, jobTitle, companyName…)
// or a key inside the extendedAttributes JSON (sfDepartmentName,
// extensionAttribute1…). The default — ["department"] + manager name — keeps the
// classic "<Department> (<Name>)" labelling.
//
// Target type is Principal, not Identity. The richer Identity-targeted variant
// requires account correlation; this plugin stays dependency-free so it works
// the minute Principals are synced.

import * as db from '../../db/connection.js';
import { getPrincipalColumns } from '../../db/columnCache.js';
import {
  compileExcludeRegexes,
  resolveNameFields,
  buildSelectParts,
  buildManagerIds,
  buildManagerContexts,
  buildMemberRows,
} from './manager-hierarchy.helpers.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'manager-hierarchy',
  displayName: 'Manager Hierarchy',
  description:
    'Builds a tree of Principals from their managerId chain. One node per manager; members are their direct reports. ' +
    'Each node is named from configurable Principal attributes (default: Department) — a real column or an ' +
    'extendedAttributes key — optionally with the manager name appended. Requires Principals.managerId to be populated by the crawler.',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: {
        type: 'integer',
        description: 'Systems.id — which system\'s principals to walk.',
      },
      rootName: {
        type: 'string',
        default: 'Organization',
        description: 'Display name of the synthetic root node.',
      },
      nameFields: {
        type: 'array',
        items: { type: 'string' },
        default: ['department'],
        // UI hint: render a dropdown of real Principal attributes + extended
        // attributes with a "+" to add more, instead of a raw-JSON textarea.
        'x-attributeSource': 'principal',
        description:
          'Principal attribute(s) used to name each manager node — a real column ' +
          '(department, jobTitle, companyName…) or an extendedAttributes key ' +
          '(sfDepartmentName, extensionAttribute1…). One field → "<value> (<manager>)"; ' +
          'several → joined with nameSeparator. Unknown field names are ignored.',
      },
      nameSeparator: {
        type: 'string',
        default: ' · ',
        description: 'Separator used when joining multiple nameFields.',
      },
      includeManagerName: {
        type: 'boolean',
        default: true,
        description: 'Append the manager\'s name in parentheses, e.g. "Finance (Doe, John)".',
      },
      excludeNamePatterns: {
        type: 'array',
        description:
          'Display-name regex patterns for principals that should NOT become manager nodes ' +
          'even if other principals point at them. Use to filter out external consultants whose ' +
          'Entra managerId is the consultancy\'s internal admin rather than an operational report ' +
          'line at your tenant. Example: ["\\\\(Quanza\\\\)"] strips every Quanza-tagged Entra admin. ' +
          'Their supposed reports reattach to the tree root. Matching is case-insensitive.',
        items: { type: 'string' },
      },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = parseInt(params.scopeSystemId, 10);
    if (!Number.isFinite(scopeSystemId)) throw new Error('scopeSystemId is required and must be an integer');
    const rootName = (params.rootName || 'Organization').slice(0, 500);
    const separator = typeof params.nameSeparator === 'string' ? params.nameSeparator : ' · ';
    const includeManagerName = params.includeManagerName !== false;

    const excludeRegexes = compileExcludeRegexes(params.excludeNamePatterns);

    // Resolve each requested name field against a whitelist — real columns from
    // the schema, extended keys from the keys present for this system — so a
    // field name never reaches SQL unchecked. Extended keys with quote/backslash
    // characters that can't be safely used as a SQL alias are dropped up front.
    const validCols = new Set((await getPrincipalColumns()).map(c => c.name));
    const validExtKeys = new Set((await db.query(
      `SELECT DISTINCT jsonb_object_keys("extendedAttributes") AS k
         FROM "Principals" WHERE "systemId" = $1 AND "extendedAttributes" IS NOT NULL`,
      [scopeSystemId]
    )).rows.map(r => r.k).filter(k => !/["\\]/.test(k)));

    const resolved = resolveNameFields(params.nameFields, validCols, validExtKeys);
    const nameFieldLabels = resolved.map(r => r.name);
    const naming = { resolved, separator, includeManagerName };

    const { selectParts, queryParams } = buildSelectParts(resolved, scopeSystemId);
    const rows = (await db.query(`
      SELECT ${selectParts.join(', ')}
        FROM "Principals"
       WHERE "systemId" = $1
    `, queryParams)).rows;

    if (rows.length === 0) {
      ctx.log?.(`No principals in system ${scopeSystemId} — nothing to do.`);
      return { contexts: [], members: [] };
    }

    const byId = new Map(rows.map(r => [r.id, r]));

    // Analyst overrides of who a principal reports to (set by dragging a member
    // onto another team in the tree). principalId -> effective managerPrincipalId
    // (null = report to root). These take precedence over the source managerId so
    // a manual move survives every re-run.
    const overrides = new Map(
      (await db.query(`
        SELECT o."principalId", o."managerPrincipalId"
          FROM "ManagerHierarchyOverrides" o
          JOIN "Principals" p ON p.id = o."principalId"
         WHERE p."systemId" = $1
      `, [scopeSystemId])).rows.map(r => [r.principalId, r.managerPrincipalId])
    );

    const { managerIds, excludedCount } = buildManagerIds(rows, byId, excludeRegexes, overrides);
    if (excludedCount > 0) {
      ctx.log?.(`Excluded ${excludedCount} principal(s) from becoming manager nodes via excludeNamePatterns.`);
    }

    // Synthetic root. externalId = 'root'. Everything ends up under this so
    // analysts see a single tree rather than a forest of roots-with-no-manager.
    const rootExt = 'root';
    const contexts = [
      {
        externalId: rootExt,
        displayName: rootName,
        contextType: 'ManagerHierarchy',
        description: `Manager hierarchy for system ${scopeSystemId}, generated by manager-hierarchy plugin. Named by: ${nameFieldLabels.join(', ') || 'manager name'}.`,
      },
      ...buildManagerContexts(managerIds, byId, rootExt, naming),
    ];
    const members = buildMemberRows(rows, managerIds, overrides, rootExt);

    ctx.log?.(`Built ${contexts.length} contexts, ${members.length} member rows. Named by [${nameFieldLabels.join(', ') || 'manager name'}].`);
    return { contexts, members };
  },
};
