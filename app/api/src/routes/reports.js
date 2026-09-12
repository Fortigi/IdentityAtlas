// Report API routes.
//
// GET /api/reports                — metadata for every registered report template
// GET /api/reports/:name/rows     — run one template and return its rows
// GET /api/reports/:name/export   — run one template and return it as a download
//
// Content is computed per request, so a re-fetch (the UI's Refresh button) and a
// download are always against the latest data — there are no stored report runs.
// The engine never branches on a report name: `:name` is a registry lookup, and
// the response carries whatever `form` and `columns` the template declares.

import { Router } from 'express';
import { getReport, listReports, reportMetadata } from '../reports/registry.js';
import { EXPORT_FORMAT_NAMES, exportFilename, resolveExportFormat } from '../reports/export.js';

const router = Router();

// One run, one payload — shared by the rows endpoint and the download, so a
// downloaded file can never contain something the screen didn't show.
async function runReport(report, params) {
  const { rows } = await report.run(params, {});
  return {
    ...reportMetadata(report),
    rows,
    total: rows.length,
    generatedAt: new Date().toISOString(),
  };
}

// Use the registry's name, not the raw URL param, so nothing user-controlled
// reaches the log; the client gets a generic message.
function reportFailed(res, report, route, err) {
  console.error(`GET /reports/${report.name}/${route} failed:`, err.message);
  res.status(500).json({ error: 'Failed to run report' });
}

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
    res.json(await runReport(report, req.query || {}));
  } catch (err) {
    reportFailed(res, report, 'rows', err);
  }
});

// GET /api/reports/:name/export?format=csv
// `format` is the download's own parameter; every other query parameter is
// passed through to the template, exactly as the rows endpoint does.
router.get('/reports/:name/export', async (req, res) => {
  const report = getReport(req.params.name);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const { format = 'csv', ...params } = req.query || {};
  const exportFormat = resolveExportFormat(String(format));
  if (!exportFormat) {
    return res.status(400).json({
      error: `Unsupported export format. Supported formats: ${EXPORT_FORMAT_NAMES.join(', ')}`,
    });
  }

  try {
    const payload = await runReport(report, params);
    const filename = exportFilename(report.name, exportFormat.extension, payload.generatedAt);
    res.setHeader('Content-Type', exportFormat.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(exportFormat.serialize(payload));
  } catch (err) {
    reportFailed(res, report, 'export', err);
  }
});

export default router;
