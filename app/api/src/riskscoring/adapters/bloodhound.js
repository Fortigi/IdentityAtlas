// Identity Atlas v5 — BloodHound CE adapter.
//
// Two modes:
//   "export"   — push Identity Atlas data (principals, resources, memberships)
//                to BloodHound via its file-upload API, then query for scores.
//   "existing" — query an already-populated BloodHound instance (customer runs
//                SharpHound themselves).
//
// BloodHound CE v5+ exposes a REST API on port 8080. Authentication is via
// Bearer token (API key generated from the BH admin UI).
//
// Entity mapping: Identity Atlas uses Entra object UUIDs as entity IDs.
// BloodHound uses the same UUIDs as ObjectIdentifier for Entra/AzureAD objects,
// so the mapping is 1:1 for cloud-only environments.

import * as db from '../../db/connection.js';

const DEFAULT_TIMEOUT_MS = 30_000;

// BloodHound tier → normalised 0-100 score
const DEFAULT_TIER_MAP = {
  tierZero:  95,
  highValue: 75,
  medium:    50,
  low:       25,
};

// ─── Health check ────────────────────────────────────────────────────

export async function checkHealth(plugin) {
  const url = `${plugin.endpointUrl}/api/v2/self`;
  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(plugin),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

// ─── Data export (Identity Atlas → BloodHound) ───────────────────────

export async function exportData(plugin) {
  const config = plugin.config || {};
  const tenantId = config.tenantId || 'default';

  // 1. Build BloodHound-compatible JSON from Identity Atlas data
  const bhData = await buildBloodHoundData(tenantId);

  // 2. Upload via BH file-upload API
  const uploadUrl = `${plugin.endpointUrl}/api/v2/file-upload/start`;
  const startRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { ...authHeaders(plugin), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: `identity-atlas-export-${Date.now()}.json` }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!startRes.ok) {
    throw new Error(`BH upload start failed: HTTP ${startRes.status}`);
  }
  const { data: startData } = await startRes.json();
  const taskId = startData?.id;

  // 3. Upload the data chunk
  const chunkUrl = `${plugin.endpointUrl}/api/v2/file-upload/${taskId}`;
  const chunkRes = await fetch(chunkUrl, {
    method: 'POST',
    headers: { ...authHeaders(plugin), 'Content-Type': 'application/json' },
    body: JSON.stringify(bhData),
    signal: AbortSignal.timeout(60_000),
  });
  if (!chunkRes.ok) {
    throw new Error(`BH upload chunk failed: HTTP ${chunkRes.status}`);
  }

  // 4. Signal upload complete
  const endUrl = `${plugin.endpointUrl}/api/v2/file-upload/${taskId}/end`;
  await fetch(endUrl, {
    method: 'POST',
    headers: authHeaders(plugin),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  return {
    taskId,
    users: bhData.data.filter(d => d.kind === 'User').length,
    groups: bhData.data.filter(d => d.kind === 'Group').length,
    relationships: bhData.data.filter(d => d.kind === 'Relationship').length,
  };
}

// ─── Score retrieval (BloodHound → Identity Atlas) ───────────────────

export async function fetchScores(plugin, entities) {
  const config = plugin.config || {};
  const tierMap = { ...DEFAULT_TIER_MAP, ...config.tierScoreMap };
  const scores = [];

  // Query BH's asset-group / domain-info endpoints for entity tiers.
  // BH CE v5 allows Cypher queries via POST /api/v2/graphs/cypher.
  // We batch entities to avoid per-entity API calls.
  const principalIds = entities
    .filter(e => e.type === 'Principal')
    .map(e => e.id);
  const resourceIds = entities
    .filter(e => e.type === 'Resource')
    .map(e => e.id);

  // Fetch user attack path data
  if (principalIds.length > 0) {
    const userScores = await queryBloodHoundScores(
      plugin, principalIds, 'User', tierMap
    );
    scores.push(...userScores);
  }

  // Fetch group attack path data
  if (resourceIds.length > 0) {
    const groupScores = await queryBloodHoundScores(
      plugin, resourceIds, 'Group', tierMap
    );
    // Map back to Identity Atlas entity type
    for (const s of groupScores) s.entityType = 'Resource';
    scores.push(...groupScores);
  }

  return scores;
}

// ─── Internal helpers ────────────────────────────────────────────────

function authHeaders(plugin) {
  const headers = { Accept: 'application/json' };
  if (plugin.apiKey) {
    headers.Authorization = `Bearer ${plugin.apiKey}`;
  }
  return headers;
}

async function buildBloodHoundData(tenantId) {
  // Load principals (users)
  const principals = await db.query(
    `SELECT id, "displayName", email, "principalType", "accountEnabled",
            "externalId", "extendedAttributes"
       FROM "Principals"
      WHERE "principalType" IN ('User', 'ExternalUser')
      ORDER BY id`
  );

  // Load resources (groups, directory roles)
  const resources = await db.query(
    `SELECT id, "displayName", description, "resourceType", mail,
            "externalId", "extendedAttributes"
       FROM "Resources"
      WHERE "resourceType" IN ('SecurityGroup', 'DistributionGroup', 'DirectoryRole',
                                'AppRole', 'Microsoft365Group')
      ORDER BY id`
  );

  // Load memberships
  const assignments = await db.query(
    `SELECT "resourceId", "principalId", "assignmentType"
       FROM "ResourceAssignments"
      WHERE "assignmentType" IN ('Direct', 'Owner')
      ORDER BY "resourceId", "principalId"`
  );

  const data = [];

  // Users
  for (const p of principals.rows) {
    data.push({
      kind: 'User',
      data: {
        ObjectIdentifier: p.id,
        Properties: {
          name: p.displayName,
          displayname: p.displayName,
          email: p.email,
          enabled: p.accountEnabled !== false,
          tenantid: tenantId,
          // Map to BH user types
          ...(p.principalType === 'ExternalUser' ? { usertype: 'Guest' } : {}),
        },
      },
    });
  }

  // Groups
  for (const r of resources.rows) {
    const kind = r.resourceType === 'DirectoryRole' ? 'Role'
               : r.resourceType === 'AppRole' ? 'Role'
               : 'Group';
    data.push({
      kind,
      data: {
        ObjectIdentifier: r.id,
        Properties: {
          name: r.displayName,
          displayname: r.displayName,
          description: r.description,
          tenantid: tenantId,
        },
      },
    });
  }

  // Relationships (memberships)
  for (const a of assignments.rows) {
    data.push({
      kind: 'Relationship',
      data: {
        Source: a.principalId,
        Target: a.resourceId,
        RelProps: {},
        RelType: a.assignmentType === 'Owner' ? 'Owns' : 'MemberOf',
      },
    });
  }

  return {
    meta: {
      type: 'azure',
      version: 5,
      count: data.length,
    },
    data,
  };
}

async function queryBloodHoundScores(plugin, entityIds, bhNodeKind, tierMap) {
  const scores = [];

  // Use BH's Cypher endpoint to get tier-zero / high-value flags and attack path
  // counts in a single query. BH CE v5 supports POST /api/v2/graphs/cypher.
  // We batch into chunks of 500 to avoid payload limits.
  const BATCH = 500;
  for (let i = 0; i < entityIds.length; i += BATCH) {
    const batch = entityIds.slice(i, i + BATCH);
    try {
      const cypherQuery = `
        MATCH (n) WHERE n.objectid IN $ids
        OPTIONAL MATCH path = shortestPath((n)-[*1..]->(t:Base))
        WHERE t.system_tags = 'admin_tier_0'
        RETURN n.objectid AS objectId,
               n.system_tags AS tags,
               count(DISTINCT path) AS attackPathCount,
               min(length(path)) AS shortestPathLength
      `;

      const res = await fetch(`${plugin.endpointUrl}/api/v2/graphs/cypher`, {
        method: 'POST',
        headers: { ...authHeaders(plugin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: cypherQuery, parameters: { ids: batch } }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (!res.ok) {
        console.warn(`BH Cypher query failed: HTTP ${res.status}`);
        continue;
      }

      const result = await res.json();
      const rows = result.data?.rows || result.data || [];

      for (const row of rows) {
        const objectId = row.objectId || row[0];
        const tags = row.tags || row[1] || '';
        const pathCount = row.attackPathCount ?? row[2] ?? 0;
        const shortestPath = row.shortestPathLength ?? row[3] ?? null;

        // Determine tier from BH tags
        let score = 0;
        let tier = 'none';
        if (tags.includes('admin_tier_0')) {
          score = tierMap.tierZero;
          tier = 'tierZero';
        } else if (pathCount > 0 && shortestPath !== null) {
          // Score based on attack path proximity
          if (shortestPath <= 2) {
            score = tierMap.highValue;
            tier = 'highValue';
          } else if (shortestPath <= 5) {
            score = tierMap.medium;
            tier = 'medium';
          } else {
            score = tierMap.low;
            tier = 'low';
          }
          // Boost for many attack paths (up to +15)
          score = Math.min(100, score + Math.min(15, Math.floor(pathCount / 3)));
        }

        if (score > 0) {
          scores.push({
            entityId: objectId,
            entityType: bhNodeKind === 'User' ? 'Principal' : 'Resource',
            score,
            rawScore: score,
            explanation: {
              tier,
              attackPathCount: pathCount,
              shortestPathLength: shortestPath,
              source: 'BloodHound CE',
            },
          });
        }
      }
    } catch (err) {
      console.warn(`BH score query batch failed:`, err.message);
    }
  }

  return scores;
}
