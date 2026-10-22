// Lookup source: the application permissions actually granted in this
// deployment, for the High-risk Application Permissions report's "also include"
// parameter.
//
// It offers what was collected rather than a catalogue of everything an API
// publishes: a permission nobody holds cannot produce a row, and a list of the
// few hundred that are held is one a reader can scan. The value is
// "<apiAppId>|<permission>" (see reports/appPermissionRisk.js), so picking
// `Mail.Read` on Microsoft Graph never also selects a same-named role on another
// API. A grant whose API cannot be identified is not offered — it could not be
// matched afterwards either.

import * as db from '../../db/connection.js';
import {
  API_APP_ID_SQL, GRANTS_FROM, GRANTS_WHERE,
  isStandardPermission, knownApiName, parsePermissionKey, permissionKey,
} from '../../reports/appPermissionRisk.js';

// `%` and `_` are ILIKE wildcards; a search for "Mail_" means "Mail_".
function escapeLike(text) {
  return text.replace(/[\\%_]/g, ch => `\\${ch}`);
}

// One (API, permission) group -> one option. The hint says which API, how many
// apps hold it, and whether the standard list already covers it — picking one
// of those adds nothing while the standard list is on.
function toOption(row) {
  const apps = Number(row.holders || 0);
  const parts = [
    knownApiName(row.apiAppId) || row.apiName || row.apiAppId,
    `${apps} ${apps === 1 ? 'app' : 'apps'}`,
  ];
  if (isStandardPermission(row.apiAppId, row.permission)) parts.push('on the standard list');
  return { value: permissionKey(row.apiAppId, row.permission), label: row.permission, hint: parts.join(' · ') };
}

const GROUPED = `
  SELECT g."apiAppId", g.permission, max(g."apiName") AS "apiName", count(DISTINCT g.holder)::int AS holders
    FROM (SELECT lower(${API_APP_ID_SQL}) AS "apiAppId",
                 ap."extendedAttributes"->>'permission' AS permission,
                 ap."extendedAttributes"->>'targetApiDisplayName' AS "apiName",
                 ra."principalId" AS holder
          ${GRANTS_FROM}
           WHERE ${GRANTS_WHERE}) g
   WHERE g."apiAppId" IS NOT NULL AND g.permission IS NOT NULL`;

export default {
  name: 'application-permissions',
  displayName: 'Granted application permissions',

  // Most widely held first, so an empty box shows what is common in this tenant.
  async search({ q = '', limit = 20 }) {
    const { rows } = await db.query(
      `${GROUPED}
         AND ($1 = '' OR g.permission ILIKE '%' || $1 || '%' ESCAPE '\\'
                      OR g."apiName" ILIKE '%' || $1 || '%' ESCAPE '\\')
       GROUP BY g."apiAppId", g.permission
       ORDER BY holders DESC, g.permission
       LIMIT $2`,
      [escapeLike(q), limit]);
    return rows.map(toOption);
  },

  // Stored keys back into labels. A key no longer held by anyone still reads as
  // its permission and API, so a saved view shows what it asks for.
  async resolve({ ids = [] }) {
    const keys = ids.map(parsePermissionKey).filter(Boolean);
    if (keys.length === 0) return [];
    const { rows } = await db.query(
      `${GROUPED}
         AND (g."apiAppId", g.permission) IN (SELECT * FROM unnest($1::text[], $2::text[]))
       GROUP BY g."apiAppId", g.permission`,
      [keys.map(k => k.apiAppId), keys.map(k => k.permission)]);
    const held = new Map(rows.map(r => [permissionKey(r.apiAppId, r.permission), r]));
    return keys.map(k => toOption(held.get(permissionKey(k.apiAppId, k.permission))
      ?? { apiAppId: k.apiAppId, permission: k.permission, holders: 0 }));
  },
};
