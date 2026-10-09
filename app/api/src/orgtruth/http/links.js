// Organisation truth — linking and review (owned by workstream T2).
//
//   POST /api/org-truth/links/detect           { sourceId | rows, recipe, entityType } → { entityType, entities, pairs }
//   GET  /api/org-truth/review                 ?status=proposed&entityType=&page=1[&kind=claims]
//   PUT  /api/org-truth/links/:id/override     { action: 'confirmed' | 'rejected' | 'moved', targetId? }
//   DELETE /api/org-truth/links/:id/override   clear the override (status stays)
//   PUT  /api/org-truth/entities/:id/status    { status: 'accepted' | 'rejected' }   (claims review)
//   PUT  /api/org-truth/relations/:id/status   { status: 'accepted' | 'rejected' }
//
// Response shapes are documented in linking/review.js and linking/detect.js.
//
// Detect: the recipe is validated (validateRecipe) and normalised; the entity
// type must be one of its entities. Entities come from the stored source via
// T1's parser (`sourceId`), or — the fallback the wizard and tests may use —
// from `rows` (≤ MAX_DETECT_ROWS objects) sent in the body. 501 while T1's
// import modules are not on the branch.
import { Router } from 'express';
import { READ_GATE, WRITE_GATE } from './gates.js';
import { validateRecipe, normalizeRecipe } from '../contracts.js';
import { detectLinks, entitiesFromRows } from '../linking/detect.js';
import { loadSourceEntities, SourceParsingUnavailable } from '../linking/sourceEntities.js';
import {
  ReviewError, isUuid, listReview, listClaims, overrideLink, clearOverride, setClaimStatus,
} from '../linking/review.js';

export const MAX_DETECT_ROWS = 20000;

const router = Router();

function fail(res, err, what) {
  if (err instanceof ReviewError) return res.status(err.httpStatus).json({ error: err.message });
  if (err instanceof SourceParsingUnavailable) return res.status(501).json({ error: err.message });
  console.error(`org-truth ${what} failed:`, err.message);
  return res.status(500).json({ error: `Could not ${what}.` });
}

/** Validate the detect body; returns { recipe, entityDef } or throws ReviewError(400). */
export function parseDetectBody(body) {
  const { recipe, entityType, sourceId, rows } = body ?? {};
  const v = validateRecipe(recipe);
  if (!v.ok) {
    const err = new ReviewError(400, 'The recipe is not valid.');
    err.errors = v.errors;
    throw err;
  }
  const normalized = normalizeRecipe(recipe);
  const entityDef = normalized.entities.find(e => e.type === (typeof entityType === 'string' ? entityType.trim() : entityType));
  if (!entityDef) throw new ReviewError(400, 'entityType must be one of the recipe\'s entity types.');
  if (Array.isArray(rows)) {
    if (rows.length > MAX_DETECT_ROWS) throw new ReviewError(400, `At most ${MAX_DETECT_ROWS} rows can be sent; use sourceId for a larger list.`);
    return { recipe: normalized, entityDef, rows };
  }
  if (!isUuid(sourceId)) throw new ReviewError(400, 'Send a sourceId (UUID) or rows.');
  return { recipe: normalized, entityDef, sourceId };
}

router.post('/org-truth/links/detect', ...WRITE_GATE, async (req, res) => {
  try {
    const { recipe, entityDef, rows, sourceId } = parseDetectBody(req.body);
    const entities = rows
      ? entitiesFromRows(rows, entityDef)
      : await loadSourceEntities({ sourceId, recipe, entityType: entityDef.type });
    if (entities === null) return res.status(404).json({ error: 'Source not found.' });
    const pairs = await detectLinks(entities, entityDef.type, entityDef);
    return res.json({ entityType: entityDef.type, entities: entities.length, pairs });
  } catch (err) {
    if (err instanceof ReviewError && err.errors) return res.status(400).json({ error: err.message, errors: err.errors });
    return fail(res, err, 'detect link candidates');
  }
});

router.get('/org-truth/review', ...READ_GATE, async (req, res) => {
  try {
    const params = { status: req.query.status, entityType: req.query.entityType, page: req.query.page };
    return res.json(req.query.kind === 'claims' ? await listClaims(params) : await listReview(params));
  } catch (err) {
    return fail(res, err, 'load the review queue');
  }
});

router.put('/org-truth/links/:id/override', ...WRITE_GATE, async (req, res) => {
  try {
    return res.json(await overrideLink(req.params.id, req.body ?? {}, req.user));
  } catch (err) {
    return fail(res, err, 'override the link');
  }
});

router.delete('/org-truth/links/:id/override', ...WRITE_GATE, async (req, res) => {
  try {
    return res.json({ link: await clearOverride(req.params.id) });
  } catch (err) {
    return fail(res, err, 'clear the override');
  }
});

for (const kind of ['entities', 'relations']) {
  router.put(`/org-truth/${kind}/:id/status`, ...WRITE_GATE, async (req, res) => {
    try {
      return res.json(await setClaimStatus(kind, req.params.id, req.body?.status));
    } catch (err) {
      return fail(res, err, 'set the status');
    }
  });
}

export default router;
