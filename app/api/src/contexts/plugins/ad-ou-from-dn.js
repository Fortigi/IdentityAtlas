// ad-ou-from-dn plugin.
//
// Parses an LDAP DN (e.g. "CN=Alice,OU=Finance,OU=HQ,DC=example,DC=com")
// into a nested OU tree:
//   HQ → Finance → Alice
//
// DC components are dropped; OU components (outer-to-inner) form the tree.
// Different identity sources expose the DN in different places, so the
// plugin takes a `dnField` parameter that names the source. The default is
// the Entra ID / Microsoft Graph convention:
//   extendedAttributes.onPremisesDistinguishedName
// but a direct column (e.g. "distinguishedName") works too — just set
// dnField to the column name and omit the dotted-path prefix.

import * as db from '../../db/connection.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'ad-ou-from-dn',
  displayName: 'Active Directory OU Tree',
  description: 'Parses an LDAP distinguished name from Principals into a nested OU hierarchy. DC components are ignored; OU components (outer-to-inner) form the tree. Defaults to extendedAttributes.onPremisesDistinguishedName (Entra crawler convention).',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: { type: 'integer', description: 'Systems.id — which system\'s principals to walk.' },
      rootName:      { type: 'string',  default: 'Organisational Units', description: 'Display name of the synthetic root node.' },
      dnField:       { type: 'string',  default: 'extendedAttributes.onPremisesDistinguishedName', description: 'Where to read the DN. A bare column name, or "extendedAttributes.<jsonKey>" for a JSONB path.' },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = parseInt(params.scopeSystemId, 10);
    if (!Number.isFinite(scopeSystemId)) throw new Error('scopeSystemId is required and must be an integer');
    const rootName = (params.rootName || 'Organisational Units').slice(0, 500);
    const dnField  = params.dnField || 'extendedAttributes.onPremisesDistinguishedName';

    // Resolve the SQL expression for the DN. Whitelist the shape so the
    // user-supplied string can't become a SQL-injection vector.
    const dnExpr = resolveDnExpression(dnField);

    const rows = (await db.query(`
      SELECT id, "displayName", ${dnExpr} AS "dn"
        FROM "Principals"
       WHERE "systemId" = $1
         AND ${dnExpr} IS NOT NULL
         AND ${dnExpr} <> ''
    `, [scopeSystemId])).rows;

    if (rows.length === 0) {
      ctx.log?.(`No principals with DN (${dnField}) set in system ${scopeSystemId}.`);
      return { contexts: [], members: [] };
    }

    const rootExt = 'root';
    /** @type {Map<string, {externalId: string, displayName: string, parentExternalId: string|null}>} */
    const nodeByPath = new Map();
    nodeByPath.set(rootExt, { externalId: rootExt, displayName: rootName, parentExternalId: null });

    const members = [];
    for (const p of rows) {
      const ous = parseOuChain(p.dn);
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

// Whitelisted SQL-expression resolver for the DN field.
// Accepts: "<columnName>" OR "extendedAttributes.<jsonKey>". Any other shape
// is rejected; the identifier portion is constrained to [A-Za-z0-9_] so the
// returned expression is safe to interpolate.
function resolveDnExpression(spec) {
  const IDENT = /^[A-Za-z0-9_]+$/;
  const s = String(spec || '').trim();
  const jsonMatch = /^extendedAttributes\.(.+)$/.exec(s);
  if (jsonMatch) {
    const key = jsonMatch[1];
    if (!IDENT.test(key)) throw new Error(`Invalid JSON key in dnField: ${key}`);
    return `"extendedAttributes"->>'${key}'`;
  }
  if (IDENT.test(s)) return `"${s}"`;
  throw new Error(`dnField must be a column name or "extendedAttributes.<jsonKey>" — got ${JSON.stringify(spec)}`);
}

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
export const _internal = { parseOuChain, resolveDnExpression };
