// @ts-check
/**
 * "Force a full sync next run" reaches the next *scheduled* run (#1628).
 *
 * Reported symptom: setting `CrawlerConfigs.nextRunMode = 'full'` had no effect
 * on a crawler whose schedule entries say explicitly whether they run delta or
 * full — which, since the per-schedule Mode dropdown shipped, is every crawler
 * set up through the wizard. The next scheduled run was still a delta and the
 * flag stayed `'full'` forever, so the only way to get a full run outside the
 * full schedule's own time slot was the Run Full button or a hand-written job
 * row. The scheduler resolved the mode schedule-first, so an explicit
 * per-schedule `syncMode` always won and the flag was only ever consulted for
 * legacy schedules that named no mode at all.
 *
 * This walks the reporter's path against the running stack: a crawler with a
 * frequent delta-mode schedule plus a daily full-mode one, `nextRunMode='full'`
 * patched onto the config, then the job the *scheduler itself* queues on the
 * next tick — read both from the API and from the Mode badge the operator reads
 * in Admin → Crawlers → Recent Jobs, which is where the wrong 'delta' showed up.
 *
 * Why an hourly delta and not the reported every-5-minutes one: an `interval`
 * schedule only fires on minutes divisible by its interval, so a 5-minute entry
 * can be 5+ minutes away. An `hourly` entry at the next minute plays the same
 * role (a frequent delta-mode schedule that fires before the daily full) and
 * fires within ~2 minutes. Two spare entries a minute apart cover a tick that
 * drifts past its minute on a loaded box; whichever one fires, the assertions
 * below check the mode of the schedule that actually fired.
 *
 * Deliberately type-agnostic — the crawler type comes from the manifests on disk
 * (crawlerConfigFixtures.js); a hardcoded crawler-type string under app/ui/
 * fails the crawler-manifest CI job. Nothing is ever crawled: the scheduled job
 * is cancelled as soon as it appears, well inside the worker's ~30s claim poll.
 */

import { test, expect } from '@playwright/test';
import { queueableCrawlerTypes } from './crawlerConfigFixtures.js';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

// The scheduler ticks once a minute; the delta entries start two minutes out so
// the tick that fires one of them is comfortably after the PATCH below.
const FIRST_DELTA_MINUTES_AHEAD = 2;
const SPARE_DELTA_ENTRIES = 2;
const WAIT_FOR_TICK_MS = 5 * 60_000;
const POLL_MS = 1000;

/**
 * Schedules in the shape the wizard writes them: frequent deltas that each name
 * `syncMode: 'delta'`, and one daily full. The full entry's hour is half a day
 * out so it cannot fire during the test — a full run from the *full* schedule
 * would prove nothing about the override.
 */
function wizardShapedSchedules(now) {
  const deltas = [];
  for (let i = 0; i < 1 + SPARE_DELTA_ENTRIES; i++) {
    deltas.push({
      enabled: true,
      frequency: 'hourly',
      minute: (now.getUTCMinutes() + FIRST_DELTA_MINUTES_AHEAD + i) % 60,
      syncMode: 'delta',
    });
  }
  return [
    ...deltas,
    { enabled: true, frequency: 'daily', hour: (now.getUTCHours() + 12) % 24, minute: 30, syncMode: 'full' },
  ];
}

/** Every job the scheduler queued for this config, newest first. */
async function scheduledJobsFor(request, configId) {
  const res = await request.get(`${API}/admin/crawler-jobs?limit=50`);
  if (!res.ok()) return [];
  const jobs = await res.json();
  if (!Array.isArray(jobs)) return [];
  return jobs.filter(j => j.configId === configId && j.createdBy === 'scheduler');
}

/** Poll until the scheduler has queued a job for this config, or give up. */
async function waitForScheduledJob(request, configId) {
  const deadline = Date.now() + WAIT_FOR_TICK_MS;
  for (;;) {
    const [job] = await scheduledJobsFor(request, configId);
    if (job) return job;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

/** Leave nothing queued behind, whichever schedule entries managed to fire. */
async function cancelScheduledJobs(request, configId) {
  for (const job of await scheduledJobsFor(request, configId)) {
    await request.delete(`${API}/admin/crawler-jobs/${job.id}`);
  }
}

const jobConfigOf = (job) => (typeof job.config === 'string' ? JSON.parse(job.config) : job.config) || {};

test.describe('Crawler force-full-next-run', () => {
  test("nextRunMode='full' makes the next scheduled run a full one, from a delta schedule (#1628)", async ({ page, request }) => {
    // The wait for a scheduler tick dominates; everything else is API calls.
    test.setTimeout(WAIT_FOR_TICK_MS + 2 * 60_000);

    const [candidate] = queueableCrawlerTypes();
    test.skip(!candidate, 'No crawler type in tools/crawlers/ can be configured and scheduled without type-specific knowledge');

    const schedules = wizardShapedSchedules(new Date());
    const name = `e2e-force-full-${Date.now()}`;
    const created = await request.post(`${API}/admin/crawler-configs`, {
      data: { crawlerType: candidate.type, displayName: name, config: { ...candidate.config, schedules } },
    });
    expect(created.status(), await created.text()).toBe(201);
    const configId = (await created.json()).id;

    try {
      // The crawler as the operator sees it: Admin → Crawlers, card on screen.
      await page.goto(`${BASE}/#crawlers`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator(`text=${name}`).first()).toBeVisible({ timeout: 15000 });

      // Step 2 of the report: force a full sync for the next run.
      const patched = await request.patch(`${API}/admin/crawler-configs/${configId}`, { data: { nextRunMode: 'full' } });
      expect(patched.ok(), await patched.text()).toBeTruthy();
      expect((await patched.json()).nextRunMode).toBe('full');

      // Step 3: wait for the tick that fires one of the delta-mode schedules.
      const job = await waitForScheduledJob(request, configId);
      if (!job) throw new Error(`The scheduler queued no job for config ${configId} within ${WAIT_FOR_TICK_MS / 1000}s`);

      // Stop it going anywhere before asserting anything — placeholder
      // settings. The config goes first, so no further entry can fire.
      await request.delete(`${API}/admin/crawler-configs/${configId}`);
      await cancelScheduledJobs(request, configId);

      // Step 4, the bug: a delta-mode schedule fired, and before the fix the
      // run it queued was a delta — the forced full was silently dropped.
      const jobConfig = jobConfigOf(job);
      const firedSchedule = schedules[jobConfig._scheduleIndex] || {};
      expect(firedSchedule.syncMode, 'the schedule that fired has to be one of the delta-mode ones').toBe('delta');
      expect(jobConfig._syncMode, "nextRunMode='full' must override the schedule's own 'delta'").toBe('full');

      // And what the operator actually reads: the Mode badge in Recent Jobs.
      // The row is located by the very list the page fetched, so a job queued
      // by another crawler in between cannot shift the assertion onto it.
      // Reloaded, not navigated to: the page is already on #crawlers, and a
      // goto to the URL it is already showing is a same-document fragment
      // navigation — nothing remounts, so the jobs list is never re-fetched
      // and there is no response to wait for.
      const listResponse = page.waitForResponse(
        r => r.url().includes('/api/admin/crawler-jobs?') && r.ok(),
        { timeout: 30000 }
      );
      await page.reload();
      const listed = await (await listResponse).json();
      const rowIndex = listed.findIndex(j => j.id === job.id);
      expect(rowIndex, 'the scheduled job has to be in the Recent Jobs list the page fetched').toBeGreaterThanOrEqual(0);

      const recentJobs = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Recent Jobs' }) }).last();
      const row = recentJobs.locator('tbody tr').nth(rowIndex);
      await expect(row.locator('td').nth(0)).toHaveText(candidate.type, { timeout: 15000 });
      await expect(row.locator('td').nth(1)).toHaveText('full');
    } finally {
      // Repeats of the in-test cleanup: a second call just 404s. This is the
      // path that matters when an assertion above fails.
      await request.delete(`${API}/admin/crawler-configs/${configId}`);
      await cancelScheduledJobs(request, configId);
    }
  });
});
