// Organisation truth — the steps of an ACTIVITY import run (runImport.js calls
// this once the source parsed and fits the recipe).
//
//   activitySteps({ run, source, profile, table, step, log }) → stats
//
// apply (30) parse every row into a fact (activityParse.js)
// write (50) keys + facts in one transaction (activityWrite.js): full replaces the
//            profile name's activities, delta appends
// link  (70) (re)decide the keys that are not settled yet (activityResolve.js)
// No projection: activities are no contexts.
//
// stats: { rows, activities, keys: { actor: { total, accepted, proposed, unmatched }, subject: {…} },
//          skipped, replaced, issues: { count, samples } }
//   keys     counts over the distinct values THIS file names
//   skipped  rows that could not become a fact; issues.samples says why (first ISSUE_SAMPLE_LIMIT)
//   replaced activities of earlier runs a full run deleted
import { tx } from '../../db/connection.js';
import { applyActivity } from './activityParse.js';
import { writeActivities } from './activityWrite.js';
import { resolveKeys, keyStats } from './activityResolve.js';

export const ISSUE_SAMPLE_LIMIT = 50;

export async function activitySteps({ run, source, profile, table, step, log }) {
  await step({ step: 'apply', pct: 30 });
  const { facts, skipped } = applyActivity(table.rows, profile.recipe);

  await step({ step: 'write', pct: 50 });
  const written = await tx(client => writeActivities({ client, run, source, profile, facts }));

  await step({ step: 'link', pct: 70 });
  const resolved = await resolveKeys({ profileName: profile.name, recipe: profile.recipe });
  log(`activity keys decided: ${resolved.actor} actors, ${resolved.subject} subjects`);

  return {
    rows: table.rows.length,
    activities: written.inserted,
    keys: await keyStats(written.keyIds),
    skipped: skipped.length,
    replaced: written.deleted,
    issues: { count: skipped.length, samples: skipped.slice(0, ISSUE_SAMPLE_LIMIT) },
  };
}
