// The experimental-crawler gate on POST /api/admin/crawler-configs.
//
// The rule being pinned: turning the flag off must stop a NEW experimental
// crawler being added, and must not touch anything else — a non-experimental
// type is unaffected, and an existing experimental config can still be removed
// (that is what keeps an already-configured connector alive when the flag
// goes off).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';

vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('./crawlerFiles.js', () => ({ getUploadFolderPath: vi.fn(() => '/tmp/x'), deleteConfigFolder: vi.fn(async () => {}) }));
vi.mock('../secrets/crawlerSecrets.js', () => ({
  storeConfigSecret: vi.fn(async () => {}), hasConfigSecret: vi.fn(async () => false),
  deleteConfigSecret: vi.fn(async () => {}), getConfigSecret: vi.fn(async () => null),
  storeJobSecret: vi.fn(async () => {}), storeJobCredentials: vi.fn(async () => {}), OTHER_SECRET_FIELDS: [],
}));
// Fictional types on purpose: the gate is generic, so naming a real crawler here
// would only tie this test to whichever one happens to be experimental today.
vi.mock('../crawlerManifests.js', () => ({
  CRAWLER_MANIFESTS_DIR: '', _crawlerManifests: {}, VALID_JOB_TYPES: ['settled-type', 'preview-type'],
  validateCrawlerConfig: vi.fn(() => null), validateStoredCrawlerConfig: vi.fn(async () => null),
  isSingletonJob: vi.fn(() => false), isPushModeType: vi.fn(() => false),
  isExperimentalType: vi.fn(t => t === 'preview-type'),
}));
const isFeatureEnabled = vi.fn(async () => false);
vi.mock('../featureFlags.js', () => ({ isFeatureEnabled: (...a) => isFeatureEnabled(...a) }));

const { default: router } = await import('./jobs.js');
const app = mountRouter(router);

const post = (crawlerType) =>
  request(app).post('/api/admin/crawler-configs').send({ crawlerType, displayName: 'Test', config: {} });

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [{ id: 1, crawlerType: 'preview-type', config: {} }], rowCount: 1 });
  isFeatureEnabled.mockReset();
  isFeatureEnabled.mockResolvedValue(false);
});

describe('POST /admin/crawler-configs — experimental gate', () => {
  it('refuses an experimental type while the flag is off, and never writes a row', async () => {
    const res = await post('preview-type');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/experimental crawler/i);
    expect(isFeatureEnabled).toHaveBeenCalledWith('experimentalCrawlers');
    expect(query).not.toHaveBeenCalled();
  });

  it('names the type and points at the toggle, so the message is actionable', async () => {
    const res = await post('preview-type');
    expect(res.body.error).toContain("'preview-type'");
    expect(res.body.error).toMatch(/Admin → Experimental/);
  });

  it('creates the same experimental type once the flag is on', async () => {
    isFeatureEnabled.mockResolvedValue(true);
    const res = await post('preview-type');
    expect(res.status).toBe(201);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO "CrawlerConfigs"/.test(sql))).toBe(true);
  });

  it('leaves a non-experimental type alone — the flag is never even consulted', async () => {
    const res = await post('settled-type');
    expect(res.status).toBe(201);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('still lets an existing experimental config be deleted while the flag is off', async () => {
    // Nothing about the gate may touch the lifecycle of what is already configured.
    const res = await request(app).delete('/api/admin/crawler-configs/1');
    expect(res.status).toBe(200);
  });
});
