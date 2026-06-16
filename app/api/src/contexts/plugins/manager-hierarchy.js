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
import RE2 from 're2';
import { getPrincipalColumns } from '../../db/columnCache.js';

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

    // Compile exclude patterns up front so we fail the run — not every row —
    // on a malformed regex. RE2 guarantees linear-time matching, so an
    // admin-supplied pattern can't cause catastrophic backtracking.
    const excludeRegexes = (params.excludeNamePatterns || []).map((src, i) => {
      try { return new RE2(src, 'i'); }
      catch (e) { throw new Error(`excludeNamePatterns[${i}] is not a valid regex: ${e.message}`); }
    });
    const matchesExclude = (name) => !!name && excludeRegexes.some(re => re.test(name));

    // Resolve each requested name field to a REAL Principal column or an
    // extendedAttributes key. Both are validated against a whitelist — real
    // columns from the schema, extended keys from the keys present for this
    // system — so a field name never reaches SQL unchecked. Unknown fields are
    // dropped; fall back to department. Skip extended keys with quote/backslash
    // characters that can't be safely used as a SQL alias.
    const validCols = new Set((await getPrincipalColumns()).map(c => c.name));
    const validExtKeys = new Set((await db.query(
      `SELECT DISTINCT jsonb_object_keys("extendedAttributes") AS k
         FROM "Principals" WHERE "systemId" = $1 AND "extendedAttributes" IS NOT NULL`,
      [scopeSystemId]
    )).rows.map(r => r.k).filter(k => !/["\\]/.test(k)));

    const requested = (Array.isArray(params.nameFields) ? params.nameFields : []).filter(f => typeof f === 'string');
    const resolved = []; // { name, real }
    for (const f of requested) {
      if (validCols.has(f)) resolved.push({ name: f, real: true });
      else if (validExtKeys.has(f)) resolved.push({ name: f, real: false });
    }
    if (resolved.length === 0 && validCols.has('department')) resolved.push({ name: 'department', real: true });
    const nameFieldLabels = resolved.map(r => r.name);

    // Build the SELECT: real columns inline (whitelisted); extended keys via a
    // parameterized ->> aliased to the key name so each value is read by name.
    const selectParts = ['id', '"displayName"', '"managerId"'];
    const queryParams = [scopeSystemId];
    for (const r of resolved) {
      if (r.real) {
        selectParts.push(`"${r.name}"`);
      } else {
        queryParams.push(r.name);
        selectParts.push(`"extendedAttributes" ->> $${queryParams.length} AS "${r.name}"`);
      }
    }
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
    const effMgrId = (p) => (overrides.has(p.id) ? overrides.get(p.id) : p.managerId);

    // Start from "every referenced managerId", then remove anyone whose
    // displayName matches an excludeNamePattern. After exclusion, their
    // would-be reports fall through to the "go to root" branch below.
    const managerIds = new Set();
    let excludedCount = 0;
    for (const r of rows) {
      if (!r.managerId) continue;
      const mgr = byId.get(r.managerId);
      if (mgr && matchesExclude(mgr.displayName)) { excludedCount++; continue; }
      managerIds.add(r.managerId);
    }
    if (excludedCount > 0) {
      ctx.log?.(`Excluded ${excludedCount} principal(s) from becoming manager nodes via excludeNamePatterns.`);
    }
    // An override target must exist as a manager node even if no one reports to
    // them in the source data, so a moved member has a team to land in.
    for (const target of overrides.values()) {
      if (target && byId.has(target)) managerIds.add(target);
    }

    // Build a node name from the resolved fields (+ optional manager name).
    const nameFor = (mgr) => {
      const mgrName = mgr?.displayName || 'Unknown';
      const parts = resolved
        .map(r => (mgr?.[r.name] == null ? '' : String(mgr[r.name]).trim()))
        .filter(Boolean)
        // Collapse consecutive duplicate segments — org levels frequently repeat
        // the same name (e.g. "Commercie · Commercie"); keep just one.
        .filter((p, i, arr) => i === 0 || p.toLowerCase() !== arr[i - 1].toLowerCase());
      const label = parts.join(separator);
      if (label && includeManagerName) return `${label} (${mgrName})`;
      if (label) return label;
      return mgrName; // no attribute values → fall back to the person's name
    };

    const contexts = [];
    const members  = [];

    // Synthetic root. externalId = 'root'. Everything ends up under this so
    // analysts see a single tree rather than a forest of roots-with-no-manager.
    const rootExt = 'root';
    contexts.push({
      externalId: rootExt,
      displayName: rootName,
      contextType: 'ManagerHierarchy',
      description: `Manager hierarchy for system ${scopeSystemId}, generated by manager-hierarchy plugin. Named by: ${nameFieldLabels.join(', ') || 'manager name'}.`,
    });

    // One context per manager. parentExternalId = the manager's own managerId
    // (if that person is also a non-excluded manager); otherwise root.
    for (const managerId of managerIds) {
      const mgr = byId.get(managerId);
      const parentManagerId = mgr?.managerId && managerIds.has(mgr.managerId) ? mgr.managerId : null;
      contexts.push({
        externalId: managerId,
        displayName: nameFor(mgr),
        contextType: 'ManagerHierarchy',
        parentExternalId: parentManagerId || rootExt,
      });
    }

    // Members: every principal with a managerId becomes a member of that
    // manager's context. If the manager was excluded or is not in the dataset,
    // the principal goes to root instead — visible as "no real manager in this
    // system" rather than hidden.
    for (const p of rows) {
      const em = effMgrId(p); // analyst override takes precedence over source managerId
      if (em && managerIds.has(em)) {
        members.push({ contextExternalId: em, memberId: p.id });
      } else if (!managerIds.has(p.id)) {
        members.push({ contextExternalId: rootExt, memberId: p.id });
      }
      // else: p is a top-level manager (no manager, but has reports).
    }

    ctx.log?.(`Built ${contexts.length} contexts, ${members.length} member rows. Named by [${nameFieldLabels.join(', ') || 'manager name'}].`);
    return { contexts, members };
  },
};
