// Authorization workbench — saved investigations (M2a: save and reopen).
// Design: docs/architecture/m1-discovery-and-design.md, "M2a — save and reopen".
//
//   GET    /api/contexts/:id/workbench/investigations          the unit's saved investigations
//   POST   /api/contexts/:id/workbench/investigations          save a new one (the whole draft)
//   GET    /api/workbench/investigations/:invId                one, everything a reopen needs
//   PUT    /api/workbench/investigations/:invId                save over it (the whole draft)
//   DELETE /api/workbench/investigations/:invId                delete it
//   DELETE /api/workbench/investigations/:invId/proposals/:pid delete one proposed role
//
// Same gate as the workbench (data.write.contexts). A saved investigation is an
// analyst's hypothesis: nothing here changes access or a source system.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, writeContexts, UUID_RE } from './shared.js';
import { userOf } from '../../lib/userOf.js';
import { InvestigationError } from '../../contexts/workbench/investigationDraft.js';
import {
  listInvestigations, getInvestigation, createInvestigation, saveInvestigation, deleteInvestigation, deleteProposal,
} from '../../contexts/workbench/investigations.js';

const router = Router();

function fail(res, err, label) {
  if (err instanceof InvestigationError) return res.status(err.status).json({ error: err.message });
  console.error(`${label} failed:`, err?.message);
  return res.status(500).json({ error: `${label} failed` });
}

// Every route: SQL only, and every id in the path a UUID.
function guard(req, res, next) {
  if (!useSql) return res.status(503).json({ error: 'The workbench needs the SQL backend' });
  const ids = [req.params.id, req.params.invId, req.params.pid].filter(v => v !== undefined);
  if (ids.some(v => !UUID_RE.test(v))) return res.status(400).json({ error: 'Invalid ID format' });
  return next();
}

const handle = (label, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { fail(res, err, label); }
};

router.get('/contexts/:id/workbench/investigations', writeContexts, guard, handle('Listing investigations', async (req, res) => {
  res.json({ data: await listInvestigations(db, req.params.id) });
}));

router.post('/contexts/:id/workbench/investigations', writeContexts, guard, handle('Saving the investigation', async (req, res) => {
  res.status(201).json(await createInvestigation(db, req.params.id, req.body ?? {}, userOf(req)));
}));

router.get('/workbench/investigations/:invId', writeContexts, guard, handle('Opening the investigation', async (req, res) => {
  res.json(await getInvestigation(db, req.params.invId));
}));

router.put('/workbench/investigations/:invId', writeContexts, guard, handle('Saving the investigation', async (req, res) => {
  res.json(await saveInvestigation(db, req.params.invId, req.body ?? {}, userOf(req)));
}));

router.delete('/workbench/investigations/:invId', writeContexts, guard, handle('Deleting the investigation', async (req, res) => {
  await deleteInvestigation(db, req.params.invId);
  res.status(204).end();
}));

router.delete('/workbench/investigations/:invId/proposals/:pid', writeContexts, guard, handle('Deleting the proposed role', async (req, res) => {
  await deleteProposal(db, req.params.invId, req.params.pid);
  res.status(204).end();
}));

export default router;
