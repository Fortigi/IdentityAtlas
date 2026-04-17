// Identity Atlas v5 — Terminology dictionary routes.
//
// Manages a dictionary of abbreviations, codes, and domain terms found in
// authorization names. Each term has a description, business process links,
// correlations to related terms (with strength scores), and optional proposed
// additions to risk classifiers — all requiring admin review before activation.
//
// Endpoints:
//   GET    /api/admin/dictionary/terms                  list / search
//   POST   /api/admin/dictionary/terms                  create manually
//   GET    /api/admin/dictionary/terms/:id              get one term with correlations + links
//   PUT    /api/admin/dictionary/terms/:id              update term
//   DELETE /api/admin/dictionary/terms/:id              delete term
//   POST   /api/admin/dictionary/terms/:id/status       approve or reject a term
//
//   GET    /api/admin/dictionary/correlations           list pending correlations
//   POST   /api/admin/dictionary/correlations           create correlation manually
//   PUT    /api/admin/dictionary/correlations/:id       update strength / type
//   DELETE /api/admin/dictionary/correlations/:id       delete
//   POST   /api/admin/dictionary/correlations/:id/status  approve or reject
//
//   GET    /api/admin/dictionary/classifier-links       list pending classifier links
//   POST   /api/admin/dictionary/classifier-links/:id/status  approve or reject
//
//   POST   /api/admin/dictionary/enrich                 LLM enrich one term
//   POST   /api/admin/dictionary/correlate              LLM correlate one term against dictionary
//   POST   /api/admin/dictionary/mine                   LLM mine terms from resource/group names

import { Router } from 'express';
import * as db from '../db/connection.js';
import { chatWithSavedConfig } from '../llm/service.js';
import {
  enrichTermPrompt,
  correlateTermsPrompt,
  mineTermsPrompt,
  parseJsonResponse,
} from '../llm/dictionaryPrompts.js';
import { searchTerm } from '../search/webSearch.js';

const router = Router();

// ─── Terms ────────────────────────────────────────────────────────────────────

// GET /api/admin/dictionary/terms?q=&status=&limit=50&offset=0
router.get('/admin/dictionary/terms', async (req, res) => {
  try {
    const q      = req.query.q      ? `%${req.query.q}%` : null;
    const status = req.query.status || null;
    const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0,  0);

    const { rows } = await db.query(
      `SELECT t.*,
              COUNT(c.id) FILTER (WHERE c.status = 'approved') AS "correlationCount",
              COUNT(l.id) FILTER (WHERE l.status = 'pending')  AS "pendingLinks"
         FROM "DictionaryTerms" t
         LEFT JOIN "DictionaryCorrelations" c
                ON c."termId" = t.id OR c."relatedTermId" = t.id
         LEFT JOIN "DictionaryClassifierLinks" l ON l."termId" = t.id
        WHERE ($1::text IS NULL OR lower(t.term) LIKE lower($1))
          AND ($2::text IS NULL OR t.status = $2)
        GROUP BY t.id
        ORDER BY t.term
        LIMIT $3 OFFSET $4`,
      [q, status, limit, offset]
    );

    const total = await db.queryOne(
      `SELECT COUNT(*) AS n FROM "DictionaryTerms"
        WHERE ($1::text IS NULL OR lower(term) LIKE lower($1))
          AND ($2::text IS NULL OR status = $2)`,
      [q, status]
    );

    res.json({ terms: rows, total: parseInt(total.n, 10), limit, offset });
  } catch (err) {
    console.error('GET /admin/dictionary/terms failed:', err.message);
    res.status(500).json({ error: 'Failed to list dictionary terms' });
  }
});

// POST /api/admin/dictionary/terms
router.post('/admin/dictionary/terms', async (req, res) => {
  try {
    const { term, description, businessProcesses, status } = req.body || {};
    if (!term || typeof term !== 'string' || term.trim().length === 0) {
      return res.status(400).json({ error: 'term is required' });
    }
    if (term.trim().length > 200) {
      return res.status(400).json({ error: 'term must be ≤ 200 characters' });
    }
    const user = req.user?.preferred_username || req.user?.name || 'anonymous';
    const row = await db.queryOne(
      `INSERT INTO "DictionaryTerms"
         ("term", "description", "businessProcesses", "source", "status", "createdBy")
       VALUES ($1, $2, $3, 'manual', $4, $5)
       RETURNING *`,
      [
        term.trim(),
        description || null,
        JSON.stringify(businessProcesses || []),
        status === 'approved' ? 'approved' : 'pending',
        user,
      ]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Term already exists' });
    console.error('POST /admin/dictionary/terms failed:', err.message);
    res.status(500).json({ error: 'Failed to create term' });
  }
});

// GET /api/admin/dictionary/terms/:id
router.get('/admin/dictionary/terms/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const term = await db.queryOne(
      `SELECT * FROM "DictionaryTerms" WHERE id = $1`, [id]
    );
    if (!term) return res.status(404).json({ error: 'Term not found' });

    const { rows: correlations } = await db.query(
      `SELECT c.*,
              CASE WHEN c."termId" = $1 THEN t2.term ELSE t1.term END AS "relatedTerm",
              CASE WHEN c."termId" = $1 THEN t2.description ELSE t1.description END AS "relatedDescription",
              CASE WHEN c."termId" = $1 THEN c."relatedTermId" ELSE c."termId" END AS "relatedId"
         FROM "DictionaryCorrelations" c
         JOIN "DictionaryTerms" t1 ON t1.id = c."termId"
         JOIN "DictionaryTerms" t2 ON t2.id = c."relatedTermId"
        WHERE c."termId" = $1 OR c."relatedTermId" = $1
        ORDER BY c.strength DESC, c."correlationType"`,
      [id]
    );

    const { rows: classifierLinks } = await db.query(
      `SELECT * FROM "DictionaryClassifierLinks" WHERE "termId" = $1 ORDER BY "createdAt" DESC`,
      [id]
    );

    res.json({ ...term, correlations, classifierLinks });
  } catch (err) {
    console.error('GET /admin/dictionary/terms/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to get term' });
  }
});

// PUT /api/admin/dictionary/terms/:id
router.put('/admin/dictionary/terms/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { description, businessProcesses } = req.body || {};
    const row = await db.queryOne(
      `UPDATE "DictionaryTerms"
          SET "description"       = COALESCE($2, "description"),
              "businessProcesses" = COALESCE($3, "businessProcesses"),
              "updatedAt"         = now() AT TIME ZONE 'utc'
        WHERE id = $1
        RETURNING *`,
      [id, description ?? null, businessProcesses ? JSON.stringify(businessProcesses) : null]
    );
    if (!row) return res.status(404).json({ error: 'Term not found' });
    res.json(row);
  } catch (err) {
    console.error('PUT /admin/dictionary/terms/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to update term' });
  }
});

// DELETE /api/admin/dictionary/terms/:id
router.delete('/admin/dictionary/terms/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const row = await db.queryOne(
      `DELETE FROM "DictionaryTerms" WHERE id = $1 RETURNING id`, [id]
    );
    if (!row) return res.status(404).json({ error: 'Term not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/dictionary/terms/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete term' });
  }
});

// POST /api/admin/dictionary/terms/:id/status  { status: 'approved'|'rejected' }
router.post('/admin/dictionary/terms/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or rejected' });
    }
    const row = await db.queryOne(
      `UPDATE "DictionaryTerms"
          SET "status" = $2, "updatedAt" = now() AT TIME ZONE 'utc'
        WHERE id = $1
        RETURNING *`,
      [id, status]
    );
    if (!row) return res.status(404).json({ error: 'Term not found' });
    res.json(row);
  } catch (err) {
    console.error('POST /admin/dictionary/terms/:id/status failed:', err.message);
    res.status(500).json({ error: 'Failed to update term status' });
  }
});

// ─── Correlations ─────────────────────────────────────────────────────────────

// GET /api/admin/dictionary/correlations?status=pending
router.get('/admin/dictionary/correlations', async (req, res) => {
  try {
    const status = req.query.status || null;
    const { rows } = await db.query(
      `SELECT c.*, t1.term AS "term", t2.term AS "relatedTerm"
         FROM "DictionaryCorrelations" c
         JOIN "DictionaryTerms" t1 ON t1.id = c."termId"
         JOIN "DictionaryTerms" t2 ON t2.id = c."relatedTermId"
        WHERE $1::text IS NULL OR c.status = $1
        ORDER BY c."createdAt" DESC`,
      [status]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /admin/dictionary/correlations failed:', err.message);
    res.status(500).json({ error: 'Failed to list correlations' });
  }
});

// POST /api/admin/dictionary/correlations
router.post('/admin/dictionary/correlations', async (req, res) => {
  try {
    const { termId, relatedTermId, strength, correlationType, status } = req.body || {};
    if (!termId || !relatedTermId) {
      return res.status(400).json({ error: 'termId and relatedTermId are required' });
    }
    const t  = parseInt(termId,        10);
    const rt = parseInt(relatedTermId, 10);
    if (isNaN(t) || isNaN(rt)) return res.status(400).json({ error: 'Invalid term ids' });
    if (t === rt) return res.status(400).json({ error: 'A term cannot correlate with itself' });

    const s = parseFloat(strength ?? 1.0);
    if (isNaN(s) || s < 0 || s > 1) return res.status(400).json({ error: 'strength must be 0.0–1.0' });

    const user = req.user?.preferred_username || req.user?.name || 'anonymous';
    const row = await db.queryOne(
      `INSERT INTO "DictionaryCorrelations"
         ("termId", "relatedTermId", "strength", "correlationType", "source", "status", "createdBy")
       VALUES ($1, $2, $3, $4, 'manual', $5, $6)
       RETURNING *`,
      [t, rt, s, correlationType || 'synonym', status === 'approved' ? 'approved' : 'pending', user]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Correlation already exists' });
    console.error('POST /admin/dictionary/correlations failed:', err.message);
    res.status(500).json({ error: 'Failed to create correlation' });
  }
});

// PUT /api/admin/dictionary/correlations/:id
router.put('/admin/dictionary/correlations/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { strength, correlationType } = req.body || {};
    const s = strength !== undefined ? parseFloat(strength) : null;
    if (s !== null && (isNaN(s) || s < 0 || s > 1)) {
      return res.status(400).json({ error: 'strength must be 0.0–1.0' });
    }

    const row = await db.queryOne(
      `UPDATE "DictionaryCorrelations"
          SET "strength"        = COALESCE($2, "strength"),
              "correlationType" = COALESCE($3, "correlationType")
        WHERE id = $1
        RETURNING *`,
      [id, s, correlationType ?? null]
    );
    if (!row) return res.status(404).json({ error: 'Correlation not found' });
    res.json(row);
  } catch (err) {
    console.error('PUT /admin/dictionary/correlations/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to update correlation' });
  }
});

// DELETE /api/admin/dictionary/correlations/:id
router.delete('/admin/dictionary/correlations/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const row = await db.queryOne(
      `DELETE FROM "DictionaryCorrelations" WHERE id = $1 RETURNING id`, [id]
    );
    if (!row) return res.status(404).json({ error: 'Correlation not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/dictionary/correlations/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete correlation' });
  }
});

// POST /api/admin/dictionary/correlations/:id/status
router.post('/admin/dictionary/correlations/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or rejected' });
    }
    const row = await db.queryOne(
      `UPDATE "DictionaryCorrelations" SET "status" = $2 WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (!row) return res.status(404).json({ error: 'Correlation not found' });
    res.json(row);
  } catch (err) {
    console.error('POST /admin/dictionary/correlations/:id/status failed:', err.message);
    res.status(500).json({ error: 'Failed to update correlation status' });
  }
});

// ─── Classifier Links ─────────────────────────────────────────────────────────

// GET /api/admin/dictionary/classifier-links?status=pending
router.get('/admin/dictionary/classifier-links', async (req, res) => {
  try {
    const status = req.query.status || null;
    const { rows } = await db.query(
      `SELECT l.*, t.term
         FROM "DictionaryClassifierLinks" l
         JOIN "DictionaryTerms" t ON t.id = l."termId"
        WHERE $1::text IS NULL OR l.status = $1
        ORDER BY l."createdAt" DESC`,
      [status]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /admin/dictionary/classifier-links failed:', err.message);
    res.status(500).json({ error: 'Failed to list classifier links' });
  }
});

// POST /api/admin/dictionary/classifier-links/:id/status
router.post('/admin/dictionary/classifier-links/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or rejected' });
    }
    const user = req.user?.preferred_username || req.user?.name || 'anonymous';
    const row = await db.queryOne(
      `UPDATE "DictionaryClassifierLinks"
          SET "status"     = $2,
              "reviewedBy" = $3,
              "reviewedAt" = now() AT TIME ZONE 'utc'
        WHERE id = $1
        RETURNING *`,
      [id, status, user]
    );
    if (!row) return res.status(404).json({ error: 'Classifier link not found' });
    res.json(row);
  } catch (err) {
    console.error('POST /admin/dictionary/classifier-links/:id/status failed:', err.message);
    res.status(500).json({ error: 'Failed to update classifier link status' });
  }
});

// GET /api/admin/dictionary/summary — counts for the toolbar badge
router.get('/admin/dictionary/summary', async (_req, res) => {
  try {
    const row = await db.queryOne(
      `SELECT
         COUNT(*) FILTER (WHERE t.status = 'pending')                               AS "pendingTerms",
         COUNT(*) FILTER (WHERE c.status = 'pending')                               AS "pendingCorrelations",
         COUNT(*) FILTER (WHERE l.status = 'approved' AND l."appliedAt" IS NULL)    AS "unappliedLinks"
         FROM "DictionaryTerms" t
         FULL JOIN "DictionaryCorrelations" c ON false
         FULL JOIN "DictionaryClassifierLinks" l ON false`
    );
    // Simpler: three separate counts
    const [terms, corrs, links] = await Promise.all([
      db.queryOne(`SELECT COUNT(*) AS n FROM "DictionaryTerms" WHERE status='pending'`),
      db.queryOne(`SELECT COUNT(*) AS n FROM "DictionaryCorrelations" WHERE status='pending'`),
      db.queryOne(`SELECT COUNT(*) AS n FROM "DictionaryClassifierLinks" WHERE status='approved' AND "appliedAt" IS NULL`),
    ]);
    res.json({
      pendingTerms:        parseInt(terms?.n  || 0, 10),
      pendingCorrelations: parseInt(corrs?.n  || 0, 10),
      unappliedLinks:      parseInt(links?.n  || 0, 10),
    });
  } catch (err) {
    console.error('GET /admin/dictionary/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

// POST /api/admin/dictionary/apply-classifier-links
// Merges all approved, unapplied DictionaryClassifierLink patterns into the
// active RiskClassifiers. Saves a new classifier version so history is preserved.
// Returns { ok, appliedCount, skippedCount, newClassifierId }.
router.post('/admin/dictionary/apply-classifier-links', async (req, res) => {
  try {
    // 1. Load approved unapplied links
    const { rows: links } = await db.query(
      `SELECT l.*, t.term
         FROM "DictionaryClassifierLinks" l
         JOIN "DictionaryTerms" t ON t.id = l."termId"
        WHERE l.status = 'approved' AND l."appliedAt" IS NULL`
    );
    if (links.length === 0) {
      return res.json({ ok: true, appliedCount: 0, skippedCount: 0, newClassifierId: null, message: 'Nothing to apply' });
    }

    // 2. Load active classifier
    const active = await db.queryOne(
      `SELECT * FROM "RiskClassifiers" WHERE "isActive" = true ORDER BY id DESC LIMIT 1`
    );
    if (!active) {
      return res.status(400).json({ error: 'No active classifier found. Generate classifiers first via Admin → Risk Scoring.' });
    }

    const classifiers = typeof active.classifiers === 'string'
      ? JSON.parse(active.classifiers)
      : active.classifiers;

    // All classifier arrays in one flat map for lookup: label (lowercase) → classifier object
    const allLists = ['groupClassifiers', 'userClassifiers', 'agentClassifiers'];
    const byLabel = new Map();
    for (const listKey of allLists) {
      for (const c of (classifiers[listKey] || [])) {
        byLabel.set(c.label?.toLowerCase(), { listKey, classifier: c });
      }
    }

    let applied = 0;
    let skipped = 0;
    const appliedIds = [];

    for (const link of links) {
      const patterns = Array.isArray(link.proposedPatterns)
        ? link.proposedPatterns
        : JSON.parse(link.proposedPatterns || '[]');

      if (patterns.length === 0) { skipped++; continue; }

      const entry = byLabel.get(link.classifierLabel?.toLowerCase());
      if (!entry) {
        // Classifier label no longer exists in the active set — skip
        skipped++;
        continue;
      }

      const existing = new Set(entry.classifier.patterns || []);
      let added = 0;
      for (const p of patterns) {
        if (!existing.has(p)) { existing.add(p); added++; }
      }
      entry.classifier.patterns = [...existing];
      if (added > 0) applied++;
      appliedIds.push(link.id);
    }

    if (applied === 0) {
      return res.json({ ok: true, appliedCount: 0, skippedCount: skipped, newClassifierId: null, message: 'All patterns already present in the active classifier' });
    }

    // 3. Insert new classifier version (trigger deactivates the old one)
    const user = req.user?.preferred_username || req.user?.name || 'system';
    const newRow = await db.queryOne(
      `INSERT INTO "RiskClassifiers"
         ("profileId", "displayName", "classifiers", "llmProvider", "llmModel", "version", "isActive", "createdBy")
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)
       RETURNING id`,
      [
        active.profileId,
        active.displayName,
        JSON.stringify(classifiers),
        active.llmProvider,
        active.llmModel,
        (parseInt(active.version, 10) || 1) + 1,
        user,
      ]
    );

    // 4. Mark all links as applied
    await db.query(
      `UPDATE "DictionaryClassifierLinks"
          SET "appliedAt" = now() AT TIME ZONE 'utc'
        WHERE id = ANY($1::bigint[])`,
      [appliedIds]
    );

    res.json({
      ok:              true,
      appliedCount:    applied,
      skippedCount:    skipped,
      newClassifierId: newRow.id,
    });
  } catch (err) {
    console.error('POST /admin/dictionary/apply-classifier-links failed:', err.message);
    res.status(500).json({ error: err.message || 'Apply failed' });
  }
});

// ─── LLM Operations ───────────────────────────────────────────────────────────

// POST /api/admin/dictionary/enrich  { termId }
// Calls the LLM (with web search) to generate a description, business processes,
// and classifier link proposals for an existing term. Saves results as pending.
router.post('/admin/dictionary/enrich', async (req, res) => {
  try {
    const termId = parseInt(req.body?.termId, 10);
    if (isNaN(termId)) return res.status(400).json({ error: 'termId is required' });

    const term = await db.queryOne(
      `SELECT * FROM "DictionaryTerms" WHERE id = $1`, [termId]
    );
    if (!term) return res.status(404).json({ error: 'Term not found' });

    const activeClassifiers = await loadActiveClassifiers();
    const searchSnippets    = await searchTerm(term.term);

    const promptArgs = enrichTermPrompt({
      term:             term.term,
      searchSnippets,
      activeClassifiers,
    });

    const result  = await chatWithSavedConfig(promptArgs);
    const parsed  = parseJsonResponse(result.text);

    // Persist description + business processes back onto the term (overwrite)
    await db.query(
      `UPDATE "DictionaryTerms"
          SET "description"       = $2,
              "businessProcesses" = $3,
              "updatedAt"         = now() AT TIME ZONE 'utc'
        WHERE id = $1`,
      [termId, parsed.description || null, JSON.stringify(parsed.businessProcesses || [])]
    );

    // Insert classifier link proposals as pending
    const links = [];
    for (const link of (parsed.classifierLinks || [])) {
      if (!link.classifierLabel || !Array.isArray(link.proposedPatterns) || link.proposedPatterns.length === 0) continue;
      const saved = await db.queryOne(
        `INSERT INTO "DictionaryClassifierLinks"
           ("termId", "classifierLabel", "classifierDomain", "proposedPatterns")
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [termId, link.classifierLabel, link.classifierDomain || null, JSON.stringify(link.proposedPatterns)]
      );
      links.push(saved);
    }

    res.json({
      ok:         true,
      description: parsed.description,
      businessProcesses: parsed.businessProcesses,
      classifierLinks: links,
      searchSnippetCount: searchSnippets.length,
    });
  } catch (err) {
    console.error('POST /admin/dictionary/enrich failed:', err.message);
    res.status(500).json({ error: err.message || 'Enrichment failed' });
  }
});

// POST /api/admin/dictionary/correlate  { termId }
// LLM proposes correlations between this term and all other approved terms.
router.post('/admin/dictionary/correlate', async (req, res) => {
  try {
    const termId = parseInt(req.body?.termId, 10);
    if (isNaN(termId)) return res.status(400).json({ error: 'termId is required' });

    const term = await db.queryOne(
      `SELECT * FROM "DictionaryTerms" WHERE id = $1`, [termId]
    );
    if (!term) return res.status(404).json({ error: 'Term not found' });

    const { rows: candidates } = await db.query(
      `SELECT id, term, description FROM "DictionaryTerms"
        WHERE id <> $1 AND status = 'approved'
        ORDER BY term
        LIMIT 200`,
      [termId]
    );

    if (candidates.length === 0) {
      return res.json({ ok: true, proposals: [], message: 'No approved terms to correlate against' });
    }

    const promptArgs = correlateTermsPrompt({ term: term.term, candidates });
    const result     = await chatWithSavedConfig(promptArgs);
    const parsed     = parseJsonResponse(result.text);

    if (!Array.isArray(parsed)) {
      return res.status(502).json({ error: 'LLM returned unexpected format' });
    }

    // Match proposed terms back to candidate ids and insert as pending
    const candidateMap = Object.fromEntries(candidates.map(c => [c.term.toLowerCase(), c.id]));
    const saved = [];

    for (const proposal of parsed) {
      const relatedId = candidateMap[proposal.term?.toLowerCase()];
      if (!relatedId) continue;

      const s = parseFloat(proposal.strength ?? 0.5);
      if (isNaN(s) || s < 0 || s > 1) continue;

      try {
        const row = await db.queryOne(
          `INSERT INTO "DictionaryCorrelations"
             ("termId", "relatedTermId", "strength", "correlationType", "source", "status")
           VALUES ($1, $2, $3, $4, 'llm', 'pending')
           ON CONFLICT ("termId", "relatedTermId") DO NOTHING
           RETURNING *`,
          [termId, relatedId, s, proposal.correlationType || 'related']
        );
        if (row) saved.push({ ...row, relatedTerm: proposal.term });
      } catch {
        // Ignore individual insert failures (e.g. reverse pair already exists)
      }
    }

    res.json({ ok: true, proposals: saved });
  } catch (err) {
    console.error('POST /admin/dictionary/correlate failed:', err.message);
    res.status(500).json({ error: err.message || 'Correlation failed' });
  }
});

// POST /api/admin/dictionary/mine  { limit?: 500 }
// Scans existing resource and group display names, extracts candidate terms,
// and adds new ones as pending for admin review.
router.post('/admin/dictionary/mine', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body?.limit, 10) || 500, 2000);

    const { rows } = await db.query(
      `(SELECT "displayName" FROM "Resources"  WHERE "displayName" IS NOT NULL LIMIT $1)
       UNION ALL
       (SELECT "displayName" FROM "Principals" WHERE "displayName" IS NOT NULL LIMIT $1)`,
      [limit]
    );

    const names = [...new Set(rows.map(r => r.displayName).filter(Boolean))].slice(0, limit);
    if (names.length === 0) {
      return res.json({ ok: true, added: 0, message: 'No names found in database' });
    }

    const promptArgs = mineTermsPrompt({ names });
    const result     = await chatWithSavedConfig(promptArgs);
    const parsed     = parseJsonResponse(result.text);

    if (!Array.isArray(parsed)) {
      return res.status(502).json({ error: 'LLM returned unexpected format' });
    }

    let added = 0;
    for (const item of parsed) {
      if (!item.term || typeof item.term !== 'string') continue;
      const t = item.term.trim().slice(0, 200);
      if (!t) continue;

      try {
        const row = await db.queryOne(
          `INSERT INTO "DictionaryTerms" ("term", "source", "status")
           VALUES ($1, 'mined', 'pending')
           ON CONFLICT ("term") DO NOTHING
           RETURNING id`,
          [t]
        );
        if (row) added++;
      } catch {
        // Ignore individual insert failures
      }
    }

    res.json({ ok: true, added, namesScanned: names.length, candidatesFound: parsed.length });
  } catch (err) {
    console.error('POST /admin/dictionary/mine failed:', err.message);
    res.status(500).json({ error: err.message || 'Mining failed' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadActiveClassifiers() {
  try {
    const row = await db.queryOne(
      `SELECT "classifiers" FROM "RiskClassifiers" WHERE "isActive" = true ORDER BY id DESC LIMIT 1`
    );
    if (!row) return [];
    const json = typeof row.classifiers === 'string' ? JSON.parse(row.classifiers) : row.classifiers;
    return [
      ...(json.groupClassifiers || []),
      ...(json.userClassifiers  || []),
      ...(json.agentClassifiers || []),
    ].map(c => ({ id: c.id, label: c.label, domain: c.domain }));
  } catch {
    return [];
  }
}

export default router;
