// Organisation truth — linking and review (owned by workstream T2).
//
//   POST /api/org-truth/links/detect           { sourceId, recipe, entityType } → per attribute, per target field: unique / ambiguous / none
//   GET  /api/org-truth/review                 proposed links (and claims) with their candidates, paged
//   PUT  /api/org-truth/links/:id/override     { action: 'confirmed' | 'rejected' | 'moved', targetId? }
//   DELETE /api/org-truth/links/:id/override   clear the override
//   PUT  /api/org-truth/entities/:id/status    { status: 'accepted' | 'rejected' }   (claims review)
//   PUT  /api/org-truth/relations/:id/status   { status: 'accepted' | 'rejected' }
import { Router } from 'express';

const router = Router();

export default router;
