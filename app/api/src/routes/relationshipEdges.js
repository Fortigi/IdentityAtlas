// GET /api/relationship-edges?entity=Resource|Principal
//
// Lists the relationship-filter edges offered for an entity, each with a live
// `available` flag (whether any data of that edge's mechanism exists). The UI
// uses `available` to hide/annotate edges from opt-in crawler phases (e.g. the
// Sponsor edge is unavailable until the Principal Relationships phase has run).
//
// Availability is computed from the code catalog's probes at request time — the
// catalog is the single source of truth (no DB view to drift). A short TTL cache
// keeps it cheap under the list page's edge-picker traffic.

import { Router } from 'express';
import { computeAvailability } from '../relationships/relationshipSql.js';
import { ENTITY_TO_TARGET } from './tags.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

const VALID_ENTITIES = new Set(['Resource', 'Principal']);
const TTL_MS = 5 * 60 * 1000; // mirror columnCache's 5-minute TTL
const cache = new Map(); // entity -> { at, edges }

router.get('/relationship-edges', async (req, res) => {
  try {
    // Accept either the target name (Resource/Principal) or a list entityType
    // (resource/user) so both the UI and internal callers can ask naturally.
    const raw = String(req.query.entity || '').trim();
    const entity = VALID_ENTITIES.has(raw) ? raw : ENTITY_TO_TARGET[raw];
    if (!VALID_ENTITIES.has(entity)) {
      return res.status(400).json({ error: 'entity must be Resource or Principal' });
    }
    if (!useSql) return res.json({ edges: [] });

    const hit = cache.get(entity);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return res.json({ edges: hit.edges });
    }
    const edges = await computeAvailability(entity, (sql) => db.query(sql));
    cache.set(entity, { at: Date.now(), edges });
    res.json({ edges });
  } catch (err) {
    console.error('GET /relationship-edges failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
