// Report API routes.
//
// GET /api/reports              — metadata for every registered report template
// GET /api/reports/:name/rows   — run one template and return its rows
//
// Content is computed per request, so a re-fetch (the UI's Refresh button) is
// always against the latest data — there are no stored report runs. The engine
// never branches on a report name: `:name` is a registry lookup, and the
// response carries whatever `form` and `columns` the template declares.

import { Router } from 'express';
import { getReport, listReports, reportMetadata } from '../reports/registry.js';

const router = Router();

// GET /api/reports
router.get('/reports', (req, res) => {
  const data = listReports().map(reportMetadata);
  res.json({ data, total: data.length });
});

// GET /api/reports/:name/rows
router.get('/reports/:name/rows', async (req, res) => {
  const report = getReport(req.params.name);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  try {
    const { rows } = await report.run(req.query || {}, {});
    res.json({
      ...reportMetadata(report),
      rows,
      total: rows.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Use the registry's name, not the raw URL param, so nothing user-controlled
    // reaches the log; the client gets a generic message.
    console.error(`GET /reports/${report.name}/rows failed:`, err.message);
    res.status(500).json({ error: 'Failed to run report' });
  }
});

export default router;
