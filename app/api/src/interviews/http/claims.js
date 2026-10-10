// Identity Atlas Interviews — claims and their review.
//
//   POST /api/v1/interviews/:id/statements                             a claim + its evidence
//   POST /api/v1/interviews/:id/statements/:statementId/revisions      the next version of a claim
//   POST /api/v1/interviews/:id/proposals                              propose a statement version
//   POST /api/v1/interviews/:id/proposals/:proposalId/reviews          approve / reject / defer
//
// No route here writes outside the Interview* tables. An approval is a recorded
// decision; the response says `promoted: false` so no client mistakes it for a change
// to Identity Atlas's canonical data.

import { Router } from 'express';
import { query, tx } from '../../db/connection.js';
import { isUuid, validateProposal, validateReview, validateStatement } from '../contracts.js';
import { excerptToStore } from '../evidence.js';
import { checkReview, reviewState } from '../review.js';
import { actorNameOf } from '../store.js';
import {
  appendReview, createProposal, foreignMentionIds, insertStatement, loadProposalForReview, loadStatement,
} from '../claims.js';
import { WRITE_GATE, fail, ownedInterview } from './gates.js';

const router = Router();

/**
 * Validates a statement body against this interview: its shape, its mentions, and what
 * the interview's storage policy lets the server keep of each excerpt.
 * @returns {Promise<{ error: string } | { value: object, excerptTexts: (string|null)[] }>}
 */
async function checkStatement(req) {
  const v = validateStatement(req.body);
  if (!v.ok) return { error: v.error };
  const excerptTexts = [];
  for (const e of v.value.evidence) {
    const stored = excerptToStore(e, req.interview.storagePolicy);
    if (stored.error) return { error: stored.error };
    excerptTexts.push(stored.excerptText);
  }
  const foreign = await foreignMentionIds(query, req.interview.id, v.value);
  if (foreign.length) return { error: 'The statement refers to a mention that is not part of this interview' };
  return { value: v.value, excerptTexts };
}

router.post('/v1/interviews/:id/statements', WRITE_GATE, ownedInterview(), async (req, res) => {
  try {
    const checked = await checkStatement(req);
    if (checked.error) return res.status(400).json({ error: checked.error });
    res.status(201).json(await insertStatement(tx, req.interview.id, checked.value, req.owner, checked.excerptTexts));
  } catch (err) {
    fail(res, 'statement', err);
  }
});

router.post('/v1/interviews/:id/statements/:statementId/revisions', WRITE_GATE, ownedInterview(), async (req, res) => {
  if (!isUuid(req.params.statementId)) return res.status(404).json({ error: 'Statement not found' });
  try {
    const previous = await loadStatement(query, req.interview.id, req.params.statementId);
    if (!previous) return res.status(404).json({ error: 'Statement not found' });
    // Revise the latest version only, so two edits cannot fork one claim.
    if (previous.version !== previous.latestVersion) {
      return res.status(409).json({ error: `Version ${previous.latestVersion} is the latest; revise that one` });
    }
    const checked = await checkStatement(req);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const lineage = { lineageId: previous.lineageId, version: previous.version + 1 };
    res.status(201).json(await insertStatement(tx, req.interview.id, checked.value, req.owner, checked.excerptTexts, lineage));
  } catch (err) {
    fail(res, 'revision', err);
  }
});

router.post('/v1/interviews/:id/proposals', WRITE_GATE, ownedInterview(), async (req, res) => {
  const v = validateProposal(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const statement = await loadStatement(query, req.interview.id, v.value.statementId);
    if (!statement) return res.status(400).json({ error: 'statementId is not a statement of this interview' });
    res.status(201).json({ ...(await createProposal(tx, req.interview.id, v.value, req.owner)), statementVersion: statement.version });
  } catch (err) {
    fail(res, 'proposal', err);
  }
});

router.post('/v1/interviews/:id/proposals/:proposalId/reviews', WRITE_GATE, ownedInterview(), async (req, res) => {
  if (!isUuid(req.params.proposalId)) return res.status(404).json({ error: 'Proposal not found' });
  const v = validateReview(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const state = await loadProposalForReview(query, req.interview.id, req.params.proposalId);
    if (!state) return res.status(404).json({ error: 'Proposal not found' });
    const refused = checkReview(state, v.value);
    if (refused) return res.status(409).json({ error: refused });
    const decision = await appendReview(tx, req.interview.id, state.id, v.value, req.owner, actorNameOf(req));
    res.status(201).json({ decision, reviewState: reviewState(v.value.action), promoted: false });
  } catch (err) {
    fail(res, 'review', err);
  }
});

export default router;
