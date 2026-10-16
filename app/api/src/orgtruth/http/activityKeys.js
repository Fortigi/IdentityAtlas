// Organisation truth — the review of activity references (owned by the template
// write side; the queries are in import/activityKeys.js).
//
//   GET /api/org-truth/activity-keys?status=&role=&profileName=&page=
//       → { data: [{ id, profileName, role, rawValue, rows, targetType, targetId, targetLabel,
//                    confidence, status, candidates?: [{ targetType, targetId, label, confidence }] }], total }
//   PUT /api/org-truth/activity-keys/:id { status: 'accepted'|'rejected', targetType?, targetId? }
//       → the key (analystOverride true); 400 with a sentence, 404 for an unknown key
import { Router } from 'express';
import { READ_GATE, WRITE_GATE } from './gates.js';
import { actorOf, handle } from '../import/httpHelpers.js';
import { listKeys, decideKeyReview, KEY_STATUSES } from '../import/activityKeys.js';

const router = Router();
const ROLES = ['actor', 'subject'];

/** The list filters, checked: { error } or { status, role, profileName, page }. */
export function readKeyFilters(q) {
  const pick = (v) => (typeof v === 'string' && v !== '' ? v : null);
  const status = pick(q?.status);
  const role = pick(q?.role);
  if (status && !KEY_STATUSES.includes(status)) return { error: `status must be one of ${KEY_STATUSES.join(', ')}.` };
  if (role && !ROLES.includes(role)) return { error: `role must be one of ${ROLES.join(', ')}.` };
  const page = q?.page === undefined || q.page === '' ? 1 : Number(q.page);
  if (!Number.isInteger(page) || page < 1) return { error: 'page must be a whole number from 1.' };
  return { status, role, profileName: pick(q?.profileName), page };
}

router.get('/org-truth/activity-keys', ...READ_GATE, handle('list the activity references', async (req, res) => {
  const filters = readKeyFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  res.json(await listKeys(filters));
}));

router.put('/org-truth/activity-keys/:id', ...WRITE_GATE, handle('decide the activity reference', async (req, res) => {
  const out = await decideKeyReview(req.params.id, req.body, actorOf(req));
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out.key);
}));

export default router;
