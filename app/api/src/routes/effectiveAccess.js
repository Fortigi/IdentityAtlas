// Effective-access HTTP surface.
//
// P1 exposes the resolution primitive: the effective access of ONE principal on ONE resource
// (direct grants + grants reached via group membership). The richer "expand a resource / a
// principal" forms in the spec depend on containment down-expansion (P2) and the nested-group
// shim (slice 6); they land with those. See docs/architecture/effective-access-engine.md §12.

import { Router } from 'express';
import { effectiveAccess } from '../effectiveAccess/engine.js';

const router = Router();

// GET /api/effective-access/resolve?resourceId=&principalId=&policy=
router.get('/effective-access/resolve', async (req, res) => {
  const resourceId = req.query.resourceId ? String(req.query.resourceId) : '';
  const principalId = req.query.principalId ? String(req.query.principalId) : '';
  if (!resourceId || !principalId) {
    return res.status(400).json({ error: 'resourceId and principalId are required query parameters' });
  }
  const opts = req.query.policy ? { policy: String(req.query.policy) } : {};
  try {
    const result = await effectiveAccess(resourceId, principalId, opts);
    return res.json({ resourceId, principalId, ...result });
  } catch (err) {
    // An unknown policy is caller error (bad input), not a server fault.
    if (/Unknown resolution policy/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('effective-access resolve failed:', err.message);
    return res.status(500).json({ error: 'effective-access resolve failed' });
  }
});

export default router;
