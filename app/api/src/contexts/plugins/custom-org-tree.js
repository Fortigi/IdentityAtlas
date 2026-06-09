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
        // UI hint: render a dropdown of real Principal attributes with a "+" to
        // add more, instead of a raw-JSON textarea. (See RunPluginModal.)
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

    // Resolve each requested name field to either a REAL Principal column or a
    // key inside the extendedAttributes JSON (e.g. sfDepartmentName). Both are
    // validated against a whitelist — real columns from the schema, extended
    // keys from the keys actually present for this system — so a field name
    // never reaches SQL unchecked. Unknown fields are dropped; fall back to
    // department. Each resolved field gets a positional output alias (f0, f1…).
    const validCols = new Set((await getPrincipalColumns()).map((c) => c.name));
    const validExtKeys = new Set((await db.query(
      `SELECT DISTINCT jsonb_object_keys("extendedAttributes") AS k
         FROM "Principals" WHERE "systemId" = $1 AND "extendedAttributes" IS NOT NULL`,
      [scopeSystemId]
    )).rows.map((r) => r.k));

    const requested = (Array.isArray(params.nameFields) ? params.nameFields : [])
      .filter((f) => typeof f === 'string');
    const resolved = []; // { name, real }
    for (const f of requested) {
      if (validCols.has(f)) resolved.push({ name: f, real: true });
      else if (validExtKeys.has(f)) resolved.push({ name: f, real: false });
    }
    if (resolved.length === 0 && validCols.has('department')) resolved.push({ name: 'department', real: true });
    const nameFieldLabels = resolved.map((r) => r.name);

    const excludeRegexes = (params.excludeNamePatterns || []).map((src, i) => {
      try { return new RE2(src, 'i'); }
      catch (e) { throw new Error(`excludeNamePatterns[${i}] is not a valid regex: ${e.message}`); }
    });
    const matchesExclude = (name) => !!name && excludeRegexes.some((re) => re.test(name));

    // Build the SELECT: real columns inline (whitelisted), extended keys via a
    // parameterized ->> with a safe positional alias.
    const selectParts = ['id', '"displayName"', '"managerId"'];
    const queryParams = [scopeSystemId];
    resolved.forEach((r, i) => {
      if (r.real) {
        selectParts.push(`"${r.name}" AS "f${i}"`);
      } else {
        queryParams.push(r.name);
        selectParts.push(`"extendedAttributes" ->> $${queryParams.length} AS "f${i}"`);
      }
    });
    const rows = (await db.query(`
      SELECT ${selectParts.join(', ')}
        FROM "Principals"
       WHERE "systemId" = $1
    `, queryParams)).rows;

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

    // Build a node name from the resolved fields (read via their f0/f1… alias)
    // plus the optional manager name.
    const nameFor = (mgr) => {
      const mgrName = mgr?.displayName || 'Unknown';
      const parts = resolved
        .map((_, i) => (mgr?.[`f${i}`] == null ? '' : String(mgr[`f${i}`]).trim()))
        .filter(Boolean);
      const label = parts.join(separator);
      if (label && includeManagerName) return `${label} (${mgrName})`;
      if (label) return label;
      return mgrName; // no attribute values → fall back to the person's name
    };

    const contexts = [{
      externalId: 'root',
      displayName: rootName,
      contextType: 'OrgTree',
      description: `Custom org tree for system ${scopeSystemId} (custom-org-tree plugin). Named by: ${nameFieldLabels.join(', ') || 'manager name'}.`,
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

    ctx.log?.(`Built ${contexts.length} contexts, ${members.length} member rows. Named by [${nameFieldLabels.join(', ') || 'manager name'}].`);
    return { contexts, members };
  },
};
