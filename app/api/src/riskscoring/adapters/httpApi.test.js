// Tests for the generic HTTP API adapter.
//
// Validates: health check, score fetching, batching, error handling,
// score normalisation, and custom headers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkHealth, fetchScores } from './httpApi.js';

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const basePlugin = {
  endpointUrl: 'https://scoring.example.com',
  apiKey: 'test-key',
  config: {},
};

// ─── checkHealth ─────────────────────────────────────────────────────

describe('checkHealth', () => {
  it('returns true when endpoint responds 200', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await checkHealth(basePlugin)).toBe(true);
  });

  it('returns false when endpoint responds non-200', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    expect(await checkHealth(basePlugin)).toBe(false);
  });

  it('returns false when endpoint is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await checkHealth(basePlugin)).toBe(false);
  });
});

// ─── fetchScores ─────────────────────────────────────────────────────

describe('fetchScores', () => {
  const entities = [
    { id: 'u1', type: 'Principal', displayName: 'Alice' },
    { id: 'u2', type: 'Principal', displayName: 'Bob' },
    { id: 'r1', type: 'Resource', displayName: 'Domain Admins' },
  ];

  it('POSTs entities and returns normalised scores', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        scores: [
          { entityId: 'u1', entityType: 'Principal', score: 75, explanation: 'High risk user' },
          { entityId: 'r1', entityType: 'Resource', score: 90, explanation: 'Critical group' },
        ],
      }),
    });

    const scores = await fetchScores(basePlugin, entities);
    expect(scores).toHaveLength(2);
    expect(scores[0]).toMatchObject({ entityId: 'u1', score: 75 });
    expect(scores[1]).toMatchObject({ entityId: 'r1', score: 90 });
  });

  it('clamps scores to 0-100 range', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        scores: [
          { entityId: 'u1', entityType: 'Principal', score: 150 },
          { entityId: 'u2', entityType: 'Principal', score: -20 },
        ],
      }),
    });

    const scores = await fetchScores(basePlugin, entities);
    expect(scores[0].score).toBe(100);
    expect(scores[1].score).toBe(0);
  });

  it('filters out zero scores', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        scores: [
          { entityId: 'u1', entityType: 'Principal', score: 0 },
          { entityId: 'u2', entityType: 'Principal', score: 50 },
        ],
      }),
    });

    const scores = await fetchScores(basePlugin, entities);
    expect(scores).toHaveLength(1);
    expect(scores[0].entityId).toBe('u2');
  });

  it('sends correct authorization header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ scores: [] }),
    });

    await fetchScores(basePlugin, entities);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('uses custom requestPath from config', async () => {
    const plugin = { ...basePlugin, config: { requestPath: '/v2/risk/evaluate' } };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ scores: [] }),
    });

    await fetchScores(plugin, entities);
    expect(fetchMock.mock.calls[0][0]).toBe('https://scoring.example.com/v2/risk/evaluate');
  });

  it('includes custom headers from config', async () => {
    const plugin = {
      ...basePlugin,
      config: { headers: { 'X-Tenant': 'acme', 'X-Version': '2' } },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ scores: [] }),
    });

    await fetchScores(plugin, entities);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Tenant']).toBe('acme');
    expect(headers['X-Version']).toBe('2');
  });

  it('filters entities by entityTypes config', async () => {
    const plugin = { ...basePlugin, config: { entityTypes: ['Principal'] } };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ scores: [] }),
    });

    await fetchScores(plugin, entities);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Should only send Principals, not Resources
    expect(body.entities).toHaveLength(2); // u1, u2
    expect(body.entities.every(e => e.entityType === 'Principal')).toBe(true);
  });

  it('continues on batch failure (logs warning)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Small batch size to force multiple batches
    const plugin = { ...basePlugin, config: { batchSize: 2 } };
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 }) // first batch fails
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          scores: [{ entityId: 'r1', entityType: 'Resource', score: 60 }],
        }),
      });

    const scores = await fetchScores(plugin, entities);
    expect(scores).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('handles response with "data" key instead of "scores"', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ entityId: 'u1', entityType: 'Principal', score: 42 }],
      }),
    });

    const scores = await fetchScores(basePlugin, entities);
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(42);
  });
});
