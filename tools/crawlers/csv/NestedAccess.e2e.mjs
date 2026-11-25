// @ts-check
/**
 * CSV import — inherited access through nested groups, end to end (#1684).
 *
 * The unit tests (test/unit/CSVCrawlerNesting.Tests.ps1) cover the expansion
 * itself and Test-CSVCrawler.ps1 drives the crawler script directly. What
 * neither can show is the thing the feature was asked for: that a real import,
 * queued the way an operator queues it, makes a person who holds a group only
 * *through* another group show up on it in the app. So this spec configures a
 * CSV crawler, uploads the fixture files, runs the job, and then reads the
 * result back — first through the API, then on the resource's own page.
 *
 * It runs against the live, demo-data-loaded deployment and adds its own
 * throwaway system, so nothing it does depends on (or disturbs) the demo data.
 *
 * Named *.e2e.mjs and exporting register(test, expect) rather than importing
 * @playwright/test: that package only exists under app/ui/node_modules, and
 * app/ui/e2e/crawler-plugin-tests.spec.js is the one loader that imports it and
 * hands it to every crawler's own spec. See tools/crawlers/CLAUDE.md.
 */

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

const CRAWLER_TYPE = 'csv';
// One stamp per run: every id, name and search below is scoped to it, so a
// re-run never meets its own leftovers.
const STAMP = `nest-${Math.random().toString(36).slice(2, 10)}`;
const res = (suffix) => `${STAMP}-${suffix}`;

/** The fixture files, with the nesting rows of this import. */
function fixtureFiles(relationshipRows) {
  return {
    'Resources.csv': [
      'ExternalId;DisplayName;ResourceType',
      ...['A', 'B', 'C', 'D'].map(s => `${res(s)};${res(s)};Group`),
    ],
    'Users.csv': [
      'ExternalId;DisplayName',
      ...['u1', 'u2'].map(s => `${res(s)};${res(s)}`),
    ],
    // u1 holds A directly, u2 holds B directly. Nothing says u1 holds B — that
    // is what the nesting has to produce; and u2's own Direct row on B is what
    // proves an inherited row never shadows a declared one.
    'Assignments.csv': [
      'ResourceExternalId;UserExternalId;AssignmentType',
      `${res('A')};${res('u1')};Direct`,
      `${res('B')};${res('u2')};Direct`,
    ],
    'ResourceRelationships.csv': [
      'ParentExternalId;ChildExternalId;RelationshipType',
      ...relationshipRows,
    ],
  };
}

export function register(test, expect) {
  test.describe('CSV import — inherited access through nested groups', () => {
    test('a member of a nested group shows on the containing group as Indirect (#1684)', async ({ page, request }) => {
      // Three full crawler runs over an uploaded fixture; the worker claims jobs
      // on its own cadence.
      test.setTimeout(8 * 60 * 1000);

      const created = await request.post(`${API}/admin/crawler-configs`, {
        data: {
          crawlerType: CRAWLER_TYPE,
          displayName: `e2e-${STAMP}`,
          config: { systemName: `e2e ${STAMP}`, systemType: 'CSV', delimiter: ';' },
        },
      });
      test.skip(created.status() === 503, 'deployment has no database (mock mode) — nothing to import into');
      expect(created.status(), await created.text()).toBe(201);
      const configId = (await created.json()).id;

      /** Replace the uploaded fixture with these relationship rows. */
      async function upload(relationshipRows) {
        const files = fixtureFiles(relationshipRows);
        for (const [name, lines] of Object.entries(files)) {
          const up = await request.post(`${API}/admin/crawler-configs/${configId}/files`, {
            multipart: { files: { name, mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) } },
          });
          expect(up.ok(), `upload ${name}: ${await up.text()}`).toBeTruthy();
        }
      }

      /**
       * Queue a run and wait for the worker to finish it. Returns the final job
       * row, or null when nothing ever claimed it — a deployment without a
       * worker container is a skip, not a failure.
       */
      async function runImport() {
        const queued = await request.post(`${API}/admin/crawler-jobs`, {
          data: { jobType: CRAWLER_TYPE, configId, syncMode: 'full' },
        });
        expect(queued.status(), await queued.text()).toBe(201);
        const jobId = (await queued.json()).id;
        let job = null;
        let claimed = false;
        for (let i = 0; i < 90; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const r = await request.get(`${API}/admin/crawler-jobs/${jobId}`);
          if (!r.ok()) continue;
          job = await r.json();
          if (job.status !== 'queued') claimed = true;
          if (job.status === 'completed' || job.status === 'failed') return job;
          // Still queued after a minute: no worker is listening here.
          if (!claimed && i > 30) {
            await request.delete(`${API}/admin/crawler-jobs/${jobId}`);
            return null;
          }
        }
        return job;
      }

      /** The id of one fixture resource, found the way a user would find it. */
      async function resourceId(suffix) {
        const r = await request.get(`${API}/resources?search=${encodeURIComponent(STAMP)}&includeBusinessRoles=true&limit=50`);
        expect(r.ok(), await r.text()).toBeTruthy();
        const row = ((await r.json()).data || []).find(x => x.externalId === res(suffix));
        return row?.id;
      }

      /** The current holders of a resource as "<user> <type>" strings. */
      async function holders(id) {
        const r = await request.get(`${API}/resources/${id}/assignments`);
        expect(r.ok(), await r.text()).toBeTruthy();
        return (await r.json())
          .filter(a => !a.deleted)
          .map(a => `${a.principalDisplayName} ${a.assignmentType}`)
          .sort();
      }

      let systemId = null;
      try {
        // ── First import: u1 is in A, and A is a member of B. ──────────────
        // C → D is a second nesting row that stays in the file for the second
        // import, so that one reconciles A → B away with the type still
        // carrying rows; the third import drops C → D too and covers the type
        // with no rows at all.
        await upload([`${res('A')};${res('B')};GrantsAccessTo`, `${res('C')};${res('D')};GrantsAccessTo`]);
        const first = await runImport();
        test.skip(first === null, 'no crawler worker claimed the job in this deployment');
        expect(first.status, `import failed: ${first.errorMessage || ''}`).toBe('completed');

        const idB = await resourceId('B');
        expect(idB, 'the fixture resources were not imported').toBeTruthy();
        systemId = (await (await request.get(`${API}/resources/${idB}`)).json())?.attributes?.systemId ?? null;

        // The whole point: u1 was never assigned to B by any file.
        expect(await holders(idB)).toEqual([`${res('u1')} Indirect`, `${res('u2')} Direct`]);

        // And it is visible where someone reviewing B would look: B's own page
        // lists an Indirect Members branch, and opening it names u1. The label
        // is always drawn (count 0 or 1), so the proof is the user behind it.
        // The page opens on Attributes; the member branches live on the
        // Relationships tab's graph.
        //
        // The graph's active nodes pulse (SVG SMIL <animate>, endlessly), so a
        // node never passes Playwright's "stable" check and a plain click()
        // waits out the whole test timeout. Reduced motion drops the pulse, and
        // the click is dispatched to the label, whose node group handles it.
        // Every action carries its own timeout so a miss fails in seconds
        // rather than eating the job's.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(`${BASE}/#group:${idB}`);
        await page.waitForLoadState('networkidle');
        await expect(page.getByText(res('B')).first()).toBeVisible({ timeout: 15000 });
        await page.getByRole('tab', { name: /Relationships/i }).click({ timeout: 15000 });
        const indirectBranch = page.getByText('Indirect Members').first();
        await expect(indirectBranch).toBeVisible({ timeout: 15000 });
        await indirectBranch.dispatchEvent('click', undefined, { timeout: 15000 });
        await expect(page.getByText(res('u1')).first()).toBeVisible({ timeout: 15000 });

        // ── Second import: the A → B nesting row is gone from the file. ─────
        // The inherited row has to go with it; u2's declared row must not, and
        // the nesting row itself must be gone too.
        await upload([`${res('C')};${res('D')};GrantsAccessTo`]);
        const second = await runImport();
        expect(second.status, `re-import failed: ${second.errorMessage || ''}`).toBe('completed');
        expect(await holders(idB)).toEqual([`${res('u2')} Direct`]);

        /** The relationship types the resource is reached by, deduped and sorted. */
        async function parentTypes(id) {
          const rows = await (await request.get(`${API}/resources/${id}/parent-resources`)).json();
          return [...new Set(rows.map(p => p.relationshipType))].sort();
        }
        expect(await parentTypes(idB)).toEqual([]);

        // ── Third import: the file has no GrantsAccessTo row at all. ────────
        // The last row of a type leaving the file used to leave every stored row
        // of that type behind: with no rows, nothing was sent for the type, so
        // its scope was never reconciled. The Contains row this import does
        // supply has to load and stay — a run that reconciled every type empty
        // would clear that one too.
        const idC = await resourceId('C');
        const idD = await resourceId('D');
        expect(await parentTypes(idD), 'C → D should still grant D going into the third import').toEqual(['GrantsAccessTo']);

        await upload([`${res('A')};${res('C')};Contains`]);
        const third = await runImport();
        expect(third.status, `third import failed: ${third.errorMessage || ''}`).toBe('completed');
        expect(await parentTypes(idD)).toEqual([]);
        expect(await parentTypes(idC)).toEqual(['Contains']);
      } finally {
        await request.delete(`${API}/admin/crawler-configs/${configId}`).catch(() => {});
        // The API has no delete for Systems; disabling is as clean as it gets.
        if (systemId) {
          await request.put(`${API}/systems/${systemId}`, {
            data: { enabled: false, description: 'Disabled by the CSV nested-access e2e' },
          }).catch(() => {});
        }
      }
    });
  });
}
