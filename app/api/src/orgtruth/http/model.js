// Organisation truth — the model and the entities (owned by workstream T4).
//
//   GET  /api/org-truth/model                  the meta-graph: entity types, predicates between types, links to system types, counts
//                                              ?includeClosed=1  ?sourceId=<uuid>  ?withSystemCounts=0
//   GET  /api/org-truth/entities               list; ?type=&q=&status=&sourceId=&includeClosed=&page=&pageSize=
//   GET  /api/org-truth/entities/:id           one entity: attributes, relations in and out, links, source, run
//   GET  /api/org-truth/filter-options        the matrix filter's Organisation picker for one entity type; ?type= (required)
//   GET  /api/org-truth/entities/:id/graph     the detail page's fan-out rings (entityGraphShape.js contract)
//                                              ?category=<key> returns the items of one ring
//
// Response shapes are documented in the module headers of model/metaGraph.js,
// model/entities.js and model/graph.js. All routes: READ_GATE (data.read + the
// orgTruth feature). 400 on a malformed parameter or id, 404 on an unknown entity,
// 500 with a generic message on a database error.
import { Router } from 'express';
import { READ_GATE } from './gates.js';
import { getMetaGraph } from '../model/metaGraph.js';
import { parseListQuery, listEntities, getEntity, isUuid, isFlag } from '../model/entities.js';
import { getEntityGraph, getGraphCategory, parseCategory } from '../model/graph.js';
import { getEvidence } from '../model/evidence.js';
import { getLinkedTo, TARGET_TYPES } from '../model/linkedTo.js';
import { getFilterOptions } from '../model/filterOptions.js';

const MAX_TYPE_LENGTH = 200;

const router = Router();

function fail(res, label, err) {
  console.error(`[org-truth] ${label} failed:`, err.message);
  res.status(500).json({ error: `Failed to load ${label}` });
}

router.get('/org-truth/model', ...READ_GATE, async (req, res) => {
  const sourceId = typeof req.query.sourceId === 'string' && req.query.sourceId ? req.query.sourceId : null;
  if (sourceId && !isUuid(sourceId)) return res.status(400).json({ error: 'sourceId must be a UUID' });
  const noCounts = req.query.withSystemCounts === '0' || req.query.withSystemCounts === 'false';
  try {
    res.json(await getMetaGraph({ includeClosed: isFlag(req.query.includeClosed), sourceId, withSystemCounts: !noCounts }));
  } catch (err) { fail(res, 'the organisation model', err); }
});

router.get('/org-truth/entities', ...READ_GATE, async (req, res) => {
  const parsed = parseListQuery(req.query);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    res.json(await listEntities(parsed.value));
  } catch (err) { fail(res, 'organisation entities', err); }
});

router.get('/org-truth/entities/:id', ...READ_GATE, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid entity id' });
  try {
    const entity = await getEntity(req.params.id);
    if (!entity) return res.status(404).json({ error: 'Entity not found' });
    res.json(entity);
  } catch (err) { fail(res, 'the organisation entity', err); }
});

// What other lists say about this entity: its listed people (owner, team) next
// to who the referring rows (a timesheet) show working on it, and when.
router.get('/org-truth/entities/:id/evidence', ...READ_GATE, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid entity id' });
  try {
    const out = await getEvidence(req.params.id);
    if (!out) return res.status(404).json({ error: 'Entity not found' });
    res.json(out);
  } catch (err) { fail(res, 'the entity evidence', err); }
});

// What the organisation lists say about one system object, for the
// "Organisation" branch of its detail page's relationship graph.
router.get('/org-truth/linked/:targetType/:id', ...READ_GATE, async (req, res) => {
  if (!TARGET_TYPES.includes(req.params.targetType)) return res.status(400).json({ error: `targetType must be one of ${TARGET_TYPES.join(', ')}` });
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    res.json(await getLinkedTo(req.params.targetType, req.params.id));
  } catch (err) { fail(res, 'the organisation links', err); }
});

// What the matrix filter's Organisation picker offers for one entity type:
// attribute values to choose a set of entities by, and the link names to
// filter on (model/filterOptions.js).
router.get('/org-truth/filter-options', ...READ_GATE, async (req, res) => {
  const type = req.query.type;
  if (typeof type !== 'string' || !type.trim() || type.length > MAX_TYPE_LENGTH) {
    return res.status(400).json({ error: 'type is required' });
  }
  try {
    res.json(await getFilterOptions(type));
  } catch (err) { fail(res, 'the filter options', err); }
});

router.get('/org-truth/entities/:id/graph', ...READ_GATE, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid entity id' });
  const hasCategory = req.query.category !== undefined;
  const category = hasCategory ? parseCategory(req.query.category) : null;
  if (hasCategory && !category) return res.status(400).json({ error: 'Unknown category' });
  try {
    const out = category ? await getGraphCategory(req.params.id, category) : await getEntityGraph(req.params.id);
    if (!out) return res.status(404).json({ error: 'Entity not found' });
    res.json(out);
  } catch (err) { fail(res, 'the entity graph', err); }
});

export default router;
