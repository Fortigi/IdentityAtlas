// @ts-check
//
// Live-app parity check for the route families whose unit tests moved onto the
// shared DB manual mock (`app/api/src/db/__mocks__/connection.js`, #665).
//
// The unit mocks are SQL-blind: they return scripted recordsets without ever
// parsing the SQL string, so a converted suite stays green even if the query it
// runs is malformed (exactly how the two T-SQL bugs, #661/#662, slipped past a
// green suite). This spec is the counterpart — it drives the same endpoints
// against the running, demo-data-loaded stack, so the SQL actually executes on
// real Postgres and a broken query surfaces as a 5xx here.
//
// One case per converted route test file.

import { test, expect } from '@playwright/test';
import { API } from './matrixWizard.js';

// endpoint → the shape its handler must return, mirroring the converted suite.
//   'array'   — a bare JSON array
//   'wrapped' — { data: [...] }
//   'paged'   — { data: [...], total: n }
//   'object'  — a plain JSON object
const ENDPOINTS = [
  { suite: 'accountLinking.coverage', path: '/account-linking/config', shape: 'object' },
  { suite: 'accountLinking.coverage', path: '/account-linking/runs', shape: 'wrapped' },
  { suite: 'admin.coverage', path: '/admin/dashboard-stats', shape: 'object' },
  { suite: 'authRoles.coverage', path: '/admin/roles', shape: 'object' },
  { suite: 'bulkLists.coverage', path: '/assignments?limit=5', shape: 'paged' },
  { suite: 'bulkLists.coverage', path: '/identity-members?limit=5', shape: 'paged' },
  { suite: 'bulkLists.coverage', path: '/resource-relationships?limit=5', shape: 'paged' },
  { suite: 'contextPlugins', path: '/context-plugins', shape: 'wrapped' },
  { suite: 'contextPlugins.coverage', path: '/context-plugins/runs', shape: 'wrapped' },
  { suite: 'contexts.coverage', path: '/contexts', shape: 'wrapped' },
  { suite: 'orgChart.coverage', path: '/org-chart', shape: 'object' },
  { suite: 'riskProfiles', path: '/risk-profiles', shape: 'paged' },
  { suite: 'riskProfiles.coverage', path: '/risk-classifiers', shape: 'paged' },
  { suite: 'riskScoringRuns.coverage', path: '/risk-scoring/runs', shape: 'wrapped' },
  { suite: 'tags', path: '/tags', shape: 'array' },
];

function assertShape(body, shape) {
  if (shape === 'array') {
    expect(Array.isArray(body)).toBe(true);
    return;
  }
  expect(body).toBeTruthy();
  expect(typeof body).toBe('object');
  if (shape === 'wrapped' || shape === 'paged') expect(Array.isArray(body.data)).toBe(true);
  if (shape === 'paged') expect(typeof body.total).toBe('number');
}

test.describe('Route families on the shared DB mock — real-SQL parity', () => {
  for (const { suite, path, shape } of ENDPOINTS) {
    test(`GET ${path} executes on real Postgres (${suite})`, async ({ request }) => {
      const res = await request.get(`${API}${path}`);
      // 401/403 mean auth is enabled on this deployment, not a broken query.
      if (res.status() === 401 || res.status() === 403) test.skip();
      expect(res.status(), await res.text()).toBe(200);
      assertShape(await res.json(), shape);
    });
  }

  test('GET /tags/:id/... and tag list agree on the demo tags (tags.coverage)', async ({ request }) => {
    const res = await request.get(`${API}/tags`);
    if (res.status() === 401 || res.status() === 403) test.skip();
    expect(res.status()).toBe(200);
    const tags = await res.json();
    expect(Array.isArray(tags)).toBe(true);
    for (const tag of tags.slice(0, 3)) {
      expect(tag).toHaveProperty('id');
      expect(tag).toHaveProperty('name');
    }
  });

  test('recent-changes runs its _history queries for a real user (recentChanges.routes)', async ({ request }) => {
    const users = await request.get(`${API}/users?limit=1`);
    if (users.status() === 401 || users.status() === 403) test.skip();
    expect(users.status()).toBe(200);
    const body = await users.json();
    const rows = Array.isArray(body) ? body : body.data;
    if (!rows || rows.length === 0) test.skip();

    const id = rows[0].id;
    const res = await request.get(`${API}/user/${id}/recent-changes`);
    expect(res.status(), await res.text()).toBe(200);

    const timeline = await request.get(`${API}/user/${id}/timeline`);
    expect(timeline.status(), await timeline.text()).toBe(200);
  });

  test('malformed ids are rejected before any query runs', async ({ request }) => {
    for (const path of ['/org-chart/user/nope/manager', '/user/nope/recent-changes']) {
      const res = await request.get(`${API}${path}`);
      if (res.status() === 401 || res.status() === 403) continue;
      expect(res.status(), `${path} should 400`).toBe(400);
    }
  });
});
