// Composition reviews of a business role.
//
//   GET  /api/access-package/:id/composition-reviews   the reviews, newest first, the
//                                                       latest sign-off with what changed
//                                                       since, and whether the caller may review
//   POST /api/access-package/:id/composition-reviews   { notes, signedOff } — saves one review
//
// Experimental (feature flag `compositionReview`): while it is off both answer
// 404. A sign-off is a certification decision, so writing takes the permission
// the catalog keeps for those (data.write.certifications) — or being the role's
// own Accountable or Responsible (lib/businessRoleOwners.js), through any of the
// caller's accounts, where the relative-permission grid gives that role
// `review` (Admin → Roles & Permissions, auth/relativePermissions.js). Who saved it comes from the signed-in user
// (lib/userOf.js), never from the body.
//
// The gate runs before the flag, so a caller without the right is refused 403
// whether or not the feature is on (the route → permission sweep relies on it).

import { Router } from 'express';
import { isAuthEnabled } from '../../config/authConfig.js';
import { requireFeature } from '../../featureFlags.js';
import { userOf } from '../../lib/userOf.js';
import { resolveMe } from '../../auth/resolveMe.js';
import { answersForBusinessRole } from '../../lib/businessRoleOwners.js';
import { getRelativePolicy } from '../../auth/contextOwnerSetting.js';
import { BUSINESS_ROLE_SUBJECT, rolesAllowing } from '../../auth/relativePermissions.js';
import { loadCompositionReviews, saveCompositionReview, parseReviewBody } from '../../lib/businessRoleCompositionReview.js';
import { requireRole, failed } from './businessRoleOwners.js';

export const REVIEW_PERMISSION = 'data.write.certifications';

const router = Router();
const feature = requireFeature('compositionReview');

const holdsPermission = (req) => {
  const perms = req.user?.permissions;
  return !!perms && (perms.has('*') || perms.has(REVIEW_PERMISSION));
};

/** May this caller save a review of the role in req.params.id? */
export async function mayReview(req) {
  if (!isAuthEnabled()) return true;
  if (req.readToken) return false;
  if (holdsPermission(req)) return true;
  const roles = rolesAllowing(await getRelativePolicy(), BUSINESS_ROLE_SUBJECT, 'review');
  if (roles.length === 0) return false;
  // A caller let in as an owner was matched to our data already (contextOwnerMode).
  const me = req.user?.contextOwner?.me ?? await resolveMe(req.user);
  return answersForBusinessRole(me, req.params.id, roles);
}

async function reviewGate(req, res, next) {
  try {
    if (await mayReview(req)) return next();
  } catch (err) {
    return failed(res, 'Checking who may review the role', err);
  }
  return res.status(403).json({ error: 'Insufficient permissions', required: [REVIEW_PERMISSION] });
}

router.get('/access-package/:id/composition-reviews', feature, requireRole, async (req, res) => {
  try {
    const [summary, canReview] = await Promise.all([loadCompositionReviews(req.params.id), mayReview(req)]);
    res.json({ ...summary, canReview });
  } catch (err) { failed(res, 'Loading the composition reviews', err); }
});

router.post('/access-package/:id/composition-reviews', reviewGate, feature, requireRole, async (req, res) => {
  const parsed = parseReviewBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const saved = await saveCompositionReview(req.params.id, parsed, { by: userOf(req), byName: req.user?.name });
    return res.status(201).json(saved);
  } catch (err) { return failed(res, 'Saving the composition review', err); }
});

export default router;
