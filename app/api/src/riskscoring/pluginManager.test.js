// Tests for the risk scoring plugin manager.
//
// These test the pure logic and dispatch patterns. Database interactions are
// tested via the nightly integration suite and E2E tests. Here we mock the
// database and vault to validate:
//   - adapter dispatch (getAdapter)
//   - score aggregation across plugins
//   - weight computation
//   - graceful failure handling

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the database module before importing pluginManager
vi.mock('../db/connection.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  tx: vi.fn(),
}));

// Mock the secrets vault
vi.mock('../secrets/vault.js', () => ({
  putSecret: vi.fn(),
  getSecret: vi.fn(),
  hasSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

// Mock the adapters
vi.mock('./adapters/bloodhound.js', () => ({
  checkHealth: vi.fn(),
  fetchScores: vi.fn(),
  exportData: vi.fn(),
}));

vi.mock('./adapters/httpApi.js', () => ({
  checkHealth: vi.fn(),
  fetchScores: vi.fn(),
}));

const db = await import('../db/connection.js');
const vault = await import('../secrets/vault.js');
const bhAdapter = await import('./adapters/bloodhound.js');
const httpAdapter = await import('./adapters/httpApi.js');
const pm = await import('./pluginManager.js');

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── computeExternalWeight ───────────────────────────────────────────

describe('computeExternalWeight', () => {
  it('returns 0 when no plugins are enabled', async () => {
    db.query.mockResolvedValue({ rows: [] });
    expect(await pm.computeExternalWeight()).toBe(0);
  });

  it('returns the default weight for a single enabled plugin', async () => {
    db.query.mockResolvedValue({ rows: [{ defaultWeight: 0.15 }] });
    expect(await pm.computeExternalWeight()).toBe(0.15);
  });

  it('sums weights across multiple plugins', async () => {
    db.query.mockResolvedValue({ rows: [
      { defaultWeight: 0.15 },
      { defaultWeight: 0.10 },
    ] });
    expect(await pm.computeExternalWeight()).toBeCloseTo(0.25);
  });

  it('caps total external weight at 0.40', async () => {
    db.query.mockResolvedValue({ rows: [
      { defaultWeight: 0.25 },
      { defaultWeight: 0.25 },
    ] });
    expect(await pm.computeExternalWeight()).toBe(0.40);
  });
});

// ─── fetchAllPluginScores ────────────────────────────────────────────

describe('fetchAllPluginScores', () => {
  const entities = [
    { id: 'u1', type: 'Principal', displayName: 'Alice' },
    { id: 'r1', type: 'Resource', displayName: 'Domain Admins' },
  ];

  it('returns empty map when no plugins are enabled', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const result = await pm.fetchAllPluginScores(entities);
    expect(result.size).toBe(0);
  });

  it('dispatches to bloodhound adapter for bloodhound-ce plugins', async () => {
    db.query.mockResolvedValue({ rows: [{
      id: 1, pluginType: 'bloodhound-ce', displayName: 'BH',
      secretId: null, defaultWeight: 0.15, config: {},
    }] });
    bhAdapter.fetchScores.mockResolvedValue([
      { entityId: 'u1', entityType: 'Principal', score: 80, explanation: 'Tier Zero' },
    ]);

    const result = await pm.fetchAllPluginScores(entities);
    expect(bhAdapter.fetchScores).toHaveBeenCalled();
    expect(result.get('u1:Principal')).toBeDefined();
    expect(result.get('u1:Principal').score).toBe(80);
  });

  it('dispatches to http adapter for http-api plugins', async () => {
    db.query.mockResolvedValue({ rows: [{
      id: 2, pluginType: 'http-api', displayName: 'Custom',
      secretId: null, defaultWeight: 0.10, config: {},
    }] });
    httpAdapter.fetchScores.mockResolvedValue([
      { entityId: 'r1', entityType: 'Resource', score: 60, explanation: 'Custom risk' },
    ]);

    const result = await pm.fetchAllPluginScores(entities);
    expect(httpAdapter.fetchScores).toHaveBeenCalled();
    expect(result.get('r1:Resource').score).toBe(60);
  });

  it('takes max score when multiple plugins score the same entity', async () => {
    db.query.mockResolvedValue({ rows: [
      { id: 1, pluginType: 'bloodhound-ce', displayName: 'BH', secretId: null, defaultWeight: 0.15, config: {} },
      { id: 2, pluginType: 'http-api', displayName: 'Custom', secretId: null, defaultWeight: 0.10, config: {} },
    ] });
    bhAdapter.fetchScores.mockResolvedValue([
      { entityId: 'u1', entityType: 'Principal', score: 80, explanation: 'BH score' },
    ]);
    httpAdapter.fetchScores.mockResolvedValue([
      { entityId: 'u1', entityType: 'Principal', score: 50, explanation: 'Custom score' },
    ]);

    const result = await pm.fetchAllPluginScores(entities);
    // BH score (80) wins over Custom (50)
    expect(result.get('u1:Principal').score).toBe(80);
  });

  it('handles plugin failure gracefully (non-fatal)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.query.mockResolvedValue({ rows: [
      { id: 1, pluginType: 'bloodhound-ce', displayName: 'BH', secretId: null, defaultWeight: 0.15, config: {} },
      { id: 2, pluginType: 'http-api', displayName: 'Custom', secretId: null, defaultWeight: 0.10, config: {} },
    ] });
    bhAdapter.fetchScores.mockRejectedValue(new Error('Connection refused'));
    httpAdapter.fetchScores.mockResolvedValue([
      { entityId: 'u1', entityType: 'Principal', score: 60, explanation: 'Custom only' },
    ]);

    const result = await pm.fetchAllPluginScores(entities);
    // Should still have the HTTP plugin result despite BH failure
    expect(result.get('u1:Principal').score).toBe(60);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('loads API key from vault when secretId is set', async () => {
    db.query.mockResolvedValue({ rows: [{
      id: 3, pluginType: 'http-api', displayName: 'Secured',
      secretId: 'plugin.3', defaultWeight: 0.10, config: {},
    }] });
    vault.getSecret.mockResolvedValue('my-api-key-123');
    httpAdapter.fetchScores.mockResolvedValue([]);

    await pm.fetchAllPluginScores(entities);
    expect(vault.getSecret).toHaveBeenCalledWith('plugin.3');
    // Verify the adapter received the apiKey in the plugin object
    const pluginArg = httpAdapter.fetchScores.mock.calls[0][0];
    expect(pluginArg.apiKey).toBe('my-api-key-123');
  });
});
