// ad-ou-from-dn plugin.
//
// Parses `Principals.distinguishedName` (LDAP DN format, e.g.
// "CN=Alice,OU=Finance,OU=HQ,DC=example,DC=com") into a nested OU tree:
//   HQ → Finance → Alice
//
// The DC=... components are dropped (they describe the domain, not the OU
// hierarchy). If a principal has no DN the row is skipped silently.

import * as db from '../../db/connection.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'ad-ou-from-dn',
  displayName: 'Active Directory OU Tree',
  description: 'Parses Principals.distinguishedName into a nested OU hierarchy. DC components are ignored; OU components (outer-to-inner) form the tree.',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: { type: 'integer', description: 'Systems.id — which system\'s principals to walk.' },
      rootName:      { type: 'string',  default: 'Organisational Units', description: 'Display name of the synthetic root node.' },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = parseInt(params.scopeSystemId, 10);
    if (!Number.isFinite(scopeSystemId)) throw new Error('scopeSystemId is required and must be an integer');
    const rootName = (params.rootName || 'Organisational Units').slice(0, 500);

    const rows = (await db.query(`
      SELECT id, "displayName", "distinguishedName"
        FROM "Principals"
       WHERE "systemId" = $1
         AND "distinguishedName" IS NOT NULL AND "distinguishedName" <> ''
    `, [scopeSystemId])).rows;

    if (rows.length === 0) {
      ctx.log?.(`No principals with distinguishedName set in system ${scopeSystemId}.`);
      return { contexts: [], members: [] };
    }

    const rootExt = 'root';
    /** @type {Map<string, {externalId: string, displayName: string, parentExternalId: string|null}>} */
    const nodeByPath = new Map();
    nodeByPath.set(rootExt, { externalId: rootExt, displayName: rootName, parentExternalId: null });

    const members = [];
    for (const p of rows) {
      const ous = parseOuChain(p.distinguishedName);
      if (ous.length === 0) continue;

      // DN lists innermost OU first — reverse to outer-to-inner for tree construction.
      const chain = ous.slice().reverse();
      let parentPath = rootExt;
      let currentPath = '';
      for (let i = 0; i < chain.length; i++) {
        currentPath = i === 0 ? chain[0] : `${currentPath}/${chain[i]}`;
        if (!nodeByPath.has(currentPath)) {
          nodeByPath.set(currentPath, {
            externalId: currentPath,
            displayName: chain[i],
            parentExternalId: parentPath,
          });
        }
        parentPath = currentPath;
      }
      members.push({ contextExternalId: currentPath, memberId: p.id });
    }

    const contexts = [...nodeByPath.values()].map(n => ({
      externalId: n.externalId,
      displayName: n.displayName,
      contextType: 'OrganisationalUnit',
      parentExternalId: n.parentExternalId,
    }));

    ctx.log?.(`Built ${contexts.length} OU contexts, ${members.length} member rows from ${rows.length} principals.`);
    return { contexts, members };
  },
};

// Pulls the OU components out of an LDAP DN, preserving order (innermost first).
// Handles escaped commas (\,) by replacing them with a sentinel before the split.
function parseOuChain(dn) {
  if (!dn) return [];
  const SENTINEL = '\u0001';
  const protected_ = dn.replace(/\\,/g, SENTINEL);
  const parts = protected_.split(/,/).map(s => s.trim());
  const ous = [];
  for (const part of parts) {
    const match = /^OU\s*=\s*(.*)$/i.exec(part);
    if (match) ous.push(match[1].replace(new RegExp(SENTINEL, 'g'), ','));
  }
  return ous;
}

// Exported for tests.
export const _internal = { parseOuChain };
