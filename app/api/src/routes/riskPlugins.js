// Identity Atlas v5 — Risk scoring plugin management routes.
//
// CRUD for external risk scoring plugins (BloodHound CE, custom HTTP APIs).
// Follows the same patterns as riskProfiles.js and llm.js.

import { Router } from 'express';
import http from 'http';
import * as pm from '../riskscoring/pluginManager.js';

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

const router = Router();

// ─── List all plugins ────────────────────────────────────────────────
router.get('/risk-plugins', async (req, res) => {
  try {
    const plugins = await pm.listPlugins();
    res.json({ data: plugins, total: plugins.length });
  } catch (err) {
    console.error('List plugins failed:', err.message);
    res.status(500).json({ error: 'Failed to list plugins' });
  }
});

// ─── Get single plugin ──────────────────────────────────────────────
router.get('/risk-plugins/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const plugin = await pm.getPlugin(id);
    if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
    res.json(plugin);
  } catch (err) {
    console.error('Get plugin failed:', err.message);
    res.status(500).json({ error: 'Failed to get plugin' });
  }
});

// ─── Register new plugin ────────────────────────────────────────────
router.post('/risk-plugins', async (req, res) => {
  const { pluginType, displayName, description, endpointUrl, apiKey, config, defaultWeight } = req.body;
  if (!pluginType || !displayName) {
    return res.status(400).json({ error: 'pluginType and displayName are required' });
  }
  const validTypes = ['bloodhound-ce', 'http-api'];
  if (!validTypes.includes(pluginType)) {
    return res.status(400).json({ error: `pluginType must be one of: ${validTypes.join(', ')}` });
  }
  if (defaultWeight !== undefined && (defaultWeight < 0.01 || defaultWeight > 0.40)) {
    return res.status(400).json({ error: 'defaultWeight must be between 0.01 and 0.40' });
  }
  try {
    const plugin = await pm.savePlugin({
      pluginType, displayName, description, endpointUrl, apiKey, config, defaultWeight,
    });
    res.status(201).json(plugin);
  } catch (err) {
    console.error('Create plugin failed:', err.message);
    res.status(500).json({ error: 'Failed to create plugin' });
  }
});

// ─── Update plugin ──────────────────────────────────────────────────
router.put('/risk-plugins/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const { pluginType, displayName, description, endpointUrl, apiKey, config, defaultWeight } = req.body;
  if (defaultWeight !== undefined && (defaultWeight < 0.01 || defaultWeight > 0.40)) {
    return res.status(400).json({ error: 'defaultWeight must be between 0.01 and 0.40' });
  }
  try {
    const plugin = await pm.savePlugin({
      id, pluginType, displayName, description, endpointUrl, apiKey, config, defaultWeight,
    });
    if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
    res.json(plugin);
  } catch (err) {
    console.error('Update plugin failed:', err.message);
    res.status(500).json({ error: 'Failed to update plugin' });
  }
});

// ─── Delete plugin ──────────────────────────────────────────────────
router.delete('/risk-plugins/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await pm.deletePlugin(id);
    res.json({ message: 'Plugin deleted' });
  } catch (err) {
    console.error('Delete plugin failed:', err.message);
    res.status(500).json({ error: 'Failed to delete plugin' });
  }
});

// ─── Toggle enable/disable ──────────────────────────────────────────
router.put('/risk-plugins/:id/toggle', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  try {
    const plugin = await pm.togglePlugin(id, enabled);
    if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
    res.json(plugin);
  } catch (err) {
    console.error('Toggle plugin failed:', err.message);
    res.status(500).json({ error: 'Failed to toggle plugin' });
  }
});

// ─── Health check ────────────────────────────────────────────────────
router.post('/risk-plugins/:id/health', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await pm.checkHealth(id);
    res.json(result);
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(500).json({ error: 'Health check failed', message: err.message });
  }
});

// ─── Data export (BloodHound) ────────────────────────────────────────
router.post('/risk-plugins/:id/export', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await pm.exportData(id);
    res.json({ message: 'Export completed', ...result });
  } catch (err) {
    console.error('Export failed:', err.message);
    res.status(500).json({ error: 'Export failed', message: err.message });
  }
});

// ─── View raw plugin scores ─────────────────────────────────────────
router.get('/risk-plugins/:id/scores', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  try {
    const r = await (await import('../db/connection.js')).query(
      `SELECT ps.*, p."displayName" AS "entityDisplayName"
         FROM "RiskPluginScores" ps
         LEFT JOIN "Principals" p ON ps."entityId" = p.id AND ps."entityType" = 'Principal'
        WHERE ps."pluginId" = $1
        ORDER BY ps.score DESC
        LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );
    const countR = await (await import('../db/connection.js')).queryOne(
      `SELECT count(*)::int AS total FROM "RiskPluginScores" WHERE "pluginId" = $1`,
      [id]
    );
    res.json({ data: r.rows, total: countR?.total || 0 });
  } catch (err) {
    console.error('Get plugin scores failed:', err.message);
    res.status(500).json({ error: 'Failed to get plugin scores' });
  }
});

// ─── BloodHound initial password (from Docker logs) ──────────────────
// Reads the BH container logs via the Docker socket to extract the initial
// admin password, so the setup wizard can show it inline without requiring
// the user to open a terminal.
router.get('/risk-plugins/bloodhound/initial-password', async (req, res) => {
  try {
    // Find the BloodHound container
    const containers = await dockerRequestJson('/containers/json?all=1');
    const bhContainer = containers.find(c =>
      (c.Names || []).some(n => /bloodhound-1/i.test(n) && !/db|graph/i.test(n))
    );
    if (!bhContainer) {
      return res.json({ found: false, reason: 'BloodHound container not found' });
    }

    // Fetch logs (stdout only, last 200 lines)
    const logs = await dockerRequestText(
      `/containers/${bhContainer.Id}/logs?stdout=true&stderr=false&tail=200`
    );

    // BH CE prints: # Initial Password Set To:    <password>    #
    const match = logs.match(/Initial Password Set To:\s+(\S+)/);
    if (match) {
      res.json({ found: true, password: match[1] });
    } else {
      res.json({ found: false, reason: 'Password not found in logs (may have been changed already)' });
    }
  } catch (err) {
    res.json({ found: false, reason: err.message });
  }
});

// ─── BloodHound auto-setup ────────────────────────────────────────────
// Logs in to BH with initial admin credentials, creates an API token,
// and returns it. This lets the wizard skip the BH UI entirely.
router.post('/risk-plugins/bloodhound/auto-setup', async (req, res) => {
  const { endpointUrl, username, password } = req.body;
  if (!endpointUrl) {
    return res.status(400).json({ error: 'endpointUrl is required' });
  }

  // Build list of passwords to try: user-supplied first, then auto-detected from logs
  const passwordsToTry = [];
  if (password) passwordsToTry.push(password);

  // Try to find initial password from Docker logs
  try {
    const containers = await dockerRequestJson('/containers/json?all=1');
    const bhContainer = containers.find(c =>
      (c.Names || []).some(n => /bloodhound-1/i.test(n) && !/db|graph/i.test(n))
    );
    if (bhContainer) {
      const logs = await dockerRequestText(`/containers/${bhContainer.Id}/logs?stdout=true&stderr=false&tail=500`);
      const match = logs.match(/Initial Password Set To:\s+(\S+)/);
      if (match && !passwordsToTry.includes(match[1])) {
        passwordsToTry.push(match[1]);
      }
    }
  } catch { /* Docker socket unavailable — skip */ }

  if (passwordsToTry.length === 0) {
    return res.status(400).json({ error: 'No password provided and could not auto-detect from container logs' });
  }

  // Try each password until one works
  let sessionToken = null;
  let userId = null;
  let usedPassword = null;

  for (const pw of passwordsToTry) {
    try {
      const loginRes = await fetch(`${endpointUrl}/api/v2/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login_method: 'secret', username: username || 'admin', secret: pw }),
        signal: AbortSignal.timeout(10_000),
      });
      if (loginRes.ok) {
        const loginData = await loginRes.json();
        sessionToken = loginData.data?.session_token;
        userId = loginData.data?.user_id;
        usedPassword = pw;
        break;
      }
    } catch { /* try next */ }
  }

  if (!sessionToken) {
    return res.status(401).json({
      error: 'BloodHound login failed',
      detail: 'Could not authenticate with any available credentials. Please enter the password manually.',
      needsPassword: true,
    });
  }

  try {
    // Create an API token using the session from the login loop above
    const tokenRes = await fetch(`${endpointUrl}/api/v2/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ user_id: userId, token_name: 'identity-atlas' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) {
      return res.status(500).json({ error: `Failed to create API token: HTTP ${tokenRes.status}` });
    }
    const tokenData = await tokenRes.json();
    const tokenId = tokenData.data?.id;
    const tokenKey = tokenData.data?.key;

    res.json({
      success: true,
      tokenId,
      tokenKey,
      userId,
      message: 'BloodHound API token created successfully',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function dockerRequestJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`Docker API ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('Docker API timeout')); });
    req.end();
  });
}

function dockerRequestText(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        // Docker log frames have an 8-byte header per frame; strip them for
        // plain text. Each frame: [stream_type(1) + 0(3) + size(4)] + payload.
        const raw = Buffer.concat(chunks);
        let text = '';
        let offset = 0;
        while (offset + 8 <= raw.length) {
          const frameSize = raw.readUInt32BE(offset + 4);
          if (offset + 8 + frameSize > raw.length) break;
          text += raw.slice(offset + 8, offset + 8 + frameSize).toString('utf8');
          offset += 8 + frameSize;
        }
        resolve(text || raw.toString('utf8'));
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('Docker API timeout')); });
    req.end();
  });
}

export default router;
