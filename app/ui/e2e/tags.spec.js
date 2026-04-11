// @ts-check
/**
 * Tag lifecycle E2E tests — API-level (no browser needed for most steps).
 *
 * Covers: create tag → assign to resource → filter by tag → delete.
 * These operations mirror the MatrixAPI section in run-docker-tests.ps1.
 */

import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api';

test.describe('Tag lifecycle (API)', () => {
  let tagId;
  let resourceId;

  test('create a resource tag', async ({ request }) => {
    const res = await request.post(`${API}/tags`, {
      data: { name: 'e2e-playwright-tag', entityType: 'resource', color: '#3B82F6' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.id).toBeDefined();
    tagId = body.id;
  });

  test('created tag appears in tag list', async ({ request }) => {
    if (!tagId) test.skip();
    const res = await request.get(`${API}/tags?entityType=resource`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const tags = Array.isArray(body) ? body : (body.data ?? body.tags ?? []);
    const found = tags.find(t => t.id === tagId);
    expect(found).toBeDefined();
    expect(found.name).toBe('e2e-playwright-tag');
  });

  test('assign tag to a resource', async ({ request }) => {
    if (!tagId) test.skip();

    // Get a resource to tag
    const resRes = await request.get(`${API}/resources?limit=1`);
    expect(resRes.ok()).toBeTruthy();
    const resBody = await resRes.json();
    const resources = Array.isArray(resBody) ? resBody : (resBody.data ?? []);
    expect(resources.length).toBeGreaterThan(0);
    resourceId = resources[0].id;

    const assignRes = await request.post(`${API}/tags/${tagId}/assign`, {
      data: { entityIds: [resourceId] },
    });
    expect(assignRes.ok()).toBeTruthy();
  });

  test('filtering resources by tag returns tagged resources', async ({ request }) => {
    if (!tagId || !resourceId) test.skip();
    const res = await request.get(`${API}/resources?tag=e2e-playwright-tag`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const resources = Array.isArray(body) ? body : (body.data ?? []);
    expect(resources.length).toBeGreaterThan(0);
    const found = resources.find(r => r.id === resourceId);
    expect(found).toBeDefined();
  });

  test('delete the test tag', async ({ request }) => {
    if (!tagId) test.skip();
    const res = await request.delete(`${API}/tags/${tagId}`);
    expect(res.ok()).toBeTruthy();
    tagId = undefined;
  });

  test('deleted tag no longer appears in list', async ({ request }) => {
    const res = await request.get(`${API}/tags?entityType=resource`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const tags = Array.isArray(body) ? body : (body.data ?? body.tags ?? []);
    const found = tags.find(t => t.name === 'e2e-playwright-tag');
    expect(found).toBeUndefined();
  });
});

// ── Matrix filter with tag ───────────────────────────────────────────────────

test.describe('Matrix tag filter (UI)', () => {
  test('matrix permissions endpoint accepts groupTag filter', async ({ request }) => {
    // Create a temp tag, assign it, filter the matrix, clean up
    const createRes = await request.post(`${API}/tags`, {
      data: { name: 'e2e-matrix-filter', entityType: 'resource', color: '#EF4444' },
    });
    if (!createRes.ok()) test.skip();

    const tag = await createRes.json();
    const tId = tag.id;

    // Get any resource
    const resRes = await request.get(`${API}/resources?limit=1`);
    const resBody = await resRes.json();
    const resources = Array.isArray(resBody) ? resBody : (resBody.data ?? []);
    if (resources.length === 0) {
      await request.delete(`${API}/tags/${tId}`);
      test.skip();
    }

    await request.post(`${API}/tags/${tId}/assign`, {
      data: { entityIds: [resources[0].id] },
    });

    // Matrix filtered by this tag should return a valid response
    const matrixRes = await request.get(`${API}/permissions?userLimit=50&__groupTag=e2e-matrix-filter`);
    expect(matrixRes.ok()).toBeTruthy();

    // Cleanup
    await request.delete(`${API}/tags/${tId}`);
  });
});
