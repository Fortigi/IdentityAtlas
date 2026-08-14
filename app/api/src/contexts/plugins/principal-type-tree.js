// principal-type-tree plugin.
//
// The principal-side mirror of resource-type-tree: groups a system's principals by an attribute
// (default: principalType) into a two-level tree — a synthetic root with one child context per
// distinct value, each holding the matching principals as members. Answers "what can all managed
// identities / all AI agents / all service principals access?" by giving you a Principal context
// to filter the matrix by.
//
// Generic: the grouping attribute is config. `principalType` is a real column (the Entra crawler
// already classifies service principals into ManagedIdentity / AIAgent / ServicePrincipal), but
// any extendedAttributes key works too — the lookup falls back from real column to JSON.

import * as db from '../../db/connection.js';

// Normalise the plugin's raw parameters into typed, defaulted values.
export function parseParams(params) {
  const attribute = (typeof params.attribute === 'string' && params.attribute.trim()) ? params.attribute.trim() : 'principalType';
  const rootName = (params.rootName || 'Principal Types').slice(0, 500);
  const systemId = Number.isFinite(parseInt(params.systemId, 10)) ? parseInt(params.systemId, 10) : null;
  const rawValues = Array.isArray(params.values) ? params.values : [];
  const allow = new Set(rawValues.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()));
  return { attribute, rootName, systemId, allow };
}

// Fold the attribute rows into the two-level tree (synthetic root + one child per distinct value).
// Returns the built contexts/members plus the count of distinct types for logging.
export function buildTree(rows, rootName, allow) {
  const rootExt = 'ptype-root';
  const contexts = [{ externalId: rootExt, displayName: rootName, contextType: 'PrincipalTypeRoot' }];
  const members = [];
  const seen = new Map(); // value → externalId
  for (const r of rows) {
    const val = (r.val || '').trim();
    if (!val) continue;
    if (allow.size > 0 && !allow.has(val)) continue;
    if (!seen.has(val)) {
      const ext = `ptype:${val}`;
      seen.set(val, ext);
      contexts.push({ externalId: ext, displayName: val, contextType: 'PrincipalType', parentExternalId: rootExt });
    }
    members.push({ contextExternalId: seen.get(val), memberId: r.id });
  }
  return { contexts, members, typeCount: seen.size };
}

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'principal-type-tree',
  displayName: 'Principal Type Tree',
  description:
    'Groups principals by an attribute (default: principalType) into a root with one child context ' +
    'per distinct value, each holding the matching principals as members. Lets you ask "what can ' +
    'all managed identities / AI agents / service principals access?". Optionally restrict to chosen ' +
    'values (e.g. ManagedIdentity) and/or a single system.',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    properties: {
      attribute: { type: 'string', default: 'principalType', description: 'Column or extendedAttributes key to group principals by.' },
      rootName: { type: 'string', default: 'Principal Types', description: 'Display name of the synthetic root node.' },
      systemId: { type: 'integer', description: 'Optional Systems.id — restrict to one system. Omit to group principals across all systems.' },
      values: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Optional allow-list of attribute values to build contexts for (e.g. ["ManagedIdentity","AIAgent"]). Empty = every distinct value (note: grouping by principalType then includes a large "User" bucket).',
      },
    },
  },
  async run(params, ctx) {
    const { attribute, rootName, systemId, allow } = parseParams(params);

    // The attribute is bound as a parameter (->> $1), never interpolated. Validate as defence-in-depth.
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(attribute)) {
      throw new Error('attribute must be a simple key (letters, digits, _ . -)');
    }

    // Resolve the attribute from a real column first (e.g. principalType), then extendedAttributes.
    const conds = [`COALESCE(to_jsonb(p.*) ->> $1, p."extendedAttributes" ->> $1) IS NOT NULL`];
    const qp = [attribute];
    if (systemId !== null) { qp.push(systemId); conds.push(`p."systemId" = $${qp.length}`); }

    const rows = (await db.query(
      `SELECT p.id::text AS id, COALESCE(to_jsonb(p.*) ->> $1, p."extendedAttributes" ->> $1) AS val
         FROM "Principals" p WHERE ${conds.join(' AND ')}`,
      qp,
    )).rows;
    if (rows.length === 0) {
      ctx.log?.(`No principals carry attribute "${attribute}"${systemId !== null ? ` in system ${systemId}` : ''}.`);
      return { contexts: [], members: [] };
    }

    const { contexts, members, typeCount } = buildTree(rows, rootName, allow);

    ctx.log?.(`Grouped ${members.length} principals into ${typeCount} type(s) by "${attribute}".`);
    return { contexts, members };
  },
};
