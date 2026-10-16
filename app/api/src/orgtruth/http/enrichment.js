// Organisation truth — enrichments as ordinary attributes (T10).
//
//   GET /api/org-truth/enrichment/:targetType/:id   targetType Identity | Principal | Resource
//       → { groups: [{ source, profileName, entityId, attributes }] }   (enrichment/read.js)
//
// READ_GATE. 400 on an unknown target type or a malformed id; 500 with a
// generic message on a database error.
import { Router } from 'express';
import { READ_GATE } from './gates.js';
import { handle, isUuid } from '../import/httpHelpers.js';
import { getEnrichment, ENRICHMENT_TARGET_TYPES } from '../enrichment/read.js';

const router = Router();

router.get('/org-truth/enrichment/:targetType/:id', ...READ_GATE, handle('read the enrichments', async (req, res) => {
  if (!ENRICHMENT_TARGET_TYPES.includes(req.params.targetType)) {
    return res.status(400).json({ error: `targetType must be one of ${ENRICHMENT_TARGET_TYPES.join(', ')}` });
  }
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  res.json(await getEnrichment(req.params.targetType, req.params.id));
}));

export default router;
