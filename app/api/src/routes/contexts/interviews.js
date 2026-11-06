// Context interviews — a source about a unit or an application (an interview
// transcript, a file, a list, pasted text: "Add information"), and the claims it
// makes. The table and the paths keep the word "interview" for any such source.
// Design: docs/architecture/context-interviews.md.
//
//   POST   /api/contexts/:id/interviews                         multipart file or text, who it is from (optional) + date
//   GET    /api/contexts/:id/interviews                         the context's interviews (no transcript)
//   GET    /api/contexts/:id/interviews/:interviewId            one, with its transcript and its quotes' offsets
//   POST   /api/contexts/:id/interviews/:interviewId/extract    read it again with the model
//   POST   /api/contexts/:id/interviews/:interviewId/claims     an analyst's own claim
//   DELETE /api/contexts/:id/interviews/:interviewId            the interview and its claims
//   GET    /api/contexts/:id/claims?status=…                    the claims (a reader: confirmed only)
//   POST   /api/contexts/:id/claims/reject                      reject the proposed claims of a kind / relevance tier
//   PATCH  /api/contexts/claims/:claimId                        confirm / edit / reject
//   POST   /api/contexts/claims/:claimId/undo                   back to proposed (a decision that changed only the claim)
//   GET    /api/contexts/claims/mentions?principalId=|identityId=  where a person is mentioned
//
// Writes, and everything that shows a transcript or an undecided claim, need
// data.write.contexts. The GET of claims (and the People overview, read.js) serve every reader, answering one
// without that permission with decided-and-confirmed claims only.
// Mounted BEFORE the read and crud routers: "/contexts/claims" would otherwise
// be taken for "/contexts/:id".
// Every route answers 404 while the `orgKnowledge` feature is off (featureFlags.js).

import { Router } from 'express';
import multer from 'multer';
import * as db from '../../db/connection.js';
import { requireFeature } from '../../featureFlags.js';
import { useSql, UUID_RE, writeContexts, WRITE_CONTEXT_PERMISSIONS } from './shared.js';
import { isAuthEnabled } from '../../config/authConfig.js';
import { userOf } from '../../lib/userOf.js';
import { TranscriptError } from '../../contexts/interviews/transcript.js';
import { CLAIM_STATUSES, READER_STATUSES, visibleClaimStatuses } from '../../contexts/interviews/claims.js';
import {
  createInterview, retryExtraction, addManualClaim, claimsOf, rejectMany, interviewWithTranscript, InterviewError,
} from '../../contexts/interviews/service.js';
import { decideClaim, undoClaim, ClaimError } from '../../contexts/interviews/decide.js';
import * as store from '../../contexts/interviews/store.js';

const router = Router();

// The paths this router serves; while organisation knowledge is off they do not exist.
export const ORG_KNOWLEDGE_PATHS = Object.freeze([
  '/contexts/claims', '/contexts/:id/interviews', '/contexts/:id/claims',
]);
router.use(ORG_KNOWLEDGE_PATHS, requireFeature('orgKnowledge'));

// A transcript is text; a .docx with a few pictures, or a long list, is the large case.
export const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;
const ALLOWED = /\.(txt|text|md|docx|vtt|srt|csv|xlsx)$/i;
// What a reader without write access sees (contexts/interviews/claims.js).
export { READER_STATUSES };

const upload = multer({
  storage: multer.memoryStorage(),
  // fieldSize: pasted text arrives as a form field (multer's default caps it at 1 MB).
  limits: { fileSize: MAX_TRANSCRIPT_BYTES, fieldSize: MAX_TRANSCRIPT_BYTES, files: 1 },
  fileFilter: (req, file, cb) => (ALLOWED.test(file.originalname)
    ? cb(null, true)
    : cb(new TranscriptError('Add a file as .txt, .md, .docx, .vtt, .srt, .csv or .xlsx.'))),
});

// The writeContexts question asked inside a handler that serves every reader.
// Open mode (auth off) counts as a writer, as the gate does; a read token or a
// context owner (auth/contextOwner.js) never does.
export function canWriteContexts(req) {
  if (!isAuthEnabled()) return true;
  if (req.readToken || req.user?.contextOwner) return false;
  const perms = req.user?.permissions;
  const has = (p) => (perms instanceof Set ? perms.has(p) : Array.isArray(perms) && perms.includes(p));
  return has('*') || WRITE_CONTEXT_PERMISSIONS.some(has);
}

/** The claim statuses this request may see: proposed ones only for a writer. */
export const claimStatusesFor = (req) => visibleClaimStatuses(canWriteContexts(req));

/** The statuses a caller asked for (?status=a,b), narrowed to what they may see. Pure. */
export function statusesFor(query, canWrite) {
  const asked = String(query ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const valid = asked.length ? asked.filter(s => CLAIM_STATUSES.includes(s)) : [...CLAIM_STATUSES];
  return canWrite ? valid : valid.filter(s => READER_STATUSES.includes(s));
}

export function sendFailure(res, err, label) {
  if (err instanceof TranscriptError) return res.status(400).json({ error: err.message });
  if (err instanceof InterviewError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ClaimError) return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  console.error(`${label} failed:`, err?.message);
  return res.status(500).json({ error: `${label} failed` });
}

function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `The file is larger than ${MAX_TRANSCRIPT_BYTES / (1024 * 1024)} MB.` });
    if (err) return res.status(400).json({ error: err instanceof TranscriptError ? err.message : 'The file could not be received.' });
    const pasted = typeof req.body?.text === 'string' && req.body.text.trim() !== '';
    if (!req.file && !pasted) return res.status(400).json({ error: 'Add a file (field "file") or paste the text (field "text").' });
    return next();
  });
}

const requireSql = (req, res, next) => (useSql ? next() : res.status(503).json({ error: 'SQL not configured' }));

function validIds(...names) {
  return (req, res, next) => (names.every(n => UUID_RE.test(req.params[n])) ? next() : res.status(400).json({ error: 'Invalid ID format' }));
}

// ─── Claims across contexts (before /contexts/:id/…) ─────────────────
router.get('/contexts/claims/mentions', requireSql, async (req, res) => {
  const col = ['principalId', 'identityId'].find(k => req.query[k]);
  const id = col ? String(req.query[col]) : '';
  if (!col || !UUID_RE.test(id)) return res.status(400).json({ error: 'Give principalId or identityId (a uuid)' });
  try {
    const statuses = claimStatusesFor(req);
    res.json({ data: await store.mentionsOf(db, col, id.toLowerCase(), statuses) });
  } catch (err) {
    sendFailure(res, err, 'Listing interview mentions');
  }
});

router.patch('/contexts/claims/:claimId', writeContexts, requireSql, validIds('claimId'), async (req, res) => {
  try {
    res.json(await decideClaim(db, req.params.claimId, req.body || {}, userOf(req)));
  } catch (err) {
    sendFailure(res, err, 'Deciding the claim');
  }
});

// Reopens the claim (and its contradiction); a person it marked former is a
// current member again (contexts/interviews/memberOverrides.js).
router.post('/contexts/claims/:claimId/undo', writeContexts, requireSql, validIds('claimId'), async (req, res) => {
  try {
    res.json(await undoClaim(db, req.params.claimId));
  } catch (err) {
    sendFailure(res, err, 'Undoing the decision');
  }
});

// ─── Interviews of one context ───────────────────────────────────────
router.post('/contexts/:id/interviews', writeContexts, requireSql, validIds('id'), receiveFile, async (req, res) => {
  try {
    res.status(201).json(await createInterview({ contextId: req.params.id, file: req.file, body: req.body || {}, user: userOf(req) }, { db }));
  } catch (err) {
    sendFailure(res, err, 'Uploading the interview');
  }
});

router.get('/contexts/:id/interviews', writeContexts, requireSql, validIds('id'), async (req, res) => {
  try {
    res.json({ data: await store.listInterviews(db, req.params.id) });
  } catch (err) {
    sendFailure(res, err, 'Listing interviews');
  }
});

router.get('/contexts/:id/interviews/:interviewId', writeContexts, requireSql, validIds('id', 'interviewId'), async (req, res) => {
  try {
    res.json(await interviewWithTranscript(req.params.id, req.params.interviewId, { db }));
  } catch (err) {
    sendFailure(res, err, 'Reading the interview');
  }
});

router.post('/contexts/:id/interviews/:interviewId/extract', writeContexts, requireSql, validIds('id', 'interviewId'), async (req, res) => {
  try {
    res.status(202).json(await retryExtraction(req.params.id, req.params.interviewId, { db }));
  } catch (err) {
    sendFailure(res, err, 'Starting the extraction');
  }
});

router.post('/contexts/:id/interviews/:interviewId/claims', writeContexts, requireSql, validIds('id', 'interviewId'), async (req, res) => {
  try {
    res.status(201).json(await addManualClaim(req.params.id, req.params.interviewId, req.body || {}, { db }));
  } catch (err) {
    sendFailure(res, err, 'Adding the claim');
  }
});

// Removes the interview and every claim it made (cascade). What confirmed
// claims already changed — a description, an attribute, a role — stays; a
// role only loses its link to the claim (sourceClaimId → NULL).
router.delete('/contexts/:id/interviews/:interviewId', writeContexts, requireSql, validIds('id', 'interviewId'), async (req, res) => {
  try {
    const n = await store.deleteInterview(db, req.params.id, req.params.interviewId);
    if (!n) return res.status(404).json({ error: 'Interview not found' });
    res.status(204).end();
  } catch (err) {
    sendFailure(res, err, 'Deleting the interview');
  }
});

router.get('/contexts/:id/claims', requireSql, validIds('id'), async (req, res) => {
  try {
    res.json(await claimsOf(req.params.id, { statuses: statusesFor(req.query.status, canWriteContexts(req)) }, { db }));
  } catch (err) {
    sendFailure(res, err, 'Listing claims');
  }
});

router.post('/contexts/:id/claims/reject', writeContexts, requireSql, validIds('id'), async (req, res) => {
  try {
    res.json(await rejectMany(req.params.id, req.body || {}, userOf(req), { db }));
  } catch (err) {
    sendFailure(res, err, 'Rejecting the claims');
  }
});

export default router;
