// Organisation truth — activity reads (T10, OrgActivities).
//
//   GET /api/org-truth/activity/subject/:targetType/:id   targetType OrgEntity | Resource; ?type=<activity type>
//       → { type, types, unit, total, firstOn, lastOn, months, actors, unresolvedRows } (activity/subject.js)
//   GET /api/org-truth/activity/actor/:targetType/:id     targetType Principal | Identity
//       → { groups: [{ type, unit, unresolvedRows, subjects }] }                       (activity/actor.js)
//
// READ_GATE. 400 on an unknown target type, a malformed id or ?type; 500 with a
// generic message on a database error. An object without activity answers 200
// with empty totals, not 404: "no activity" is the answer.
import { Router } from 'express';
import { READ_GATE } from './gates.js';
import { handle, isUuid } from '../import/httpHelpers.js';
import { getSubjectActivity, SUBJECT_TYPES } from '../activity/subject.js';
import { getActorActivity, ACTOR_TYPES } from '../activity/actor.js';

const MAX_TYPE_LENGTH = 200;
const router = Router();

function badTarget(req, allowed) {
  if (!allowed.includes(req.params.targetType)) return `targetType must be one of ${allowed.join(', ')}`;
  return isUuid(req.params.id) ? null : 'Invalid id';
}

router.get('/org-truth/activity/subject/:targetType/:id', ...READ_GATE, handle('read the activity', async (req, res) => {
  const error = badTarget(req, SUBJECT_TYPES);
  if (error) return res.status(400).json({ error });
  const type = req.query.type;
  if (type !== undefined && (typeof type !== 'string' || type.length > MAX_TYPE_LENGTH)) {
    return res.status(400).json({ error: 'type must be text' });
  }
  res.json(await getSubjectActivity(req.params.targetType, req.params.id, { type: type || null }));
}));

router.get('/org-truth/activity/actor/:targetType/:id', ...READ_GATE, handle('read the activity', async (req, res) => {
  const error = badTarget(req, ACTOR_TYPES);
  if (error) return res.status(400).json({ error });
  res.json(await getActorActivity(req.params.targetType, req.params.id));
}));

export default router;
