// Doing a survey in place — "Do survey" on a unit's or application's page.
// Nothing is sent: the request is made and opened at once, and the form is
// answered through the ordinary survey routes (routes/surveys.js).
//
//   GET  /api/contexts/:id/surveys/start   { allowed, pickRespondent, respondent, templates }
//   POST /api/contexts/:id/surveys/start   { templateId, principalId? } → 201 { id, resumed, recipientName, onBehalf }
//
// Open to every signed-in caller; the service decides (contexts/surveys/start.js):
// an analyst for anyone, a holder of a role on the context for themselves only.
// A context owner reaches these through auth/contextOwnerScope.js.
// Design: docs/architecture/survey-templates.md → "Doing a survey in place".

import { Router } from 'express';
import * as db from '../db/connection.js';
import { useSql } from './contexts/shared.js';
import { callerOf, sendFailure } from './surveys.js';
import * as start from '../contexts/surveys/start.js';

const router = Router();
const deps = () => ({ db });
const requireSql = (req, res, next) => (useSql ? next() : res.status(503).json({ error: 'SQL not configured' }));

router.get('/contexts/:id/surveys/start', requireSql, async (req, res) => {
  try {
    res.json(await start.startOptions(req.params.id, await callerOf(req), deps()));
  } catch (err) {
    sendFailure(res, err, 'Reading the survey options');
  }
});

router.post('/contexts/:id/surveys/start', requireSql, async (req, res) => {
  try {
    res.status(201).json(await start.startSurvey(req.params.id, req.body || {}, await callerOf(req), deps()));
  } catch (err) {
    sendFailure(res, err, 'Starting the survey');
  }
});

export default router;
