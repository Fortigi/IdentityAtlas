// Survey templates — the questions an analyst asks about a context, sent to a
// person and answered as claims. Design: docs/architecture/survey-templates.md.
//
// Templates (data.write.contexts):
//   GET    /api/surveys/templates?contextId=&includeArchived=   all, or those that may be sent about a context
//   GET    /api/surveys/templates/:id                           one, with its definition and versions
//   POST   /api/surveys/templates                               a new template
//   PUT    /api/surveys/templates/:id                           change it (changed questions = a new version; archived: true|false)
//   POST   /api/surveys/templates/validate                      { definition } → { errors } (the editor)
//
// Requests:
//   POST   /api/contexts/:id/surveys            send (data.write.contexts)
//   GET    /api/contexts/:id/surveys            the requests about a context (data.write.contexts)
//   DELETE /api/surveys/requests/:id            withdraw an unanswered one (data.write.contexts)
//   GET    /api/surveys/mine                    the surveys sent to the signed-in person
//   GET    /api/surveys/requests/:id            the form: questions, rows, answers so far
//   PUT    /api/surveys/requests/:id/answers    save a draft
//   POST   /api/surveys/requests/:id/submit     submit: the answers become an interview and its claims
//
// The last three serve the recipient and an analyst (on the recipient's behalf);
// the service decides which caller may (contexts/surveys/service.js).

import { Router } from 'express';
import * as db from '../db/connection.js';
import { useSql, writeContexts } from './contexts/shared.js';
import { canWriteContexts } from './contexts/interviews.js';
import { userOf } from '../lib/userOf.js';
import { resolveMe } from '../auth/resolveMe.js';
import { checkDefinition } from '../contexts/surveys/definition.js';
import * as surveys from '../contexts/surveys/service.js';

const router = Router();
const deps = () => ({ db });

export function sendFailure(res, err, label) {
  if (err instanceof surveys.SurveyError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  console.error(`${label} failed:`, err?.message);
  return res.status(500).json({ error: `${label} failed` });
}

const requireSql = (req, res, next) => (useSql ? next() : res.status(503).json({ error: 'SQL not configured' }));

/** The caller of a respondent route: who they are in our data, and whether they are an analyst. */
export async function callerOf(req) {
  return { me: req.readToken ? null : await resolveMe(req.user), canWrite: canWriteContexts(req), user: userOf(req) };
}

// Each handler: run `fn`, answer with its result (or `status`), or with the failure.
const handle = (label, fn, status = 200) => async (req, res) => {
  try {
    const out = await fn(req);
    if (out === undefined) return res.status(204).end();
    return res.status(status).json(out);
  } catch (err) {
    return sendFailure(res, err, label);
  }
};

// ─── Templates ───────────────────────────────────────────────────────
router.post('/surveys/templates/validate', writeContexts, (req, res) => {
  res.json({ errors: checkDefinition(req.body?.definition) });
});

router.get('/surveys/templates', writeContexts, requireSql, handle('Listing survey templates', async (req) => ({
  data: await surveys.listTemplates({ contextId: req.query.contextId || null, includeArchived: req.query.includeArchived === 'true' }, deps()),
})));

router.get('/surveys/templates/:id', writeContexts, requireSql,
  handle('Reading the survey template', req => surveys.getTemplate(req.params.id, deps())));

router.post('/surveys/templates', writeContexts, requireSql,
  handle('Creating the survey template', req => surveys.createTemplate(req.body || {}, userOf(req), deps()), 201));

router.put('/surveys/templates/:id', writeContexts, requireSql,
  handle('Saving the survey template', req => surveys.updateTemplate(req.params.id, req.body || {}, userOf(req), deps())));

// ─── Requests ────────────────────────────────────────────────────────
router.post('/contexts/:id/surveys', writeContexts, requireSql,
  handle('Sending the survey', req => surveys.sendSurvey(req.params.id, req.body || {}, userOf(req), deps()), 201));

router.get('/contexts/:id/surveys', writeContexts, requireSql,
  handle('Listing surveys', async req => ({ data: await surveys.contextRequests(req.params.id, deps()) })));

router.delete('/surveys/requests/:id', writeContexts, requireSql,
  handle('Withdrawing the survey', req => surveys.cancelSurvey(req.params.id, deps())));

router.get('/surveys/mine', requireSql,
  handle('Listing your surveys', async req => surveys.mySurveys((await callerOf(req)).me, deps())));

router.get('/surveys/requests/:id', requireSql,
  handle('Opening the survey', async req => surveys.openSurvey(req.params.id, await callerOf(req), deps())));

router.put('/surveys/requests/:id/answers', requireSql,
  handle('Saving the answers', async req => surveys.saveDraft(req.params.id, req.body?.answers, await callerOf(req), deps())));

router.post('/surveys/requests/:id/submit', requireSql,
  handle('Submitting the survey', async req => surveys.submitSurvey(req.params.id, req.body || {}, await callerOf(req), deps())));

export default router;
