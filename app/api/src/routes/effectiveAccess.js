// Effective-access HTTP surface.
//
// P1 exposes the resolution primitive: the effective access of ONE principal on ONE resource
// (direct grants + grants reached via group membership). P2 adds the down-expansion forms
// (effective access AT a node, including capabilities inherited via Contains).
// See docs/architecture/effective-access-engine.md §12.

import { Router } from 'express';
import { effectiveAccess, effectiveAccessAtNode } from '../effectiveAccess/engine.js';

const router = Router();

// What to log for an unexpected 500. We deliberately do NOT log err.message: a Postgres error
// echoes the offending input (e.g. a malformed id), so the message can carry user-controlled
// text — logging it raw would allow forged log entries (log injection). We surface only the
// SQLSTATE code / short error name, and ONLY when it matches a strict alphanumeric shape —
// which provably cannot contain the CR/LF that a forged log entry needs. The regex guard is
// what makes this safe (and is recognised as a sanitizer by static analysis).
function errLabel(err) {
  const label = err && (err.code || err.name);
  return typeof label === 'string' && /^[A-Za-z0-9]{1,16}$/.test(label) ? label : 'error';
}

// Shared handler for the two down-expansion forms (resource-centric and principal-centric).
// Returns the capabilities a principal effectively holds AT a node, including those inherited
// from ancestor nodes via Contains (P2). One row per capability.
async function handleAtNode(nodeId, principalId, policy, res) {
  if (!nodeId || !principalId) {
    return res.status(400).json({ error: 'both a node id and a principal id are required' });
  }
  try {
    const result = await effectiveAccessAtNode(nodeId, principalId, policy ? { policy } : {});
    return res.json(result);
  } catch (err) {
    if (/Unknown resolution policy/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('effective-access at-node failed:', errLabel(err));
    return res.status(500).json({ error: 'effective-access failed' });
  }
}

// GET /api/resource/:id/effective-access?principalId=&policy=
router.get('/resource/:id/effective-access', (req, res) =>
  handleAtNode(String(req.params.id), req.query.principalId ? String(req.query.principalId) : '', req.query.policy ? String(req.query.policy) : '', res),
);

// GET /api/principal/:id/effective-access?node=&policy=
router.get('/principal/:id/effective-access', (req, res) =>
  handleAtNode(req.query.node ? String(req.query.node) : '', String(req.params.id), req.query.policy ? String(req.query.policy) : '', res),
);

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
    console.error('effective-access resolve failed:', errLabel(err));
    return res.status(500).json({ error: 'effective-access resolve failed' });
  }
});

export default router;
