// department-tree plugin.
//
// Reads `Principals.department` for one system, splits each department string
// on a configurable separator ('/' by default), and produces a nested tree of
// contexts where each level is one segment. Each leaf has as members the
// principals whose department string terminates at that level.
//
// Target type is Principal (see rationale in manager-hierarchy.js).

import * as db from '../../db/connection.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'department-tree',
  displayName: 'Department Tree',
  description: 'Parses Principals.department strings into a nested hierarchy using a configurable separator. Replaces the legacy /ingest/refresh-contexts endpoint.',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: { type: 'integer', description: 'Systems.id — which system\'s principals to walk.' },
      separator:     { type: 'string',  default: '/', description: 'Hierarchy separator within the department string. Empty string = flat list.' },
      rootName:      { type: 'string',  default: 'Departments', description: 'Display name of the synthetic root node.' },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = parseInt(params.scopeSystemId, 10);
    if (!Number.isFinite(scopeSystemId)) throw new Error('scopeSystemId is required and must be an integer');
    const separator = params.separator === '' ? '' : (params.separator || '/');
    const rootName  = (params.rootName || 'Departments').slice(0, 500);

    const rows = (await db.query(`
      SELECT id, "displayName", department
        FROM "Principals"
       WHERE "systemId" = $1
         AND department IS NOT NULL AND department <> ''
    `, [scopeSystemId])).rows;

    if (rows.length === 0) {
      ctx.log?.(`No principals with department set in system ${scopeSystemId} — nothing to do.`);
      return { contexts: [], members: [] };
    }

    const rootExt = 'root';
    /** @type {Map<string, {externalId: string, displayName: string, parentExternalId: string|null}>} */
    const nodeByPath = new Map();
    nodeByPath.set(rootExt, { externalId: rootExt, displayName: rootName, parentExternalId: null });

    const members = [];

    for (const p of rows) {
      const segments = separator
        ? p.department.split(separator).map(s => s.trim()).filter(Boolean)
        : [p.department.trim()];

      if (segments.length === 0) continue;

      let parentPath = rootExt;
      let currentPath = '';
      for (let i = 0; i < segments.length; i++) {
        currentPath = i === 0 ? segments[0] : `${currentPath}${separator || ' / '}${segments[i]}`;
        if (!nodeByPath.has(currentPath)) {
          nodeByPath.set(currentPath, {
            externalId: currentPath,
            displayName: segments[i],
            parentExternalId: parentPath,
          });
        }
        parentPath = currentPath;
      }
      // Members go on the leaf node (the full path).
      members.push({ contextExternalId: currentPath, memberId: p.id });
    }

    const contexts = [...nodeByPath.values()].map(n => ({
      externalId: n.externalId,
      displayName: n.displayName,
      contextType: 'Department',
      parentExternalId: n.parentExternalId,
    }));

    ctx.log?.(`Built ${contexts.length} department contexts, ${members.length} member rows.`);
    return { contexts, members };
  },
};
