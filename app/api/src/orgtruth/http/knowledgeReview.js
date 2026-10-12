// Organisation knowledge extraction — reviewing what was extracted (experimental).
//
//   GET /api/org-truth/knowledge/sources/:id/mentions     mentions + candidate matches with reasons
//   GET /api/org-truth/knowledge/sources/:id/claims       statements with exact evidence  (?status=proposed|accepted|rejected)
//   GET /api/org-truth/knowledge/sources/:id/findings     issues and follow-up questions
//   GET /api/org-truth/knowledge/sources/:id/export       the full JSON package
//   GET /api/org-truth/knowledge/search?type=&q=          find an object a mention could be (to choose one by hand)
//   GET /api/org-truth/knowledge/statements?targetType=&targetId=   accepted statements about one object
//   PUT /api/org-truth/knowledge/matches/:linkId          { action: confirm|reject|choose|reset, targetType?, targetId? }
//   PUT /api/org-truth/knowledge/mentions/:id             { label?, type? } — rename / retype a mention (all its statements follow)
//   PUT /api/org-truth/knowledge/mentions/:id/choose      { targetType, targetId } — link a mention without candidates by hand
//   PUT /api/org-truth/knowledge/sources/:id/claims/bulk  { status: accepted|rejected, ids? } — all still-proposed statements
//   GET /api/org-truth/knowledge/sources/:id/original     the transcript file exactly as uploaded
//   POST /api/org-truth/knowledge/sources/:id/rescore     confidence + corroboration by the existing data, again
// Every match decision and mention edit scores the transcript's statements again.
//   PUT /api/org-truth/knowledge/claims/:id               { status, expectedStatus?, predicate?, qualifier? }
//   PUT /api/org-truth/knowledge/findings/:id             { status: open|dismissed|resolved }
import { Router } from 'express';
import { actorOf, handle, isUuid } from '../import/httpHelpers.js';
import { KNOWLEDGE_READ, KNOWLEDGE_WRITE, canSee } from '../knowledge/access.js';
import { getTranscript } from '../knowledge/store.js';
import { listMentions, listClaims, listFindings, exportPackage, statementsAbout } from '../knowledge/read.js';
import { resolveMentions } from '../knowledge/resolve.js';
import {
  reviewMatch, reviewClaim, reviewFinding, chooseForMention, bulkReviewClaims, KnowledgeReviewError, CLAIM_REVIEW_STATUSES,
} from '../knowledge/review.js';
import { editMention } from '../knowledge/mentions.js';
import { rescoreSource, rescoreForMention } from '../knowledge/corroboration.js';
import { getSourceWithContent } from '../import/sourceStore.js';
import { MENTION_TYPES } from '../knowledge/contracts.js';
import { targetsOf } from '../model/linkedTo.js';

const router = Router();
const STATEMENT_TARGETS = ['Principal', 'Identity', 'Resource', 'Context', 'OrgEntity'];

async function visible(req, res) {
  const source = await getTranscript(req.params.id);
  if (!source || !canSee(req, source)) {
    res.status(404).json({ error: 'Transcript not found.' });
    return null;
  }
  return source;
}

// Who a mention is decides what the data can confirm: score the transcript again.
async function rescored(promise, mentionOf) {
  const result = await promise;
  const mentionId = mentionOf(result);
  if (mentionId) result.confidence = await rescoreForMention(mentionId);
  return result;
}

const decide = (what, fn) => handle(what, async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof KnowledgeReviewError) return res.status(err.httpStatus).json({ error: err.message });
    throw err;
  }
});

router.get('/org-truth/knowledge/sources/:id/mentions', ...KNOWLEDGE_READ, handle('list the mentions', async (req, res) => {
  const source = await visible(req, res);
  if (source) res.json(await listMentions(source.id));
}));

router.get('/org-truth/knowledge/sources/:id/claims', ...KNOWLEDGE_READ, handle('list the statements', async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !CLAIM_REVIEW_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${CLAIM_REVIEW_STATUSES.join(', ')}.` });
  const source = await visible(req, res);
  if (source) res.json(await listClaims(source.id, { status }));
}));

router.get('/org-truth/knowledge/sources/:id/findings', ...KNOWLEDGE_READ, handle('list the findings', async (req, res) => {
  const source = await visible(req, res);
  if (source) res.json(await listFindings(source.id));
}));

router.get('/org-truth/knowledge/sources/:id/export', ...KNOWLEDGE_READ, handle('export the transcript', async (req, res) => {
  const source = await visible(req, res);
  if (!source) return;
  const pkg = await exportPackage(source.id);
  res.attachment(`knowledge-${source.id}.json`);
  res.json(pkg);
}));

router.get('/org-truth/knowledge/search', ...KNOWLEDGE_READ, handle('search objects', async (req, res) => {
  const type = String(req.query.type ?? '');
  const q = String(req.query.q ?? '').trim().slice(0, 120);
  if (!MENTION_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of ${MENTION_TYPES.join(', ')}.` });
  if (q.length < 2) return res.status(400).json({ error: 'q needs at least two characters.' });
  const found = await resolveMentions([{ key: 'q', type, label: q }]);
  res.json(found.get('q') ?? { status: 'unmatched', candidates: [] });
}));

router.get('/org-truth/knowledge/statements', ...KNOWLEDGE_READ, handle('list statements about an object', async (req, res) => {
  const targetType = String(req.query.targetType ?? '');
  const targetId = String(req.query.targetId ?? '');
  if (!STATEMENT_TARGETS.includes(targetType) || !isUuid(targetId)) {
    return res.status(400).json({ error: `targetType must be one of ${STATEMENT_TARGETS.join(', ')} and targetId a UUID.` });
  }
  const pairs = targetType === 'OrgEntity' ? [{ targetType, id: targetId }] : await targetsOf(targetType, targetId);
  res.json(await statementsAbout(pairs));
}));

router.put('/org-truth/knowledge/matches/:linkId', ...KNOWLEDGE_WRITE,
  decide('decide the match', req => rescored(reviewMatch(req.params.linkId, req.body ?? {}, actorOf(req)), r => r.link?.orgEntityId)));

router.put('/org-truth/knowledge/mentions/:id', ...KNOWLEDGE_WRITE,
  decide('edit the mention', req => rescored(editMention(req.params.id, { label: req.body?.label, type: req.body?.type }, actorOf(req)), () => req.params.id)));

router.put('/org-truth/knowledge/sources/:id/claims/bulk', ...KNOWLEDGE_WRITE, handle('review the statements', async (req, res) => {
  const source = await visible(req, res);
  if (!source) return;
  try {
    res.json(await bulkReviewClaims(source.id, req.body ?? {}, actorOf(req)));
  } catch (err) {
    if (err instanceof KnowledgeReviewError) return res.status(err.httpStatus).json({ error: err.message });
    throw err;
  }
}));

router.get('/org-truth/knowledge/sources/:id/original', ...KNOWLEDGE_READ, handle('download the transcript', async (req, res) => {
  const source = await visible(req, res);
  if (!source) return;
  const row = await getSourceWithContent(source.id);
  res.attachment(row.fileName || `${row.displayName}.txt`);
  res.set('Content-Type', row.mimeType || 'text/plain; charset=utf-8');
  res.send(Buffer.from(row.content));
}));

router.put('/org-truth/knowledge/mentions/:id/choose', ...KNOWLEDGE_WRITE,
  decide('link the mention', req => rescored(chooseForMention(req.params.id, req.body ?? {}, actorOf(req)), () => req.params.id)));

router.post('/org-truth/knowledge/sources/:id/rescore', ...KNOWLEDGE_WRITE, handle('score the statements', async (req, res) => {
  const source = await visible(req, res);
  if (source) res.json(await rescoreSource(source.id));
}));

router.put('/org-truth/knowledge/claims/:id', ...KNOWLEDGE_WRITE,
  decide('review the statement', req => reviewClaim(req.params.id, req.body ?? {}, actorOf(req))));

router.put('/org-truth/knowledge/findings/:id', ...KNOWLEDGE_WRITE,
  decide('review the finding', req => reviewFinding(req.params.id, req.body ?? {}, actorOf(req))));

export default router;
