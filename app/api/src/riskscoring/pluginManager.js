// Identity Atlas v5 — Risk scoring plugin manager.
//
// Follows the same pattern as llm/service.js: config persistence in a SQL table,
// API keys in the Secrets vault, adapter dispatch via a switch on pluginType.
//
// Plugins contribute scores to the scoring engine as a 5th weighted component
// ("external"). When no plugins are enabled the engine behaves identically to v4.

import * as db from '../db/connection.js';
import { putSecret, getSecret, hasSecret, deleteSecret } from '../secrets/vault.js';
import * as bloodhoundAdapter from './adapters/bloodhound.js';
import * as httpApiAdapter from './adapters/httpApi.js';

const SECRET_SCOPE = 'plugin';

function secretId(pluginId) {
  return `plugin.${pluginId}`;
}

// ─── CRUD ────────────────────────────────────────────────────────────

export async function listPlugins() {
  const r = await db.query(
    `SELECT id, "pluginType", "displayName", description, "endpointUrl",
            config, "defaultWeight", enabled, "healthStatus",
            "lastHealthCheck", "lastSyncAt", "createdAt", "updatedAt"
       FROM "RiskPlugins"
      ORDER BY "createdAt" DESC`
  );
  return r.rows;
}

export async function getPlugin(id) {
  return db.queryOne(
    `SELECT * FROM "RiskPlugins" WHERE id = $1`, [id]
  );
}

export async function savePlugin({ id, pluginType, displayName, description, endpointUrl, apiKey, config, defaultWeight }) {
  if (id) {
    // Update existing
    await db.query(
      `UPDATE "RiskPlugins"
          SET "pluginType"  = COALESCE($2, "pluginType"),
              "displayName" = COALESCE($3, "displayName"),
              "description" = COALESCE($4, description),
              "endpointUrl" = COALESCE($5, "endpointUrl"),
              "config"      = COALESCE($6::jsonb, config),
              "defaultWeight" = COALESCE($7, "defaultWeight"),
              "updatedAt"   = now()
        WHERE id = $1`,
      [id, pluginType, displayName, description, endpointUrl,
       config ? JSON.stringify(config) : null, defaultWeight]
    );
    if (apiKey) {
      await putSecret(secretId(id), SECRET_SCOPE, apiKey, `${pluginType} plugin API key`);
    }
    return getPlugin(id);
  }

  // Insert new
  const r = await db.queryOne(
    `INSERT INTO "RiskPlugins" ("pluginType", "displayName", description, "endpointUrl", config, "defaultWeight")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING *`,
    [pluginType, displayName, description || null, endpointUrl || null,
     JSON.stringify(config || {}), defaultWeight ?? 0.15]
  );
  if (apiKey) {
    await putSecret(secretId(r.id), SECRET_SCOPE, apiKey, `${pluginType} plugin API key`);
    // Store the secretId reference
    await db.query(
      `UPDATE "RiskPlugins" SET "secretId" = $1 WHERE id = $2`,
      [secretId(r.id), r.id]
    );
  }
  return getPlugin(r.id);
}

export async function deletePlugin(id) {
  await db.query(`DELETE FROM "RiskPlugins" WHERE id = $1`, [id]);
  try { await deleteSecret(secretId(id)); } catch { /* may not exist */ }
}

export async function togglePlugin(id, enabled) {
  await db.query(
    `UPDATE "RiskPlugins" SET enabled = $1, "updatedAt" = now() WHERE id = $2`,
    [enabled, id]
  );
  return getPlugin(id);
}

// ─── Health check ────────────────────────────────────────────────────

export async function checkHealth(id) {
  const plugin = await getPlugin(id);
  if (!plugin) throw new Error('Plugin not found');

  let status = 'unhealthy';
  try {
    const adapter = getAdapter(plugin.pluginType);
    status = await adapter.checkHealth(plugin) ? 'healthy' : 'unhealthy';
  } catch {
    status = 'unhealthy';
  }

  await db.query(
    `UPDATE "RiskPlugins"
        SET "healthStatus" = $1, "lastHealthCheck" = now(), "updatedAt" = now()
      WHERE id = $2`,
    [status, id]
  );
  return { id, healthStatus: status };
}

// ──��� Data export (BloodHound) ────────────────────────────────────────

export async function exportData(id) {
  const plugin = await getPlugin(id);
  if (!plugin) throw new Error('Plugin not found');

  const adapter = getAdapter(plugin.pluginType);
  if (!adapter.exportData) throw new Error(`Plugin type '${plugin.pluginType}' does not support data export`);

  const apiKey = plugin.secretId ? await getSecret(secretId(id)) : null;
  const result = await adapter.exportData({ ...plugin, apiKey });

  await db.query(
    `UPDATE "RiskPlugins" SET "lastSyncAt" = now(), "updatedAt" = now() WHERE id = $1`,
    [id]
  );
  return result;
}

// ─── Score fetching (called by the engine) ───────────────────────────

export async function getEnabledPlugins() {
  const r = await db.query(
    `SELECT * FROM "RiskPlugins" WHERE enabled = true ORDER BY id`
  );
  return r.rows;
}

export async function computeExternalWeight() {
  const plugins = await getEnabledPlugins();
  if (plugins.length === 0) return 0;
  // Sum of all enabled plugin weights, capped at 0.40 to keep the original
  // layers meaningful.
  const total = plugins.reduce((sum, p) => sum + Number(p.defaultWeight || 0.15), 0);
  return Math.min(total, 0.40);
}

/**
 * Fetch scores from all enabled plugins for the given entities.
 * Returns a Map: `entityKey ("entityId:entityType")` -> `{ score, reasons }`.
 * Each plugin is called in parallel; failures are non-fatal.
 */
export async function fetchAllPluginScores(entities) {
  const plugins = await getEnabledPlugins();
  if (plugins.length === 0) return new Map();

  const results = await Promise.allSettled(
    plugins.map(async (plugin) => {
      const apiKey = plugin.secretId ? await getSecret(secretId(plugin.id)) : null;
      const adapter = getAdapter(plugin.pluginType);
      const scores = await adapter.fetchScores({ ...plugin, apiKey }, entities);
      return { plugin, scores };
    })
  );

  // Aggregate: for each entity, take the max score across all plugins
  const merged = new Map();
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('Plugin score fetch failed:', result.reason?.message || result.reason);
      continue;
    }
    const { plugin, scores } = result.value;
    for (const s of scores) {
      const key = `${s.entityId}:${s.entityType}`;
      const existing = merged.get(key);
      if (!existing || s.score > existing.score) {
        merged.set(key, {
          score: s.score,
          reasons: [`${plugin.displayName}: ${s.explanation || 'score ' + s.score}`],
        });
      } else if (s.score === existing.score) {
        existing.reasons.push(`${plugin.displayName}: ${s.explanation || 'score ' + s.score}`);
      }
    }
  }

  return merged;
}

/**
 * Persist raw plugin scores into RiskPluginScores for attribution.
 */
export async function bulkUpsertPluginScores(pluginId, scores) {
  if (!scores || scores.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < scores.length; i += CHUNK) {
    const chunk = scores.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let pi = 1;
    for (const s of chunk) {
      values.push(`($${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, now())`);
      params.push(pluginId, s.entityId, s.entityType, s.score, s.rawScore ?? null,
                  s.explanation ? JSON.stringify(s.explanation) : null);
    }
    await db.query(
      `INSERT INTO "RiskPluginScores" ("pluginId", "entityId", "entityType", "score", "rawScore", "explanation", "scoredAt")
       VALUES ${values.join(',')}
       ON CONFLICT ("pluginId", "entityId", "entityType") DO UPDATE SET
         score = EXCLUDED.score,
         "rawScore" = EXCLUDED."rawScore",
         explanation = EXCLUDED.explanation,
         "scoredAt" = now()`,
      params
    );
  }
}

// ─── Adapter dispatch ────────────────────────────────────────────────

function getAdapter(pluginType) {
  switch (pluginType) {
    case 'bloodhound-ce': return bloodhoundAdapter;
    case 'http-api':      return httpApiAdapter;
    default: throw new Error(`Unknown plugin type: ${pluginType}`);
  }
}
