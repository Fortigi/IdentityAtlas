// Organisation truth — import runs (owned by workstream T1; the dry-run's link
// statistics and the end-of-run linking come from T2 through linking/stats.js
// and linking/run.js).
//
//   POST /api/org-truth/runs/dry-run   { sourceId, recipe, linkRules, mode, profileId? }
//                                      → 200 data-quality report (import/dryRun.js), nothing written;
//                                        400 { error, errors } when the recipe/rules do not fit
//   POST /api/org-truth/runs           { sourceId, profileId, mode } → 202 + run row (status 'queued');
//                                      the run continues in the background (import/runImport.js).
//                                      409 while a run of the same profile (any version) is queued/running.
//   GET  /api/org-truth/runs           the 50 most recent runs, newest first; ?sourceId= / ?profileId=
//   GET  /api/org-truth/runs/:id       one run (the wizard polls it every 1.5 s until completed/failed)
//
// `mode` is 'full' or 'delta' and has no default: closing entities is too
// consequential to happen because a field was left out.
import { Router } from 'express';
import { query, queryOne } from '../../db/connection.js';
import { RUN_MODES } from '../contracts.js';
import { READ_GATE, WRITE_GATE } from './gates.js';
import { getSource, getSourceWithContent } from '../import/sourceStore.js';
import { getProfile } from '../import/profileStore.js';
import { dryRun } from '../import/dryRun.js';
import { createImportRun, findActiveRun, startImportRun } from '../import/runImport.js';
import { actorOf, handle, isUuid, parseOr400, sendInvalid } from '../import/httpHelpers.js';

export const RUN_LIST_LIMIT = 50;
const router = Router();

const badMode = (mode) => !RUN_MODES.includes(mode);
const modeError = (mode) => ({ error: `mode "${mode}" is not one of ${RUN_MODES.join(', ')}.` });

router.post('/org-truth/runs/dry-run', ...WRITE_GATE, handle('dry-run the import', async (req, res) => {
  const { sourceId, recipe, linkRules, mode, profileId } = req.body ?? {};
  if (badMode(mode)) return res.status(400).json(modeError(mode));
  if (profileId !== undefined && !isUuid(profileId)) return res.status(400).json({ error: 'profileId is not a valid id.' });
  const source = await getSourceWithContent(sourceId);
  if (!source) return res.status(404).json({ error: 'Source not found.' });
  const profile = profileId ? await getProfile(profileId) : null;
  if (profileId && !profile) return res.status(404).json({ error: 'Profile not found.' });
  const out = await parseOr400(res, () => dryRun({ source, recipe, linkRules, mode, profileName: profile?.name ?? null }));
  if (!out) return;
  if (!out.ok) return sendInvalid(res, 'The recipe or link rules do not fit this source.', out.errors);
  res.json(out.report);
}));

router.post('/org-truth/runs', ...WRITE_GATE, handle('start the import run', async (req, res) => {
  const { sourceId, profileId, mode } = req.body ?? {};
  if (badMode(mode)) return res.status(400).json(modeError(mode));
  const source = await getSource(sourceId);
  if (!source) return res.status(404).json({ error: 'Source not found.' });
  const profile = await getProfile(profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });
  const active = await findActiveRun(profile.name);
  if (active) {
    return res.status(409).json({ error: `Profile "${profile.name}" already has a run in progress; wait for it to finish.`, runId: active.id });
  }
  const run = await createImportRun({ source, profile, mode, triggeredBy: actorOf(req) });
  startImportRun(run.id);
  res.status(202).json(run);
}));

router.get('/org-truth/runs', ...READ_GATE, handle('list the runs', async (req, res) => {
  const filters = {};
  for (const key of ['sourceId', 'profileId']) {
    const v = req.query[key];
    if (v === undefined || v === '') continue;
    if (!isUuid(v)) return res.status(400).json({ error: `${key} is not a valid id.` });
    filters[key] = v;
  }
  const r = await query(`
    SELECT * FROM "OrgImportRuns"
     WHERE ($1::uuid IS NULL OR "sourceId" = $1) AND ($2::uuid IS NULL OR "profileId" = $2)
     ORDER BY "createdAt" DESC
     LIMIT ${RUN_LIST_LIMIT}`, [filters.sourceId ?? null, filters.profileId ?? null]);
  res.json(r.rows);
}));

router.get('/org-truth/runs/:id', ...READ_GATE, handle('read the run', async (req, res) => {
  const row = isUuid(req.params.id) ? await queryOne(`SELECT * FROM "OrgImportRuns" WHERE "id" = $1`, [req.params.id]) : null;
  if (!row) return res.status(404).json({ error: 'Run not found.' });
  res.json(row);
}));

export default router;
