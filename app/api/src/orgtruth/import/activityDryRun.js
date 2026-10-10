// Organisation truth — the dry-run of an ACTIVITY recipe: what an import would
// write, nothing written.
//
//   activityDryRun({ table, recipe, mode, profileName }) → report
//
// report:
//   { template: 'activity', rows, columns, activities, skipped,
//     sample:   the first SAMPLE_LIMIT parsed rows: [{ actor, subject, occurredOn, periodEnd, measure, unit }] (raw values)
//     keys:     { actor: { total, accepted, proposed, unmatched }, subject: {…} } over the
//               distinct values of the file: a value the profile name already settled (an
//               analyst decision, or accepted / rejected before) counts as it stands, every
//               other value is decided now exactly as the run would (activityResolve.js)
//     wouldReplace: full mode with a known profile name: the activities the run deletes first
//     issues, issueCount: the skipped rows and why }
import { query, queryOne } from '../../db/connection.js';
import { profileColumns } from './profileColumns.js';
import { applyActivity, distinctKeys } from './activityParse.js';
import { decideKey, loadRoleIndexes } from './activityResolve.js';
import { ROLES } from './activityWrite.js';

export const SAMPLE_LIMIT = 10;
export const ISSUE_REPORT_LIMIT = 500;

const SETTLED_SQL = `
  SELECT "role", "rawValue", "status" FROM "OrgActivityKeys"
   WHERE "profileName" = $1 AND ("analystOverride" OR "status" IN ('accepted', 'rejected'))`;

async function loadSettled(profileName) {
  if (!profileName) return new Map();
  const r = await query(SETTLED_SQL, [profileName]);
  return new Map(r.rows.map(k => [`${k.role}\u0000${k.rawValue}`, k.status]));
}

async function roleStats(recipe, role, values, settled) {
  const stats = { total: values.length, accepted: 0, proposed: 0, unmatched: 0 };
  if (values.length === 0) return stats;
  const open = values.filter(v => !settled.has(`${role}\u0000${v}`));
  const indexes = open.length > 0 ? await loadRoleIndexes(recipe, role) : [];
  for (const v of values) {
    const status = settled.get(`${role}\u0000${v}`) ?? decideKey(v, indexes).status;
    stats[status === 'rejected' ? 'unmatched' : status] += 1;
  }
  return stats;
}

async function countExisting(profileName) {
  const r = await queryOne(`SELECT count(*)::int AS n FROM "OrgActivities" WHERE "profileName" = $1`, [profileName]);
  return r?.n ?? 0;
}

export async function activityDryRun({ table, recipe, mode, profileName = null }) {
  const { facts, skipped } = applyActivity(table.rows, recipe);
  const distinct = distinctKeys(facts);
  const settled = await loadSettled(profileName);
  const keys = {};
  for (const role of ROLES) keys[role] = await roleStats(recipe, role, [...distinct[role].keys()], settled);
  return {
    template: 'activity',
    rows: table.rows.length,
    columns: profileColumns(table.columns, table.rows),
    activities: facts.length,
    skipped: skipped.length,
    sample: facts.slice(0, SAMPLE_LIMIT).map(({ actor, subject, occurredOn, periodEnd, measure, unit }) => ({ actor, subject, occurredOn, periodEnd, measure, unit })),
    keys,
    wouldReplace: mode === 'full' && profileName ? await countExisting(profileName) : 0,
    issues: skipped.slice(0, ISSUE_REPORT_LIMIT),
    issueCount: skipped.length,
  };
}
