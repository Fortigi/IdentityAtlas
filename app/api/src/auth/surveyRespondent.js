// "Was a survey sent to this signed-in person?"
//
// A person with no Identity Atlas role who is asked to answer a survey (the
// owner named them as responsible, say) may sign in to answer it — and reach
// nothing else (middleware/contextOwnerMode.js, auth/contextOwnerScope.js).
// Who they are in our data comes from auth/resolveMe.js; a survey is theirs as
// contexts/surveys/store.js reads it (their account, their person, or another
// account of their person). A withdrawn survey does not count.

import * as db from '../db/connection.js';
import { isMissingSchema } from '../db/schemaErrors.js';
import { resolveMe } from './resolveMe.js';
import { hasSurvey } from '../contexts/surveys/store.js';

export async function isSurveyRespondent(user, deps = {}) {
  const me = await (deps.resolveMe ?? resolveMe)(user);
  if (!me?.principal?.id) return false;
  try {
    return await hasSurvey(deps.db ?? db, me.principal.id, me.identity?.id ?? null);
  } catch (err) {
    // Before migration 102 nobody has been sent a survey.
    if (isMissingSchema(err)) return false;
    throw err;
  }
}
