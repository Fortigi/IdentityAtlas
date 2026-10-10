// Identity Atlas Interviews — read routes used before and during an interview.
//
//   GET /api/v1/interviews/entities/search   a mentioned name → ranked candidates + what the search may say
//   GET /api/v1/interviews/context           subject + team scope → members and what they hold
//
// The search never logs the query: the words are names of people.

import { Router } from 'express';
import { query } from '../../db/connection.js';
import { isUuid } from '../contracts.js';
import { classifyCandidates } from '../resolution.js';
import { MAX_QUERY, MIN_QUERY, SEARCH_KINDS, searchEntities } from '../search.js';
import { readInterviewContext } from '../contextRead.js';
import { READ_GATE, fail, searchLimiter } from './gates.js';

const router = Router();

/** @returns {{ error: string } | { kind: string, text: string, scopeContextId: string|null }} */
export function parseSearch(q) {
  const text = typeof q.q === 'string' ? q.q.trim() : '';
  if (text.length < MIN_QUERY || text.length > MAX_QUERY) return { error: `q must be ${MIN_QUERY} to ${MAX_QUERY} characters` };
  const kind = q.kind ?? 'identity';
  if (!SEARCH_KINDS.includes(kind)) return { error: `kind must be one of: ${SEARCH_KINDS.join(', ')}` };
  const scope = q.scopeContextId ?? null;
  if (scope !== null && !isUuid(scope)) return { error: 'scopeContextId must be a UUID' };
  return { kind, text, scopeContextId: scope };
}

router.get('/v1/interviews/entities/search', READ_GATE, searchLimiter, async (req, res) => {
  const parsed = parseSearch(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const { candidates, truncated } = await searchEntities(query, parsed);
    // The search's own verdict, for the client to show — a suggestion at most, never a link.
    const outcome = classifyCandidates(candidates);
    res.json({
      kind: parsed.kind,
      scoped: parsed.scopeContextId !== null,
      candidates,
      truncated,
      outcome: { state: outcome.state, entityId: outcome.entityId, reason: outcome.reason },
    });
  } catch (err) {
    fail(res, 'search', err);
  }
});

router.get('/v1/interviews/context', READ_GATE, async (req, res) => {
  const subjectIdentityId = req.query.subjectIdentityId ?? null;
  const scopeContextId = req.query.scopeContextId ?? null;
  if (!subjectIdentityId && !scopeContextId) return res.status(400).json({ error: 'Give subjectIdentityId, scopeContextId or both' });
  for (const [name, v] of [['subjectIdentityId', subjectIdentityId], ['scopeContextId', scopeContextId]]) {
    if (v !== null && !isUuid(v)) return res.status(400).json({ error: `${name} must be a UUID` });
  }
  try {
    const out = await readInterviewContext(query, { subjectIdentityId, scopeContextId });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out.body);
  } catch (err) {
    fail(res, 'context', err);
  }
});

export default router;
