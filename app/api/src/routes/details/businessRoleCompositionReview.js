// Composition reviews of a business role.
//
//   GET  /api/access-package/:id/composition-reviews   the reviews, newest first, and the
//                                                       latest sign-off with what changed since
//   POST /api/access-package/:id/composition-reviews   { notes, signedOff } — saves one review
//
// A sign-off is a certification decision, so writing takes the permission the
// catalog keeps for those (data.write.certifications). Who saved it comes from
// the signed-in user (lib/userOf.js), never from the body.

import { Router } from 'express';
import { requirePermission } from '../../middleware/auth.js';
import { userOf } from '../../lib/userOf.js';
import { loadCompositionReviews, saveCompositionReview, parseReviewBody } from '../../lib/businessRoleCompositionReview.js';
import { requireRole, failed } from './businessRoleOwners.js';

const router = Router();
const writeCertifications = requirePermission('data.write.certifications');

router.get('/access-package/:id/composition-reviews', requireRole, async (req, res) => {
  try { res.json(await loadCompositionReviews(req.params.id)); }
  catch (err) { failed(res, 'Loading the composition reviews', err); }
});

router.post('/access-package/:id/composition-reviews', writeCertifications, requireRole, async (req, res) => {
  const parsed = parseReviewBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const saved = await saveCompositionReview(req.params.id, parsed, { by: userOf(req), byName: req.user?.name });
    return res.status(201).json(saved);
  } catch (err) { return failed(res, 'Saving the composition review', err); }
});

export default router;
