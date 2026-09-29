// Entity-lookup routes — what can I pick here, and what is it called?
//
// GET /api/lookups                 — the registered sources
// GET /api/lookups/:source?q=      — options matching a search term
// GET /api/lookups/:source?ids=…   — stored ids turned back into labels
//
// Generic, the same way routes/reports.js is: `:source` is a registry lookup
// and the response carries whatever options that source returned. Nothing here
// names a source, and a guard test fails the PR if it does.
//
// `q` is echoed back. The client renders the answer to the term it is showing,
// and a slower response for an earlier term arriving late must be discardable —
// without the echo, the list flashes results for a term the user has already
// typed past.

import { Router } from 'express';
import { getLookup, listLookups } from '../lookups/registry.js';

const router = Router();

// A search box sends a term per keystroke; these bound what one keystroke can
// ask the database for.
const MAX_TERM = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
// One page of chips is the only thing that needs resolving at once.
const MAX_IDS = 200;

function parseLimit(value) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseIds(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  return parts.map(v => String(v ?? '').trim()).filter(Boolean).slice(0, MAX_IDS);
}

// GET /api/lookups
router.get('/lookups', (req, res) => {
  const data = listLookups().map(s => ({ name: s.name, displayName: s.displayName }));
  res.json({ data, total: data.length });
});

// GET /api/lookups/:source
router.get('/lookups/:source', async (req, res) => {
  const source = getLookup(req.params.source);
  if (!source) return res.status(404).json({ error: 'Lookup source not found' });

  const q = String(req.query.q ?? '').trim().slice(0, MAX_TERM);
  const ids = req.query.ids === undefined ? null : parseIds(req.query.ids);

  try {
    // Resolving ids and searching are the same shape of answer, so they are the
    // same endpoint: the client asks by whichever it has.
    const data = ids
      ? (source.resolve ? await source.resolve({ ids }) : [])
      : await source.search({ q, limit: parseLimit(req.query.limit) });
    res.json({ source: source.name, q, data, total: data.length });
  } catch (err) {
    // The source name comes from the registry, never from the raw URL, so
    // nothing user-controlled reaches the log.
    console.error(`GET /lookups/${source.name} failed:`, err.message);
    res.status(500).json({ error: 'Failed to run lookup' });
  }
});

export default router;
