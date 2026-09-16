// GET /api/attribute-labels — the shared label channel the browser and the Power
// Query workbook both read (issue #872).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { clearAttributeLabelCache } from '../lib/attributeLabels.js';

// Dynamic import: the router reads USE_SQL at module scope, and a static import
// would be hoisted above the assignment above.
const { default: router } = await import('./attributeLabels.js');

const APP_A = '8ce8d3db3b314def88d829e15494e83f';
const app = mountRouter(router);

// Overrides query first, then one distinct-keys query per table scanned.
function stage(overrides, ...keySets) {
  query.mockResolvedValueOnce({ rows: overrides.map(m => ({ m })) });
  for (const keys of keySets) query.mockResolvedValueOnce({ rows: keys.map(k => ({ k })) });
}

describe('GET /attribute-labels', () => {
  beforeEach(() => {
    query.mockReset();
    clearAttributeLabelCache();
  });
  afterEach(() => clearAttributeLabelCache());

  it('returns clean names for extension keys and nothing for the rest', async () => {
    stage([], [`extension_${APP_A}_sAMAccountName`, 'userType', 'department']);

    const res = await request(app).get('/api/attribute-labels?target=principal');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ labels: { [`extension_${APP_A}_sAMAccountName`]: 'sAMAccountName' } });
  });

  it('scopes the scan to the requested target table', async () => {
    stage([], [`extension_${APP_A}_fgGroupDN_OuPath`]);

    const res = await request(app).get('/api/attribute-labels?target=resource');

    expect(res.body.labels[`extension_${APP_A}_fgGroupDN_OuPath`]).toBe('fgGroupDN_OuPath');
    expect(query.mock.calls[1][0]).toContain('"Resources"');
    expect(query.mock.calls[1][0]).not.toContain('"Principals"');
  });

  it('unions all four targets when target is omitted', async () => {
    stage([], [`extension_${APP_A}_a`], [], [], [`extension_${APP_A}_d`]);

    const res = await request(app).get('/api/attribute-labels');

    expect(res.body.labels).toEqual({
      [`extension_${APP_A}_a`]: 'a',
      [`extension_${APP_A}_d`]: 'd',
    });
  });

  it('lets the crawler-stamped name win over the rule', async () => {
    const key = `extension_${APP_A}_sfCostCenterID`;
    stage([{ [key]: 'Cost Centre' }], [key]);

    const res = await request(app).get('/api/attribute-labels?target=principal');

    expect(res.body.labels[key]).toBe('Cost Centre');
  });

  it('rejects an unknown target rather than scanning an attacker-named table', async () => {
    const res = await request(app).get('/api/attribute-labels?target=Principals"; DROP');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('principal');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a target that only matches an Object.prototype key', async () => {
    const res = await request(app).get('/api/attribute-labels?target=constructor');

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('degrades to an empty map when the lookup throws, never a 500', async () => {
    query.mockRejectedValue(new Error('relation "Systems" does not exist'));

    const res = await request(app).get('/api/attribute-labels?target=principal');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ labels: {} });
  });

  it('returns an empty map with no attributes present at all', async () => {
    stage([], []);

    const res = await request(app).get('/api/attribute-labels?target=identity');

    expect(res.body).toEqual({ labels: {} });
  });
});
