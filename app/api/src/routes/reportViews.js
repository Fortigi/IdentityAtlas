// Saved report views — API routes.
//
//   GET    /api/report-views/:id   one view, for editing (any signed-in reader)
//   POST   /api/report-views       save a new view             (data.write.reports)
//   PUT    /api/report-views/:id   change a view's name/params (data.write.reports)
//   DELETE /api/report-views/:id   delete a view               (data.write.reports)
//
// Views are listed and run through the regular /api/reports routes, as reports
// named `view-<id>` — see reports/views.js. Unlike custom reports these need no
// feature flag: a view only stores parameters for a report everyone already has.

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { userOf } from '../nlreports/assistantHttp.js';
import {
  VIEW_PREFIX, createView, deleteView, getView, isViewId, prepareView, updateView,
} from '../reports/views.js';

const router = Router();
const writeGate = requirePermission('data.write.reports');

/** The stored row as the API returns it, with the report name a client opens it by. */
function toBody(row) {
  return {
    id: row.id,
    report: `${VIEW_PREFIX}${row.id}`,
    reportName: row.reportName,
    name: row.name,
    description: row.description,
    params: row.params || {},
    createdBy: row.createdBy || null,
    updatedBy: row.updatedBy || null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt || null,
  };
}

function fail(res, route, err) {
  console.error(`report-views ${route} failed:`, err.message);
  res.status(500).json({ error: 'Request failed' });
}

const CONFLICT = { error: 'A view with that name already exists' };

router.get('/report-views/:id', async (req, res) => {
  if (!isViewId(req.params.id)) return res.status(404).json({ error: 'View not found' });
  try {
    const row = await getView(req.params.id);
    if (!row) return res.status(404).json({ error: 'View not found' });
    res.json(toBody(row));
  } catch (err) {
    fail(res, 'get', err);
  }
});

router.post('/report-views', writeGate, async (req, res) => {
  const { errors, value } = prepareView(req.body);
  if (errors) return res.status(400).json({ error: errors.join('; '), errors });
  try {
    const row = await createView(value, userOf(req));
    if (row?.conflict) return res.status(409).json(CONFLICT);
    res.status(201).json(toBody(row));
  } catch (err) {
    fail(res, 'create', err);
  }
});

router.put('/report-views/:id', writeGate, async (req, res) => {
  if (!isViewId(req.params.id)) return res.status(404).json({ error: 'View not found' });
  try {
    const existing = await getView(req.params.id);
    if (!existing) return res.status(404).json({ error: 'View not found' });
    const { errors, value } = prepareView(req.body, { existingReportName: existing.reportName });
    if (errors) return res.status(400).json({ error: errors.join('; '), errors });
    const row = await updateView(req.params.id, value, userOf(req));
    if (row?.conflict) return res.status(409).json(CONFLICT);
    if (!row) return res.status(404).json({ error: 'View not found' });
    res.json(toBody(row));
  } catch (err) {
    fail(res, 'update', err);
  }
});

router.delete('/report-views/:id', writeGate, async (req, res) => {
  try {
    if (!(await deleteView(req.params.id))) return res.status(404).json({ error: 'View not found' });
    res.status(204).end();
  } catch (err) {
    fail(res, 'delete', err);
  }
});

export default router;
