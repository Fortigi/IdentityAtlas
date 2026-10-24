// Adjust tree — /api/context-trees/...
//
// A generated or imported tree with the analyst's corrections on top. Reads are
// open to every signed-in user like the other context reads; writes need
// data.write.contexts. Design: docs/architecture/adjust-tree.md.
//
//   GET    /context-trees/resolve?contextId=        which tree a context is in
//   GET    /context-trees/:key                      the tree with its marks
//   GET    /context-trees/:key/adjustments          the log
//   POST   /context-trees/:key/adjustments          add one (applied at once)
//   DELETE /context-trees/:key/adjustments/:id      undo
//   POST   /context-trees/:key/adjustments/:id/redo
//   POST   /context-trees/:key/adjustments/:id/follow  accept the proposed rename
//   GET    /context-trees/:key/attention
//   GET    /context-trees/:key/units/:unitId/split-options

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE, writeContexts } from './shared.js';
import { parseTreeKey } from '../../contexts/adjustments/treeKey.js';
import { treeView, adjustmentsView, resolveTree } from '../../contexts/adjustments/view.js';
import { attentionView, splitOptions } from '../../contexts/adjustments/attention.js';
import { createAdjustment, undoAdjustment, redoAdjustment, followAdjustment } from '../../contexts/adjustments/service.js';

const router = Router();

const who = (req) => (req.user && (req.user.email || req.user.upn || req.user.name)) || 'unknown';

// Common guard: SQL configured, the key well-formed. Returns false when it answered.
function guard(req, res) {
  if (!useSql) { res.status(503).json({ error: 'SQL not configured' }); return false; }
  if (!parseTreeKey(req.params.key)) { res.status(400).json({ error: 'Invalid tree key' }); return false; }
  if (req.params.id !== undefined && !UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid adjustment id' }); return false; }
  return true;
}

function fail(res, err, what) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${what} failed:`, err.message);
  return res.status(500).json({ error: `Failed to ${what}` });
}

// A read that returns null for an unknown tree.
const read = (what, load) => async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const out = await load(req);
    if (out === null) return res.status(404).json({ error: 'Tree not found' });
    res.json(out);
  } catch (err) { fail(res, err, what); }
};

// A write in one transaction; answers with the adjustment as the log shows it.
const write = (what, status, act) => async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const row = await db.tx(client => act(client, req));
    const view = (await adjustmentsView(db, req.params.key))?.find(a => a.id === row.id) || row;
    res.status(status).json({ adjustment: view });
  } catch (err) { fail(res, err, what); }
};

router.get('/context-trees/resolve', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const contextId = String(req.query.contextId || '');
  if (!UUID_RE.test(contextId)) return res.status(400).json({ error: 'contextId (uuid) is required' });
  try {
    const out = await resolveTree(db, contextId.toLowerCase());
    if (!out) return res.status(404).json({ error: 'Context not found' });
    res.json(out);
  } catch (err) { fail(res, err, 'resolve the tree'); }
});

router.get('/context-trees/:key', read('load the tree', req => treeView(db, req.params.key)));
router.get('/context-trees/:key/adjustments', read('load the adjustments', async req => {
  const data = await adjustmentsView(db, req.params.key);
  return data && { data };
}));
router.get('/context-trees/:key/attention', read('load what needs attention', async req => {
  const data = await attentionView(db, req.params.key);
  return data && { data };
}));
router.get('/context-trees/:key/units/:unitId/split-options', read('load the split options', req => {
  if (!UUID_RE.test(req.params.unitId)) return Promise.resolve(null);
  return splitOptions(db, req.params.key, req.params.unitId.toLowerCase());
}));

router.post('/context-trees/:key/adjustments', writeContexts,
  write('add the adjustment', 201, (client, req) => createAdjustment(client, req.params.key, req.body || {}, who(req))));
router.delete('/context-trees/:key/adjustments/:id', writeContexts,
  write('undo the adjustment', 200, (client, req) => undoAdjustment(client, req.params.key, req.params.id)));
router.post('/context-trees/:key/adjustments/:id/redo', writeContexts,
  write('redo the adjustment', 200, (client, req) => redoAdjustment(client, req.params.key, req.params.id)));
router.post('/context-trees/:key/adjustments/:id/follow', writeContexts,
  write('follow the adjustment', 200, (client, req) => followAdjustment(client, req.params.key, req.params.id)));

export default router;
