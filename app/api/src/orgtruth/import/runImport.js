// Organisation truth — one import run, end to end, in the background.
//
//   createImportRun({ source, profile, mode, triggeredBy }) → the queued OrgImportRuns row
//   findActiveRun(profileName)    → a queued/running run of any version of that profile, or null
//   startImportRun(runId)         → fire-and-forget; never awaited by an HTTP handler
//   executeImportRun(runId)       → the awaited body (tests, and a future scheduler)
//
// Steps, each stamped on the run row as `step` + `pct` (the wizard polls it):
//   parse (10) → apply (30) → write (50) → link (70) → project (90) → completed (100)
//   link    = linking/run.js linkRun({ runId, profile, log }), result in stats.links
//   project = enqueueRun(p, { instanceKey: p }, 'org-import', { awaitCompletion: true })
//             for p of 'org-truth' and 'org-truth-principals' (T4's two plugins), in turn;
//             a failure there is logged, not fatal (the entities are written)
// Any other throw ends the run as `failed` with `error` = the message.
//
// Per template (templates.js, read from the recipe): an ACTIVITY run takes its
// own steps and stats (runActivity.js); a relation is applied as its one derived
// entity (templateRecipe.js); only a COLLECTION run ends with the projection.
//
// stats on a completed entity run:
//   { rows, entities: { byType }, relations: { byPredicate },
//     write: writeRun.js counts, links: linkRun result,
//     issues: { count, samples: first ISSUE_SAMPLE_LIMIT issues } }
// where byType / byPredicate are summarizeApplied's per-type and per-predicate counts.
import { query, queryOne, tx } from '../../db/connection.js';
import { randomUUID } from 'node:crypto';
import { validateRecipe } from '../contracts.js';
import { linkRun } from '../linking/run.js';
import { refreshProjections, PROJECTION_PLUGINS } from '../projection/refresh.js';
import { getSourceWithContent, readSourceTable } from './sourceStore.js';
import { getProfile } from './profileStore.js';
import { summarizeApplied } from './applyRecipe.js';
import { applyTemplate } from './templateRecipe.js';
import { activitySteps } from './runActivity.js';
import { templateOf } from '../templates.js';
import { writeRun } from './writeRun.js';

export const ISSUE_SAMPLE_LIMIT = 50;
export { PROJECTION_PLUGINS };

export async function findActiveRun(profileName) {
  return (await queryOne(`
    SELECT r.* FROM "OrgImportRuns" r
      JOIN "OrgImportProfiles" p ON p."id" = r."profileId"
     WHERE p."name" = $1 AND r."status" IN ('queued', 'running')
     ORDER BY r."createdAt" DESC LIMIT 1`, [profileName])) ?? null;
}

export async function createImportRun({ source, profile, mode, triggeredBy }) {
  return queryOne(`
    INSERT INTO "OrgImportRuns" ("id", "profileId", "profileVersion", "sourceId", "mode", "status", "step", "pct", "triggeredBy")
    VALUES ($1, $2, $3, $4, $5, 'queued', 'queued', 0, $6)
    RETURNING *`,
  [randomUUID(), profile.id, profile.version, source.id, mode, triggeredBy]);
}

// Field names are the literals this module passes, never request data.
async function updateRun(runId, fields) {
  const keys = Object.keys(fields);
  const set = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  await query(`UPDATE "OrgImportRuns" SET ${set} WHERE "id" = $1`, [runId, ...keys.map(k => fields[k])]);
}

const now = () => new Date().toISOString();

async function loadRun(runId) {
  const run = await queryOne(`SELECT * FROM "OrgImportRuns" WHERE "id" = $1`, [runId]);
  if (!run) throw new Error(`Import run ${runId} does not exist.`);
  const source = await getSourceWithContent(run.sourceId);
  if (!source) throw new Error('The run\'s source no longer exists.');
  const profile = await getProfile(run.profileId);
  if (!profile) throw new Error('The run\'s profile no longer exists.');
  return { run, source, profile };
}

// Both trees, one after the other (projection/refresh.js); a failure is logged, not fatal.
const project = (log) => refreshProjections('org-import', log);

// The steps of the entity templates (collection, enrichment, relation). Only a
// collection becomes contexts, so only a collection run rebuilds the projections.
async function entitySteps({ runId, run, source, profile, table, step, log }) {
  await step({ step: 'apply', pct: 30 });
  const { recipe, applied } = applyTemplate(table.rows, profile.recipe);
  const summary = summarizeApplied(applied, recipe);

  await step({ step: 'write', pct: 50 });
  const write = await tx(client => writeRun({ client, run, source, profile, ...applied }));

  await step({ step: 'link', pct: 70 });
  const links = await linkRun({ runId, profile, log });

  if (templateOf(profile.recipe) === 'collection') {
    await step({ step: 'project', pct: 90 });
    await project(log);
  }

  return {
    rows: table.rows.length,
    entities: { byType: summary.entities },
    relations: { byPredicate: summary.relations },
    write,
    links,
    issues: { count: applied.issues.length, samples: applied.issues.slice(0, ISSUE_SAMPLE_LIMIT) },
  };
}

async function steps(runId, log) {
  await updateRun(runId, { status: 'running', step: 'parse', pct: 10, startedAt: now() });
  const { run, source, profile } = await loadRun(runId);
  const table = await readSourceTable(source);
  const fit = validateRecipe(profile.recipe, table.columns);
  if (!fit.ok) throw new Error(`The source does not fit profile "${profile.name}" version ${profile.version}: ${fit.errors.join(' ')}`);
  const ctx = { runId, run, source, profile, table, log, step: (fields) => updateRun(runId, fields) };
  return templateOf(profile.recipe) === 'activity' ? activitySteps(ctx) : entitySteps(ctx);
}

// One line for the log, per template.
export function describeStats(stats) {
  if (stats.write) return `${stats.write.entitiesInserted} new, ${stats.write.entitiesUpdated} updated, ${stats.write.entitiesClosed} closed`;
  return `${stats.activities} activities, ${stats.skipped} rows skipped`;
}

export async function executeImportRun(runId) {
  const log = (msg) => console.log(`[org-import ${runId}] ${msg}`);
  try {
    const stats = await steps(runId, log);
    await updateRun(runId, { status: 'completed', step: 'completed', pct: 100, stats: JSON.stringify(stats), finishedAt: now() });
    log(`completed: ${describeStats(stats)}`);
  } catch (err) {
    log(`failed: ${err.message}`);
    await updateRun(runId, { status: 'failed', error: err.message, finishedAt: now() });
  }
}

export function startImportRun(runId) {
  executeImportRun(runId).catch(err => console.error(`Background org-import run ${runId} crashed:`, err));
}
