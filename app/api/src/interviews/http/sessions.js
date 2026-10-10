// Identity Atlas Interviews — the interview record and its mentions.
//
//   POST   /api/v1/interviews                                   create (notice confirmed)
//   GET    /api/v1/interviews                                   my interviews
//   GET    /api/v1/interviews/:id                               everything recorded under one
//   DELETE /api/v1/interviews/:id                               delete it, keep an audit tombstone
//   POST   /api/v1/interviews/:id/mentions                      record mentions (batch)
//   POST   /api/v1/interviews/:id/mentions/:mentionId/resolutions   append a resolution

import { Router } from 'express';
import { query, tx } from '../../db/connection.js';
import { isUuid, validateBatch, validateMention, validateNewInterview, validateResolution } from '../contracts.js';
import { checkTransition } from '../resolution.js';
import { reviewState } from '../review.js';
import {
  actorNameOf, appendResolution, createInterview, deleteInterview, entityExists, insertMentions,
  listInterviews, loadMention, ownerKeyOf,
} from '../store.js';
import { loadDetail } from '../claims.js';
import { READ_GATE, WRITE_GATE, fail, ownedInterview } from './gates.js';

const router = Router();

router.post('/v1/interviews', WRITE_GATE, async (req, res) => {
  const owner = ownerKeyOf(req);
  if (!owner) return res.status(403).json({ error: 'Your sign-in carries no object id' });
  const v = validateNewInterview(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const row = await createInterview(tx, v.value, owner, actorNameOf(req));
    res.status(201).json(row);
  } catch (err) {
    fail(res, 'create', err);
  }
});

router.get('/v1/interviews', READ_GATE, async (req, res) => {
  const owner = ownerKeyOf(req);
  if (!owner) return res.status(403).json({ error: 'Your sign-in carries no object id' });
  try {
    res.json({ data: await listInterviews(query, owner) });
  } catch (err) {
    fail(res, 'list', err);
  }
});

router.get('/v1/interviews/:id', READ_GATE, ownedInterview(), async (req, res) => {
  try {
    const detail = await loadDetail(query, req.interview.id);
    const { expired: _e, ownerKey: _o, ...interview } = req.interview;
    res.json({
      interview,
      mentions: detail.mentions,
      statements: detail.statements,
      proposals: detail.proposals.map(({ latestAction, ...p }) => ({ ...p, reviewState: reviewState(latestAction) })),
    });
  } catch (err) {
    fail(res, 'detail', err);
  }
});

router.delete('/v1/interviews/:id', WRITE_GATE, ownedInterview({ allowExpired: true }), async (req, res) => {
  try {
    const removed = await deleteInterview(tx, req.interview.id, req.owner);
    res.json({ deleted: true, removed });
  } catch (err) {
    fail(res, 'delete', err);
  }
});

router.post('/v1/interviews/:id/mentions', WRITE_GATE, ownedInterview(), async (req, res) => {
  const v = validateBatch(req.body?.mentions, validateMention, 'mentions');
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    res.status(201).json({ data: await insertMentions(tx, req.interview.id, v.value, req.owner) });
  } catch (err) {
    fail(res, 'mentions', err);
  }
});

router.post('/v1/interviews/:id/mentions/:mentionId/resolutions', WRITE_GATE, ownedInterview(), async (req, res) => {
  if (!isUuid(req.params.mentionId)) return res.status(404).json({ error: 'Mention not found' });
  const parsed = validateResolution(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const r = parsed.value;
  try {
    const mention = await loadMention(query, req.interview.id, req.params.mentionId);
    if (!mention) return res.status(404).json({ error: 'Mention not found' });
    const refused = checkTransition(mention.state, r);
    if (refused) return res.status(409).json({ error: refused });
    if (r.entityId && !(await entityExists(query, r.entityKind, r.entityId))) {
      return res.status(400).json({ error: `No ${r.entityKind} with that id exists` });
    }
    res.status(201).json(await appendResolution(tx, req.interview.id, mention.id, r, req.owner));
  } catch (err) {
    fail(res, 'resolve', err);
  }
});

export default router;
