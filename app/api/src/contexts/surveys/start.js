// Doing a survey in place — "Do survey" on a context's page (routes/surveyStart.js).
//
//   startOptions(contextId, caller)        may this caller do one here, which templates, for whom
//   startSurvey(contextId, body, caller)   make the request — not sent, opened at once — and hand back its id
//
// Nobody is notified: the request is opened as it is made (store.IN_PLACE), so
// it is not in the respondent's "My surveys" and gives them no sign-in. It is
// then answered through the ordinary form and submit (service.js), so the
// claims, the review and the transcript are a sent survey's. Who answers:
//
//   an analyst (canWrite)        any account; the signed-in one by default, when
//                                there is one (auth off: none, so one must be named)
//   someone holding a role here  themselves only — Accountable or Responsible
//   anyone else                  not offered
//
// The answers are the respondent's; filled in by anyone else they are recorded
// on the respondent's behalf, by the submit's own rule (onBehalf = not the
// recipient). Design: docs/architecture/survey-templates.md → "Doing a survey in place".

import * as defaultDb from '../../db/connection.js';
import { SurveyError, surveyTarget, uuid } from './service.js';
import * as store from './store.js';

const defaults = (deps = {}) => ({ db: defaultDb, ...deps });
const meOf = (caller) => (caller?.me?.principal?.id ? caller.me : null);
const lower = (id) => String(id).toLowerCase();

/** Whether the caller may do a survey about this context: { allowed, pick (anyone, or only themselves), me }. */
export async function mayStart(db, contextId, caller) {
  const me = meOf(caller);
  if (caller?.canWrite) return { allowed: true, pick: true, me };
  if (!me) return { allowed: false, pick: false, me: null };
  const holds = await store.holdsRole(db, contextId, me.principal.id, me.identity?.id ?? null);
  return { allowed: holds, pick: false, me };
}

/** The account that answers: the one named, else the caller's own; someone not an analyst names only themselves. Pure. */
export function respondentId(given, { pick, me }) {
  const mine = me ? lower(me.principal.id) : null;
  const id = given ? uuid(given, 'principalId') : mine;
  if (!id) throw new SurveyError(400, 'Say who is answering (principalId).');
  if (!pick && id !== mine) throw new SurveyError(403, 'You can do this survey for yourself only.');
  return id;
}

const respondentOf = (me) => ({ principalId: lower(me.principal.id), displayName: me.principal.displayName ?? null, email: me.principal.email ?? null });

/** What the Do survey dialog offers here. Not allowed: no templates, nobody. */
export async function startOptions(contextId, caller, deps) {
  const { db } = defaults(deps);
  const id = uuid(contextId, 'id');
  if (!(await store.getContext(db, id))) throw new SurveyError(404, 'Context not found');
  const may = await mayStart(db, id, caller);
  if (!may.allowed) return { allowed: false, pickRespondent: false, respondent: null, templates: [] };
  const templates = (await store.applicableTemplates(db, id)).map(t => ({ id: t.id, name: t.name }));
  return { allowed: true, pickRespondent: may.pick, respondent: may.me ? respondentOf(may.me) : null, templates };
}

/**
 * Start a survey in place: a request for the respondent that is not sent. One
 * started and left for the same context, template and account is picked up
 * again rather than doubled. Answers { id, resumed, recipientName, onBehalf }.
 */
export async function startSurvey(contextId, body = {}, caller, deps) {
  const { db } = defaults(deps);
  const { ctx, template } = await surveyTarget(db, contextId, uuid(body.templateId, 'templateId'));
  const may = await mayStart(db, ctx.id, caller);
  if (!may.allowed) throw new SurveyError(403, 'Only an analyst, or someone who holds a role on it, can do a survey about this.');
  const principalId = respondentId(body.principalId, may);
  const recipientName = await store.personName(db, 'principalId', principalId);
  if (!recipientName) throw new SurveyError(404, 'That account was not found.');

  const left = await store.openInPlaceRequest(db, { contextId: ctx.id, templateId: template.id, principalId });
  const id = left?.id ?? (await store.insertRequests(db, [{
    templateId: template.id, templateVersion: template.currentVersion, contextId: ctx.id,
    principalId, identityId: null, recipientName, language: null, message: null, dueAt: null,
    sentBy: caller.user ?? null, inPlace: true,
  }]))[0].id;
  // The submit's own rule, asked now so the dialog can say it.
  const own = may.me ? await store.isRecipient(db, id, may.me.principal.id, may.me.identity?.id ?? null) : false;
  return { id, resumed: !!left, recipientName, onBehalf: !own };
}
