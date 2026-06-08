// custom-org-tree plugin (prototype).
//
// Same manager-relationship tree as `manager-hierarchy`, but each node's name
// is built from one or more *configurable* Principal attributes instead of
// being hard-wired to `department`. Pick a single field (e.g. jobTitle), or
// several (e.g. department + companyName) joined by a separator, and optionally
// append the manager's name.
//
// Target type is Principal (like manager-hierarchy) so it works as soon as
// Principals + managerId are synced, without requiring account correlation.

import * as db from '../../db/connection.js';
import RE2 from 're2';
import { getPrincipalColumns } from '../../db/columnCache.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'custom-org-tree',
  displayName: 'Org Tree (custom naming)',
  description:
    'Builds a manager-based org tree (like Manager Hierarchy) but names each node from configurable ' +
    'Principal attributes — e.g. Department, Job Title, Company, or several joined together — instead ' +
    'of always using Department.',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: {
        type: 'integer',
        description: "Systems.id — which system's principals to walk.",
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
        description:
          'Principal attribute(s) used to name each manager node. One field → "<value> (<manager>)"; ' +
          'several → joined with nameSeparator. Unknown field names are ignored. ' +
          'Examples: ["jobTitle"], ["department","companyName"].',
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
        items: { type: 'string' },
        description:
          'Case-insensitive regex patterns for manager display names that should NOT become nodes ' +
          '(their reports reattach to the root). Same semantics as manager-hierarchy.',
      },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = parseInt(params.scopeSystemId, 10);
    if (!Number.isFinite(scopeSystemId)) throw new Error('scopeSystemId is required and must be an integer');
    const rootName = (params.rootName || 'Organization').slice(0, 500);
    const separator = typeof params.nameSeparator === 'string' ? params.nameSeparator : ' · ';
    const includeManagerName = params.includeManagerName !== false;

    // Validate requested name fields against the REAL Principal columns — this
    // both prevents SQL injection (the field names go straight into the SELECT)
    // and silently drops typo'd fields. Fall back to department, else nothing.
    const validCols = new Set((await getPrincipalColumns()).map((c) => c.name));
    let nameFields = (Array.isArray(params.nameFields) ? params.nameFields : [])
      .filter((f) => typeof f === 'string' && validCols.has(f));
    if (nameFields.length === 0 && validCols.has('department')) nameFields = ['department'];

    const excludeRegexes = (params.excludeNamePatterns || []).map((src, i) => {
      try { return new RE2(src, 'i'); }
      catch (e) { throw new Error(`excludeNamePatterns[${i}] is not a valid regex: ${e.message}`); }
    });
    const matchesExclude = (name) => !!name && excludeRegexes.some((re) => re.test(name));

    const fieldCols = nameFields.map((f) => `"${f}"`).join(', ');
    const rows = (await db.query(`
      SELECT id, "displayName", "managerId"${fieldCols ? ', ' + fieldCols : ''}
        FROM "Principals"
       WHERE "systemId" = $1
    `, [scopeSystemId])).rows;

    if (rows.length === 0) {
      ctx.log?.(`No principals in system ${scopeSystemId} — nothing to do.`);
      return { contexts: [], members: [] };
    }

    const byId = new Map(rows.map((r) => [r.id, r]));

    const managerIds = new Set();
    let excludedCount = 0;
    for (const r of rows) {
      if (!r.managerId) continue;
      const mgr = byId.get(r.managerId);
      if (mgr && matchesExclude(mgr.displayName)) { excludedCount++; continue; }
      managerIds.add(r.managerId);
    }
    if (excludedCount > 0) ctx.log?.(`Excluded ${excludedCount} manager node(s) via excludeNamePatterns.`);

    // Build a node name from the configured fields (+ optional manager name).
    const nameFor = (mgr) => {
      const mgrName = mgr?.displayName || 'Unknown';
      const parts = nameFields.map((f) => (mgr?.[f] == null ? '' : String(mgr[f]).trim())).filter(Boolean);
      const label = parts.join(separator);
      if (label && includeManagerName) return `${label} (${mgrName})`;
      if (label) return label;
      return mgrName; // no attribute values → fall back to the person's name
    };

    const contexts = [{
      externalId: 'root',
      displayName: rootName,
      contextType: 'OrgTree',
      description: `Custom org tree for system ${scopeSystemId} (custom-org-tree plugin). Named by: ${nameFields.join(', ') || 'manager name'}.`,
    }];

    for (const managerId of managerIds) {
      const mgr = byId.get(managerId);
      const parentManagerId = mgr?.managerId && managerIds.has(mgr.managerId) ? mgr.managerId : null;
      contexts.push({
        externalId: managerId,
        displayName: nameFor(mgr),
        contextType: 'OrgTree',
        parentExternalId: parentManagerId || 'root',
      });
    }

    const members = [];
    for (const p of rows) {
      if (p.managerId && managerIds.has(p.managerId)) {
        members.push({ contextExternalId: p.managerId, memberId: p.id });
      } else if (!managerIds.has(p.id)) {
        members.push({ contextExternalId: 'root', memberId: p.id });
      }
    }

    ctx.log?.(`Built ${contexts.length} contexts, ${members.length} member rows. Named by [${nameFields.join(', ') || 'manager name'}].`);
    return { contexts, members };
  },
};
