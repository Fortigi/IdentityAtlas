// Review campaigns: asking the Accountable of a set of business roles to do a
// composition review, once or on a schedule (lib/reviewCampaigns.js).
//
//   GET    /api/review-campaigns                 every campaign with how its newest round stands
//   GET    /api/review-campaigns/scope-options   the business roles and role portfolios to choose from
//   POST   /api/review-campaigns                 { name, steps, roleIds, portfolioIds, startsOn,
//                                                  intervalMonths, dueDays } — a new campaign
//   GET    /api/review-campaigns/:id             one campaign: its scope and the roles of its newest round
//   POST   /api/review-campaigns/:id/end         stop asking; its open requests close
//   DELETE /api/review-campaigns/:id             remove it with its rounds and requests (reviews stay)
//   GET    /api/review-requests/mine             the reviews the caller is asked to do
//
// Experimental: all of it sits behind the compositionReview flag and answers 404
// while that is off. Managing campaigns takes data.write.review-campaigns; the gate
// runs before the flag, so a caller without it is refused 403 either way. What
// the caller is asked is open to anyone signed in — it only ever lists their own.

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { isAuthEnabled } from '../config/authConfig.js';
import { requireFeature } from '../featureFlags.js';
import { userOf } from '../lib/userOf.js';
import { resolveMe } from '../auth/resolveMe.js';
import { getRelativePolicy } from '../auth/contextOwnerSetting.js';
import { BUSINESS_ROLE_SUBJECT, rolesAllowing } from '../auth/relativePermissions.js';
import {
  ASKED_ROLE, parseCampaignBody, listCampaigns, loadCampaign, createCampaign, endCampaign, deleteCampaign,
  scopeOptions, openRequestsFor,
} from '../lib/reviewCampaigns.js';

export const CAMPAIGN_PERMISSION = 'data.write.review-campaigns';

const router = Router();
const manage = requirePermission(CAMPAIGN_PERMISSION);
const feature = requireFeature('compositionReview');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const failed = (res, label, err) => {
  console.error(`${label} failed:`, err.message);
  res.status(500).json({ error: `${label} failed` });
};

function validId(req, res, next) {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  return next();
}

/**
 * Can the people a campaign asks open their role at all? Being asked lets an
 * Accountable do the review, but signing in and opening the role is the
 * relative-permission grid's (Admin → Roles & Permissions). True while sign-in is off.
 */
export async function askedCanOpen() {
  if (!isAuthEnabled()) return true;
  return rolesAllowing(await getRelativePolicy(), BUSINESS_ROLE_SUBJECT, 'view').includes(ASKED_ROLE);
}

router.get('/review-campaigns', manage, feature, async (_req, res) => {
  try {
    const [campaigns, canOpen] = await Promise.all([listCampaigns(), askedCanOpen()]);
    res.json({ campaigns, askedCanOpen: canOpen });
  } catch (err) { failed(res, 'Loading the review campaigns', err); }
});

router.get('/review-campaigns/scope-options', manage, feature, async (_req, res) => {
  try {
    res.json(await scopeOptions());
  } catch (err) { failed(res, 'Loading the business roles and role portfolios', err); }
});

router.post('/review-campaigns', manage, feature, async (req, res) => {
  const parsed = parseCampaignBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const made = await createCampaign(parsed, userOf(req));
    if (made.error) return res.status(400).json({ error: made.error });
    return res.status(201).json(await loadCampaign(made.id));
  } catch (err) { return failed(res, 'Saving the review campaign', err); }
});

router.get('/review-campaigns/:id', manage, feature, validId, async (req, res) => {
  try {
    const campaign = await loadCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Review campaign not found' });
    return res.json(campaign);
  } catch (err) { return failed(res, 'Loading the review campaign', err); }
});

router.post('/review-campaigns/:id/end', manage, feature, validId, async (req, res) => {
  try {
    if (!(await endCampaign(req.params.id))) return res.status(404).json({ error: 'No running review campaign with this id' });
    return res.json(await loadCampaign(req.params.id));
  } catch (err) { return failed(res, 'Ending the review campaign', err); }
});

router.delete('/review-campaigns/:id', manage, feature, validId, async (req, res) => {
  try {
    if (!(await deleteCampaign(req.params.id))) return res.status(404).json({ error: 'Review campaign not found' });
    return res.status(204).end();
  } catch (err) { return failed(res, 'Removing the review campaign', err); }
});

router.get('/review-requests/mine', feature, async (req, res) => {
  // A read API key is nobody in particular; so is a request while sign-in is off.
  if (req.readToken || !req.user) return res.json({ requests: [] });
  try {
    // A caller let in as an owner was matched to our data already (contextOwnerMode).
    const me = req.user.contextOwner?.me ?? await resolveMe(req.user);
    return res.json({ requests: await openRequestsFor(me) });
  } catch (err) { return failed(res, 'Loading the reviews you are asked to do', err); }
});

export default router;
