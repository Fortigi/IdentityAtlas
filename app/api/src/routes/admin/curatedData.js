// Curated-data export/import endpoints — /api/admin/export/curated and
// /api/admin/import/curated (the PowerShell Export-/Import-FGCuratedData format).
//
// The data-assembly work lives in ./curatedExport.js (read + group) and
// ./curatedImport.js (resolve/upsert/attach). Extracted from routes/admin.js
// (audit finding C1) and further decomposed for complexity (#1030) — the public
// paths are unchanged and no behaviour differs.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { requirePermission } from '../../middleware/auth.js';
import { fetchExportTags, fetchExportCategories } from './curatedExport.js';
import { importCuratedTag, importCuratedCategory } from './curatedImport.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

const exportBulk = requirePermission('data.export.ui');
const writeCsv   = requirePermission('admin.csv-import');

// ── GET /api/admin/export/curated ────────────────────────────────
// Exports tags (with assignments) and categories (with AP assignments) to JSON.
// Compatible with the PowerShell Export-FGCuratedData / Import-FGCuratedData format.
router.get('/admin/export/curated', exportBulk, async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

  try {
    const pool = await db.getPool();
    const tags = await fetchExportTags(pool);
    const categories = await fetchExportCategories(pool);

    const payload = {
      exportedAt:       new Date().toISOString(),
      version:          '1.0',
      tags,
      categories,
      analystOverrides: [],   // not managed via UI — exported by PowerShell only
    };

    res.setHeader('Content-Disposition', `attachment; filename="FGCuratedData_${new Date().toISOString().slice(0,10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('Export curated data failed:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── POST /api/admin/import/curated ───────────────────────────────
// Imports tags and categories from a JSON file (same format as export).
// Per assignment: GUID match first, then soft-match by displayName
// (+ resourceType for group/resource). Unresolvable assignments are skipped.
router.post('/admin/import/curated', writeCsv, async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

  const { tags = [], categories = [] } = req.body;
  if (!Array.isArray(tags) || !Array.isArray(categories)) {
    return res.status(400).json({ error: 'tags and categories must be arrays' });
  }

  const stats = {
    tagsInserted: 0, tagsSkipped: 0,
    assignmentsInserted: 0, assignmentsSkipped: 0,
    assignmentsSoftMatched: 0, assignmentsNotFound: 0,
    catsInserted: 0, catsSkipped: 0,
    catAssignInserted: 0, catAssignSkipped: 0,
    catAssignSoftMatched: 0, catAssignNotFound: 0,
  };

  try {
    const pool = await db.getPool();

    // Ensure tag + category tables exist, and pull the handler-local bindings the
    // import helpers need. These are dynamic imports so the mock-data path (which
    // never reaches here) doesn't drag them in.
    const { ensureTagTables, ENTITY_TO_TARGET, UUID_RE } = await import('../tags.js');
    const { ensureCategoryTables } = await import('../categories.js');
    const { getOrCreateTagRoot }         = await import('../../bootstrap.js');
    const { recalcMemberCountsForChain } = await import('../../contexts/memberCounts.js');
    const { randomUUID }                 = await import('crypto');
    await ensureTagTables(pool);
    await ensureCategoryTables(pool);

    const tagDeps = {
      ENTITY_TO_TARGET, UUID_RE, getOrCreateTagRoot, recalcMemberCountsForChain, randomUUID,
      createdBy: (req.user && (req.user.email || req.user.upn || req.user.name)) || 'import',
    };
    for (const tag of tags) await importCuratedTag(tag, tagDeps, stats);
    for (const cat of categories) await importCuratedCategory(cat, stats);

    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Import curated data failed:', err.message);
    res.status(500).json({ error: 'Import failed' });
  }
});

export default router;
