// Authorization workbench and organizational knowledge about people.
// Design: docs/architecture/m1-discovery-and-design.md.
//
//   GET  /api/contexts/:id/workbench?includeChildren=true|false   the unit's people, their access and
//                                                                 what is said they do, know and hold
//   POST /api/contexts/:id/knowledge                              an analyst states an activity / expertise / duty
//   GET  /api/org-knowledge/objects?kind=activity|expertise|duty  every object, with how many people hold it
//   GET  /api/org-knowledge/objects/:objectId/people              who is said to hold one object
//
// The workbench is an analyst's tool: everything here needs data.write.contexts.
// Nothing here writes to a source system or creates access; the workbench's
// candidate roles live in the browser (session only).

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, writeContexts, UUID_RE } from './shared.js';
import { userOf } from '../../lib/userOf.js';
import { loadWorkbench, WorkbenchError } from '../../contexts/workbench/load.js';
import { addKnowledgeLink, peopleWithObject, KnowledgeError } from '../../contexts/orgKnowledge/manual.js';
import { listObjects } from '../../contexts/orgKnowledge/objects.js';
import { isKnowledgeKind } from '../../lib/orgKnowledge.js';

const router = Router();

function fail(res, err, label) {
  if (err instanceof WorkbenchError || err instanceof KnowledgeError) return res.status(err.status).json({ error: err.message });
  console.error(`${label} failed:`, err?.message);
  return res.status(500).json({ error: `${label} failed` });
}

const needSql = (res) => res.status(503).json({ error: 'The workbench needs the SQL backend' });

router.get('/contexts/:id/workbench', writeContexts, async (req, res) => {
  if (!useSql) return needSql(res);
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    res.json(await loadWorkbench(db, req.params.id, { includeChildren: req.query.includeChildren !== 'false' }));
  } catch (err) { fail(res, err, 'Loading the workbench'); }
});

router.post('/contexts/:id/knowledge', writeContexts, async (req, res) => {
  if (!useSql) return needSql(res);
  try {
    res.status(201).json(await addKnowledgeLink(db, req.params.id, req.body ?? {}, userOf(req)));
  } catch (err) { fail(res, err, 'Adding knowledge'); }
});

router.get('/org-knowledge/objects', writeContexts, async (req, res) => {
  if (!useSql) return needSql(res);
  const kind = req.query.kind ?? null;
  if (kind !== null && !isKnowledgeKind(kind)) return res.status(400).json({ error: 'kind must be activity, expertise or duty' });
  try {
    res.json({ data: await listObjects(db, kind) });
  } catch (err) { fail(res, err, 'Listing knowledge objects'); }
});

router.get('/org-knowledge/objects/:objectId/people', writeContexts, async (req, res) => {
  if (!useSql) return needSql(res);
  try {
    res.json({ data: await peopleWithObject(db, req.params.objectId) });
  } catch (err) { fail(res, err, 'Listing who holds it'); }
});

export default router;
