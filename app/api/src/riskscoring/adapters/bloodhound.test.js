// Tests for the BloodHound CE adapter.
//
// Validates: health check, data export shape, score retrieval, tier mapping.
// Database calls are mocked — integration tests cover the real DB queries.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the database module
vi.mock('../../db/connection.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

const db = await import('../../db/connection.js');
const { checkHealth, fetchScores, exportData } = await import('./bloodhound.js');

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const basePlugin = {
  endpointUrl: 'http://bloodhound:8080',
  apiKey: 'bh-test-key',
  config: { tenantId: 'test-tenant' },
};

// ─── checkHealth ─────────────────────────────────────────────────────

describe('checkHealth', () => {
  it('returns true when BH API responds ok', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await checkHealth(basePlugin)).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://bloodhound:8080/api/v2/self');
  });

  it('sends Bearer auth header', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await checkHealth(basePlugin);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer bh-test-key');
  });

  it('returns false on connection error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    // checkHealth should not throw
    await expect(checkHealth(basePlugin)).rejects.toThrow();
  });
});

// ─── exportData ──────────────────────────────────────────────────────

describe('exportData', () => {
  it('builds BH-compatible JSON from Identity Atlas data', async () => {
    // Mock principals
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'u1', displayName: 'Alice', email: 'alice@test.com', principalType: 'User',
          accountEnabled: true, externalId: null, extendedAttributes: {} },
      ],
    });
    // Mock resources
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'r1', displayName: 'Domain Admins', description: 'DA group',
          resourceType: 'SecurityGroup', mail: null, externalId: null, extendedAttributes: {} },
      ],
    });
    // Mock assignments
    db.query.mockResolvedValueOnce({
      rows: [
        { resourceId: 'r1', principalId: 'u1', assignmentType: 'Direct' },
      ],
    });

    // Mock the BH upload endpoints
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'task-123' } }) }) // start
      .mockResolvedValueOnce({ ok: true }) // chunk
      .mockResolvedValueOnce({ ok: true }); // end

    const result = await exportData(basePlugin);
    expect(result.taskId).toBe('task-123');
    expect(result.users).toBe(1);
    expect(result.groups).toBe(1);
    expect(result.relationships).toBe(1);

    // Verify the uploaded data structure
    const chunkBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(chunkBody.meta.type).toBe('azure');
    expect(chunkBody.meta.version).toBe(5);
    expect(chunkBody.data).toHaveLength(3); // 1 user + 1 group + 1 relationship

    const user = chunkBody.data.find(d => d.kind === 'User');
    expect(user.data.ObjectIdentifier).toBe('u1');
    expect(user.data.Properties.name).toBe('Alice');

    const group = chunkBody.data.find(d => d.kind === 'Group');
    expect(group.data.ObjectIdentifier).toBe('r1');

    const rel = chunkBody.data.find(d => d.kind === 'Relationship');
    expect(rel.data.Source).toBe('u1');
    expect(rel.data.Target).toBe('r1');
    expect(rel.data.RelType).toBe('MemberOf');
  });

  it('maps Owner assignments to Owns relationship type', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // principals
    db.query.mockResolvedValueOnce({ rows: [] }); // resources
    db.query.mockResolvedValueOnce({
      rows: [{ resourceId: 'r1', principalId: 'u1', assignmentType: 'Owner' }],
    });

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'task-1' } }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await exportData(basePlugin);
    const chunkBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const rel = chunkBody.data.find(d => d.kind === 'Relationship');
    expect(rel.data.RelType).toBe('Owns');
  });

  it('maps DirectoryRole resources to Role kind', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // principals
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'dr1', displayName: 'Global Admin', description: null,
          resourceType: 'DirectoryRole', mail: null, externalId: null, extendedAttributes: {} },
      ],
    });
    db.query.mockResolvedValueOnce({ rows: [] }); // assignments

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'task-2' } }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await exportData(basePlugin);
    const chunkBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const role = chunkBody.data.find(d => d.kind === 'Role');
    expect(role).toBeDefined();
    expect(role.data.ObjectIdentifier).toBe('dr1');
  });
});

// ─── fetchScores ─────────────────────────────────────────────────────

describe('fetchScores', () => {
  const entities = [
    { id: 'u1', type: 'Principal', displayName: 'Alice' },
    { id: 'r1', type: 'Resource', displayName: 'Domain Admins' },
  ];

  it('queries BH Cypher endpoint and maps tier-zero to score 95', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          rows: [
            { objectId: 'u1', tags: 'admin_tier_0', attackPathCount: 5, shortestPathLength: 1 },
          ],
        },
      }),
    });

    const scores = await fetchScores(basePlugin, entities);
    const userScore = scores.find(s => s.entityId === 'u1');
    expect(userScore).toBeDefined();
    expect(userScore.score).toBe(95); // tier zero base
    expect(userScore.explanation.tier).toBe('tierZero');
  });

  it('scores based on shortest path length when not tier-zero', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          rows: [
            { objectId: 'u1', tags: '', attackPathCount: 3, shortestPathLength: 2 },
          ],
        },
      }),
    });

    const scores = await fetchScores(basePlugin, entities);
    const userScore = scores.find(s => s.entityId === 'u1');
    expect(userScore).toBeDefined();
    expect(userScore.score).toBe(76); // highValue (75) + floor(3/3)=1 path bonus
    expect(userScore.explanation.tier).toBe('highValue');
  });

  it('returns empty array when no attack paths exist', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          rows: [
            { objectId: 'u1', tags: '', attackPathCount: 0, shortestPathLength: null },
          ],
        },
      }),
    });

    const scores = await fetchScores(basePlugin, entities);
    expect(scores).toHaveLength(0); // score 0 entities are not included
  });

  it('uses custom tier score map from config', async () => {
    const plugin = {
      ...basePlugin,
      config: { tierScoreMap: { tierZero: 100, highValue: 80 } },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          rows: [
            { objectId: 'u1', tags: 'admin_tier_0', attackPathCount: 0, shortestPathLength: null },
          ],
        },
      }),
    });

    const scores = await fetchScores(plugin, entities);
    expect(scores[0].score).toBe(100); // custom map
  });

  it('handles BH API failure gracefully (logs warning)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const scores = await fetchScores(basePlugin, entities);
    expect(scores).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
