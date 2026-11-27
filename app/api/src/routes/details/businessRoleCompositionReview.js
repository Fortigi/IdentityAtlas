// Composition reviews of a business role.
//
//   GET  /api/access-package/:id/composition-reviews   the reviews, newest first, the
//                                                       latest one with what changed since,
//                                                       and whether the caller may review
//   POST /api/access-package/:id/composition-reviews   { steps: [{ step, verdict, remark,
//                                                       proposal }], notes } — saves one review
//   GET  /api/access-package/:id/composition-reviews/people?search=
//                                                       people the reviewer can propose as an
//                                                       owner: name and e-mail, a short list
//
// Experimental (feature flag `compositionReview`): while it is off both answer
// 404. A review is a certification decision, so writing takes the permission
// the catalog keeps for those (data.write.certifications) — or being the role's
// own Accountable or Responsible (lib/businessRoleOwners.js), through any of the
// caller's accounts, where the relative-permission grid gives that role
// `review` (Admin → Roles & Permissions, auth/relativePermissions.js) — or being
// asked by a review campaign: the role's Accountable while a request for it is
// open (lib/reviewCampaigns.js). Who saved it comes from the signed-in user
// (lib/userOf.js), never from the body.
//
// GET tells an asked person what they are asked (`request`: the campaign, its
// steps, when it is due), and a review they save answers that request.
//
// The people lookup is open to exactly those who may review this role: a role's
// owner has no other way to find a colleague (a context owner cannot list users).
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
import { loadCompositionReviews, saveCompositionReview, searchPeople } from '../../lib/businessRoleCompositionReview.js';
import { parseReviewBody } from '../../lib/compositionReviewSteps.js';
import { openRequestsFor, answerRequests } from '../../lib/reviewCampaigns.js';
import { requireRole, failed } from './businessRoleOwners.js';

export const REVIEW_PERMISSION = 'data.write.certifications';

const router = Router();
const feature = requireFeature('compositionReview');

const holdsPermission = (req) => {
  const perms = req.user?.permissions;
  return !!perms && (perms.has('*') || perms.has(REVIEW_PERMISSION));
};

// The person behind the request in our own data, looked up once per request.
// A caller let in as an owner was matched already (contextOwnerMode).
async function meOf(req) {
  if (req.reviewer === undefined) req.reviewer = req.user?.contextOwner?.me ?? await resolveMe(req.user);
  return req.reviewer;
}

/** The open campaign requests that ask this caller to review the role in req.params.id. */
export async function askedRequests(req) {
  if (!isAuthEnabled() || req.readToken || !req.user) return [];
  return openRequestsFor(await meOf(req), req.params.id);
}

/** May this caller save a review of the role in req.params.id? */
export async function mayReview(req) {
  if (!isAuthEnabled()) return true;
  if (req.readToken) return false;
  if (holdsPermission(req)) return true;
  const roles = rolesAllowing(await getRelativePolicy(), BUSINESS_ROLE_SUBJECT, 'review');
  if (roles.length > 0 && await answersForBusinessRole(await meOf(req), req.params.id, roles)) return true;
  // Asked by a campaign: the request itself is the right to answer it.
  return (await askedRequests(req)).length > 0;
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
    const [summary, canReview, asked] = await Promise.all([loadCompositionReviews(req.params.id), mayReview(req), askedRequests(req)]);
    // The request due soonest is the one the wizard answers first.
    res.json({ ...summary, canReview, request: asked[0] ?? null });
  } catch (err) { failed(res, 'Loading the composition reviews', err); }
});

router.post('/access-package/:id/composition-reviews', reviewGate, feature, requireRole, async (req, res) => {
  const parsed = parseReviewBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const saved = await saveCompositionReview(req.params.id, parsed, { by: userOf(req), byName: req.user?.name });
    if (saved.error) return res.status(400).json({ error: saved.error });
    if (isAuthEnabled() && req.user) await answerRequests(await meOf(req), req.params.id, saved);
    return res.status(201).json(saved);
  } catch (err) { return failed(res, 'Saving the composition review', err); }
});

router.get('/access-package/:id/composition-reviews/people', reviewGate, feature, requireRole, async (req, res) => {
  try {
    res.json({ data: await searchPeople(typeof req.query.search === 'string' ? req.query.search : '') });
  } catch (err) { failed(res, 'Looking up people for the review', err); }
});

export default router;
