// @ts-check
/**
 * A crawler's own name reaches the runs it queues (#1207).
 *
 * Reported symptom: a crawler the operator named ABC registered an Identity
 * Atlas system named after the crawler *type* instead. Two crawlers of one type
 * therefore produced two indistinguishable systems, and renaming a crawler never
 * renamed its system.
 *
 * The root cause sat in this layer and is not specific to any crawler type: the
 * API had no channel at all for telling a run what its crawler is called —
 * neither queue path (the Run Now route, the scheduler) put
 * `CrawlerConfigs.displayName` anywhere the running crawler could read it, so no
 * crawler could have named anything after it even if it wanted to. The fix
 * stamps it onto the job's config under the reserved `_configName` key, and that
 * is what this spec walks against the running stack: create a crawler, queue a
 * run, read back the config the run was handed, rename the crawler, queue
 * another run.
 *
 * Deliberately type-agnostic. The crawler type is discovered from the manifests
 * on disk — the same source of truth crawler-wizard-discovery.spec.js reads —
 * and never named here: a hardcoded crawler-type string under app/ui/ fails the
 * crawler-manifest CI job and belongs in that crawler's own folder anyway. How
 * one particular crawler then *uses* `_configName` to name the system it
 * registers is covered where that crawler lives: its ConfigWizard.e2e.mjs walks
 * the wizard, and its Test-<Type>Crawler.ps1 asserts the name the registered
 * system ends up with after a real sync.
 */

import { test, expect } from '@playwright/test';
import { queueableCrawlerTypes } from './crawlerConfigFixtures.js';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

/**
 * Queue a run for a stored crawler config and answer with the crawler name the
 * API handed that run. The run is cancelled again immediately: this spec is
 * about what a run is *told*, not about crawling a real endpoint, and a queued
 * job the worker picks up would go off and fail against a placeholder host.
 */
async function queuedRunName(request, jobType, configId) {
  const res = await request.post(`${API}/admin/crawler-jobs`, { data: { jobType, configId } });
  expect(res.status(), await res.text()).toBe(201);
  const job = await res.json();
  try {
    const config = typeof job.config === 'string' ? JSON.parse(job.config) : job.config;
    return config?._configName;
  } finally {
    const cancelled = await request.delete(`${API}/admin/crawler-jobs/${job.id}`);
    expect(cancelled.ok(), 'the queued run has to be cancelled again, not left for the worker to dial').toBeTruthy();
  }
}

test.describe('Crawler run naming', () => {
  test('a run carries the name of the crawler that queued it, and follows a rename (#1207)', async ({ page, request }) => {
    const [candidate] = queueableCrawlerTypes();
    test.skip(!candidate, 'No crawler type in tools/crawlers/ can be configured and queued without type-specific knowledge');

    const name = `e2e-crawler-${Date.now()}`;
    const created = await request.post(`${API}/admin/crawler-configs`, {
      data: { crawlerType: candidate.type, displayName: name, config: candidate.config },
    });
    expect(created.status(), await created.text()).toBe(201);
    const configId = (await created.json()).id;

    try {
      // The name the operator gave the crawler, as the operator sees it.
      await page.goto(`${BASE}/#admin`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator(`text=${name}`).first()).toBeVisible({ timeout: 15000 });

      // Before the fix this was undefined — the run was handed the operator's
      // settings and nothing else, so the crawler's name could not reach the
      // system it registers and the crawler type was all it had left to use.
      expect(await queuedRunName(request, candidate.type, configId)).toBe(name);

      // Second half of the report: renaming the crawler never renamed anything
      // downstream, because there was nothing downstream to rename.
      const renamed = `${name}-renamed`;
      const patched = await request.patch(`${API}/admin/crawler-configs/${configId}`, { data: { displayName: renamed } });
      expect(patched.ok(), await patched.text()).toBeTruthy();
      expect(await queuedRunName(request, candidate.type, configId)).toBe(renamed);

      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.locator(`text=${renamed}`).first()).toBeVisible({ timeout: 15000 });
    } finally {
      await request.delete(`${API}/admin/crawler-configs/${configId}`);
    }
  });

  // #1207 shipped the channel and one consumer; #1240 is the rest of the report —
  // "the System's display name follows the crawler's name, for EVERY crawler
  // type". Naming the system is each crawler's own job (and is asserted per type
  // in its unit tests and its Test-<Type>Crawler.ps1), but a type whose runs are
  // never handed the name cannot do it at all — which is exactly how Entra ID,
  // Azure RM, Omada and midPoint kept registering "Entra ID (<tenant>)" and
  // friends after #1207. That precondition is type-agnostic, so it is checked
  // here for every type at once rather than one type stalling the others.
  //
  // Only types whose required fields carry no URL are walked, for the same reason
  // the test above takes the first candidate: queueing a run for a URL-bearing
  // type puts the SSRF guard in the path, and that depends on a placeholder
  // hostname resolving. The types that are skipped for that reason are named in
  // the run output rather than silently dropped.
  test('every queueable crawler type is handed its crawler name (#1240)', async ({ request }) => {
    const all = queueableCrawlerTypes();
    const candidates = all.filter(c => !c.hasUrlField);
    test.skip(candidates.length === 0, 'No crawler type in tools/crawlers/ can be configured and queued without type-specific knowledge');

    const stamp = Date.now();
    const created = [];
    try {
      for (const candidate of candidates) {
        const name = `e2e-crawler-${candidate.type}-${stamp}`;
        const res = await request.post(`${API}/admin/crawler-configs`, {
          data: { crawlerType: candidate.type, displayName: name, config: candidate.config },
        });
        expect(res.status(), `${candidate.type}: ${await res.text()}`).toBe(201);
        created.push({ type: candidate.type, name, id: (await res.json()).id });
      }
      console.log(`Crawler types walked: ${created.map(c => c.type).join(', ')}`
        + `; not walked (needs a resolvable host): ${all.filter(c => c.hasUrlField).map(c => c.type).join(', ') || 'none'}`);

      const mismatched = [];
      for (const { type, name, id } of created) {
        const got = await queuedRunName(request, type, id);
        if (got !== name) mismatched.push({ type, got, want: name });
      }
      // One assertion over every type, so a failure names all of them rather
      // than stopping at whichever happens to sort first.
      expect(mismatched, 'crawler types whose run was not handed the crawler name').toEqual([]);
    } finally {
      for (const { id } of created) await request.delete(`${API}/admin/crawler-configs/${id}`);
    }
  });
});
