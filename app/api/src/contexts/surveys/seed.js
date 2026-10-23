// Survey templates — add the built-in templates (seedTemplates.js) at startup.
// Each is added once, by key: a template that exists — changed by an analyst,
// or archived — is never touched again. Idempotent; called from bootstrap.js.

import * as defaultDb from '../../db/connection.js';
import { checkDefinition } from './definition.js';
import { SEED_TEMPLATES } from './seedTemplates.js';
import { createTemplate } from './service.js';
import * as store from './store.js';

/** Add every seed template whose key is not there yet. Returns the keys added. */
export async function seedSurveyTemplates(deps = {}) {
  const db = deps.db ?? defaultDb;
  const added = [];
  for (const t of SEED_TEMPLATES) {
    if (await store.keyExists(db, t.key)) continue;
    const errors = checkDefinition(t.definition);
    if (errors.length) throw new Error(`Seed survey template ${t.key} is invalid: ${errors[0].path} ${errors[0].message}`);
    await createTemplate({ ...t, builtIn: true }, 'system', { db });
    added.push(t.key);
  }
  if (added.length) console.log(`Survey templates: added ${added.join(', ')}`);
  return added;
}
