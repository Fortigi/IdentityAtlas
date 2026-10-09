// Organisation truth — link the entities of one run to the system truth
// (owned by workstream T2). Called by the import run (T1) once the entities
// and relations of that run are written, inside the same background job.
//
// Contract:
//   linkRun({ runId, profile, log }) → { linked, proposed, ambiguous, none }
//
// `profile` is the normalised profile row ({ recipe, linkRules }). The function
// reads the run's entities, scores every candidate per link rule, writes
// OrgLinks (status 'accepted' at or above the rule's threshold, 'proposed'
// below it for the review queue), never touches a link with an analystOverride,
// and returns the counts the run stores in its stats.
export async function linkRun({ runId }) {
  return { runId, linked: 0, proposed: 0, ambiguous: 0, none: 0, notBuilt: true };
}
